/** Rootless Podman + gVisor runtime: one confined container per account, reached only through a private Unix socket. */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { chmod, chown, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { portsFrom, type InstanceEndpoint, type UserId } from '@public-harness/contracts'
import type { ProvisionerConfig } from './config.ts'
import { startUnixForwarder, type Forwarder } from './forwarder.ts'
import { enforceLimits, LimitsError, networkArgument, type EnforcementProbe } from './limits.ts'
import { clearReady, readReady, waitForReady } from './token-channel.ts'
import { KeyedLock, type CommandRunner } from './system.ts'
import type { UserRecord } from './users.ts'

/** Port the in-container Web CLI binds on its private loopback. */
export const WEB_PORT = 8080
/** Port the in-container sidecar exposes inside the instance's own network namespace. */
export const SIDECAR_PORT = 8081
/** Mount points inside the container. */
export const CONTAINER = { home: '/home/harness', workspace: '/workspace', ctl: '/run/harness-ctl', assets: '/opt/public-harness' } as const

/**
 * The unprivileged user the image runs as (`useradd --uid 10001` in the Containerfile; a test keeps them equal).
 * Rootless Podman would map that uid to a subuid that cannot write the account-owned control directory, so the
 * container is started with exactly `--userns keep-id:uid=10001,gid=10001`, which maps the host account onto it.
 */
export const INSTANCE_USER = { uid: 10001, gid: 10001 } as const
/** The only `--userns` value an instance may be started with. */
export const INSTANCE_USERNS = `keep-id:uid=${INSTANCE_USER.uid},gid=${INSTANCE_USER.gid}`

/** The model quota proxy as seen by the provisioner (its control channel is private to the provisioner). */
export interface QuotaBridge {
  healthy(): Promise<boolean>
  /** Open the instance-bound model-proxy listener and return its host loopback port. */
  open(userId: UserId, instanceId: string): Promise<{ readonly port: number }>
  issue(userId: UserId, instanceId: string): Promise<{ readonly token: string; readonly expiresAt: number }>
  close(userId: UserId): Promise<void>
}

/** Ordered failures a start can report; messages never include paths, argv, or token material. */
export class RuntimeStartError extends Error {
  override readonly name = 'RuntimeStartError'
  constructor(readonly reason: 'gvisor-unavailable' | 'limits' | 'quota-unavailable' | 'start-failed' | 'not-ready' | 'unsafe-argv' | 'no-port' | 'image-unavailable') {
    super(`runtime start refused: ${reason}`)
  }
}

/** The container could not be removed even after SIGKILL; the instance stays recorded until reconcile retries. */
export class RuntimeStopError extends Error {
  override readonly name = 'RuntimeStopError'
  constructor() { super('runtime stop failed: container is stuck') }
}

/** What the container engine says about one instance. `unknown` means the question itself failed. */
export type ContainerState = 'running' | 'stopped' | 'unknown'

/** Container lifecycle operations. */
export interface Runtime {
  start(record: UserRecord): Promise<InstanceEndpoint>
  stop(record: UserRecord): Promise<void>
  launchGrant(record: UserRecord): Promise<string>
  isRunning(record: UserRecord): Promise<boolean>
  /** The real container state, read from the engine rather than from the provisioner's own records. */
  state(record: UserRecord): Promise<ContainerState>
}

/** Collaborators; every one is injectable so no privileged command runs in tests. */
export interface RuntimeDeps {
  readonly config: ProvisionerConfig
  readonly runner: CommandRunner
  readonly quota: QuotaBridge
  readonly probe: EnforcementProbe
  readonly startForwarder?: typeof startUnixForwarder
  readonly healthProbe?: (port: number) => Promise<boolean>
  /** Whether a loopback port can be bound right now (injectable so tests bind nothing). */
  readonly portFree?: (port: number) => Promise<boolean>
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
  readonly chownFile?: (path: string, uid: number, gid: number) => Promise<void>
  /** Credential rotation cadence; must be shorter than the quota credential lifetime. */
  readonly credentialRotateMs?: number
  readonly publicHost: string
  /** Time allowed beyond `stopTimeoutMs` for the engine to answer a stop before it is declared hung (default 10 s). */
  readonly stopGraceMs?: number
  /** Margin after a command's own timeout before the provisioner stops waiting for the runner (default 1 s). */
  readonly deadlineSlackMs?: number
}

/** The exact argv for `podman` (after the executable) that starts one instance. */
export function buildRunArgv(config: ProvisionerConfig, record: UserRecord, sidecarPort: number): string[] {
  const { limits, tools } = config
  const volume = (source: string, target: string, mode: 'rw' | 'ro'): string[] => ['--volume', `${source}:${target}:${mode},Z`]
  const env = (name: string, value: string): string[] => ['--env', `${name}=${value}`]
  return [
    '--runtime', tools.runsc, 'run', '--detach', '--replace', '--name', record.container,
    '--network', networkArgument(limits.network, config.quota.hostAddress), '--userns', INSTANCE_USERNS,
    '--publish', `127.0.0.1:${sidecarPort}:${SIDECAR_PORT}`,
    '--cap-drop', 'all', '--security-opt', 'no-new-privileges', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--pids-limit', String(limits.pids), '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus), '--ulimit', `nofile=${limits.openFiles}:${limits.openFiles}`,
    '--label', 'public-harness=1', '--workdir', CONTAINER.workspace,
    ...volume(record.layout.home, CONTAINER.home, 'rw'), ...volume(record.layout.workspace, CONTAINER.workspace, 'rw'),
    ...volume(record.layout.ctl, CONTAINER.ctl, 'rw'), ...volume(config.paths.runtimeAssets, CONTAINER.assets, 'ro'),
    ...env('HOME', CONTAINER.home), ...env('DSH_HOME', CONTAINER.home), ...env('DSH_AGENTS_HOME', `${CONTAINER.home}/agents`),
    ...env('DSH_TELEMETRY_DISABLED', '1'), ...env('PUBLIC_HARNESS_READY_FILE', `${CONTAINER.ctl}/ready.json`),
    ...env('PUBLIC_HARNESS_WEB_PORT', String(WEB_PORT)), ...env('PUBLIC_HARNESS_SIDECAR_PORT', String(SIDECAR_PORT)),
    ...env('PUBLIC_HARNESS_WEB_PATCH', `${CONTAINER.home}/public-harness-web.patch.yml`),
    config.image, 'node', `${CONTAINER.assets}/container-entry.js`,
  ]
}

const FORBIDDEN_FLAGS = /^--(privileged|cap-add|device|pid|ipc|userns|uts|cgroupns|security-opt=(?!no-new-privileges)|add-host|dns|mount|volumes-from|group-add|env-file|net|network=host|pod)\b/

/** True for `127.0.0.1:<port>:<sidecar port>` with a host port inside the configured sidecar range. */
function publishedInRange(value: string, config: ProvisionerConfig): boolean {
  const match = /^127\.0\.0\.1:(\d{1,5}):(\d{1,5})$/.exec(value)
  if (match === null || Number(match[2]) !== SIDECAR_PORT) return false
  const port = Number(match[1])
  return port >= config.ports.sidecar.min && port <= config.ports.sidecar.max
}

/** Default bind probe. */
function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** Reject an argv that grants more than the fixed design allows. */
export function assertSafeRunArgv(argv: readonly string[], config: ProvisionerConfig, record: UserRecord): void {
  const allowedVolumes = new Set([
    `${record.layout.home}:${CONTAINER.home}:rw,Z`, `${record.layout.workspace}:${CONTAINER.workspace}:rw,Z`,
    `${record.layout.ctl}:${CONTAINER.ctl}:rw,Z`, `${config.paths.runtimeAssets}:${CONTAINER.assets}:ro,Z`])
  const seen = new Set<string>()
  let userns = 0
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--volume') {
      const value = argv[index + 1] ?? ''
      if (!allowedVolumes.has(value) || seen.has(value)) throw new RuntimeStartError('unsafe-argv')
      seen.add(value); index += 1
    } else if (arg === '--userns') {
      // Precise allowlist: one exact value, never host, auto, a bare keep-id, other ids, or an option variant.
      if (argv[index + 1] !== INSTANCE_USERNS || ++userns > 1) throw new RuntimeStartError('unsafe-argv')
      index += 1
    } else if (FORBIDDEN_FLAGS.test(arg)) throw new RuntimeStartError('unsafe-argv')
    else if (arg === '--network' && argv[index + 1] !== networkArgument(config.limits.network, config.quota.hostAddress)) throw new RuntimeStartError('unsafe-argv')
    else if (arg === '--publish' && !publishedInRange(argv[index + 1] ?? '', config)) throw new RuntimeStartError('unsafe-argv')
  }
  if (seen.size !== allowedVolumes.size || userns !== 1) throw new RuntimeStartError('unsafe-argv')
  if (!argv.includes('--read-only') || argv[argv.indexOf('--cap-drop') + 1] !== 'all') throw new RuntimeStartError('unsafe-argv')
}

/** Default readiness probe: any HTTP answer below 500 from the forwarded port. */
export function httpHealthProbe(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 2000, agent: false },
      res => { res.resume(); resolve((res.statusCode ?? 500) < 500) })
    req.once('timeout', () => { req.destroy(); resolve(false) })
    req.once('error', () => resolve(false))
    req.end()
  })
}

function webPatch(config: ProvisionerConfig, publicHost: string, proxyPort: number, modelId: string): string {
  const bundle = (name: string): string => `file://${CONTAINER.assets}/packages/${name}/lib/index.js`
  return `${JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, publicUrl: null, surfaceContext: true, trustedHosts: [publicHost] } },
    { id: 'ui-brand-official', disabled: true },
    { insert: [{ id: 'public-harness-web-token', name: bundle('web-token') },
      { id: 'public-harness-quota-provider', name: bundle('quota-provider'), config: {
        proxyBaseUrl: `http://${config.quota.hostAddress}:${proxyPort}/v1`, credentialFile: `${CONTAINER.home}/quota-credential.json`,
        provider: 'platform', modelId, modelName: 'Platform model', contextWindow: 200000, maxTokens: 8192 } },
      { id: 'public-harness-ui', name: bundle('ui') }] },
  ])}\n`
}

/** Create the runtime. */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const { config, runner } = deps
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const chownFile = deps.chownFile ?? chown
  const forward = deps.startForwarder ?? startUnixForwarder
  const probeHealth = deps.healthProbe ?? httpHealthProbe
  const rotateMs = deps.credentialRotateMs ?? 480_000
  const portFree = deps.portFree ?? loopbackPortFree
  const imageLock = new KeyedLock()
  const live = new Map<UserId, { forwarder: Forwarder; timer: NodeJS.Timeout; instanceId: string; port: number }>()
  let cursor = 0

  /** Next unclaimed, bindable port of the sidecar range; ports of live instances are never reused. */
  async function allocateSidecarPort(): Promise<number> {
    const claimed = new Set([...live.values()].map(entry => entry.port))
    for (const port of portsFrom(config.ports.sidecar, cursor)) {
      if (claimed.has(port) || !await portFree(port)) continue
      cursor = port - config.ports.sidecar.min + 1
      return port
    }
    throw new RuntimeStartError('no-port')
  }

  /**
   * Run podman as the account. The deadline is enforced twice: by the runner (kills the process) and here, so a runner
   * that never answers still cannot block a lifecycle operation; a missed deadline reports exit status 124.
   */
  const asAccount = (record: UserRecord, args: readonly string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> => {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      timer = setTimeout(() => resolve({ code: 124, stdout: '', stderr: '' }), timeoutMs + (deps.deadlineSlackMs ?? 1000))
      timer.unref()
    })
    const result = runner.run(config.tools.runuser, ['-u', record.account, '--', config.tools.env, '-i',
      `XDG_RUNTIME_DIR=/run/user/${record.uid}`, `HOME=${record.layout.podman}`, 'PATH=/usr/bin:/bin',
      config.tools.podman, ...args], { timeoutMs })
    return Promise.race([result, deadline]).finally(() => clearTimeout(timer))
  }

  /**
   * Make sure this account's own rootless store holds the instance image. Loading or pulling is serialized across
   * accounts so a start storm does not decompress the same archive many times at once.
   */
  async function ensureImage(record: UserRecord): Promise<void> {
    const has = async (): Promise<boolean> => (await asAccount(record, ['image', 'exists', config.image], 30_000)).code === 0
    if (await has()) return
    await imageLock.run('image', async () => {
      if (await has()) return
      const fetched = config.imageArchive === undefined
        ? await asAccount(record, ['pull', '--quiet', config.image], 900_000)
        : await asAccount(record, ['load', '--quiet', '--input', config.imageArchive], 900_000)
      // A load that succeeds but does not provide the configured reference is as unusable as a failed one.
      if (fetched.code !== 0 || !await has()) throw new RuntimeStartError('image-unavailable')
    })
  }

  async function containerState(record: UserRecord): Promise<ContainerState> {
    const result = await asAccount(record, ['container', 'inspect', '--format', '{{.State.Running}}', record.container], 30_000)
    if (result.code === 0) return result.stdout.trim() === 'true' ? 'running' : 'stopped'
    // podman exits 125 with "no such container" when it is gone; any other failure says nothing about the container.
    return result.code === 125 && /no such/i.test(result.stderr) ? 'stopped' : 'unknown'
  }

  async function writePrivate(record: UserRecord, path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    await chownFile(temporary, record.uid, record.gid)
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  }

  async function writeCredential(record: UserRecord, instanceId: string): Promise<void> {
    const issued = await deps.quota.issue(record.userId, instanceId)
    await writePrivate(record, join(record.layout.home, 'quota-credential.json'), `${JSON.stringify(issued)}\n`)
  }

  async function teardown(record: UserRecord): Promise<void> {
    const entry = live.get(record.userId)
    if (entry !== undefined) { clearInterval(entry.timer); live.delete(record.userId); await entry.forwarder.close().catch(() => {}) }
    await deps.quota.close(record.userId).catch(() => {})
    try { await removeContainer(record) } finally { await clearReady(record.layout.ctl).catch(() => {}) }
  }

  /** Polite stop within the configured time, then SIGKILL, then a forced remove; fails loudly if it is still there. */
  async function removeContainer(record: UserRecord): Promise<void> {
    const polite = await asAccount(record, ['rm', '--force', '--ignore', '--time', String(Math.ceil(config.stopTimeoutMs / 1000)), record.container],
      config.stopTimeoutMs + (deps.stopGraceMs ?? 10_000))
    if (polite.code === 0) return
    await asAccount(record, ['kill', '--signal', 'KILL', record.container], 15_000)
    const forced = await asAccount(record, ['rm', '--force', '--ignore', record.container], 30_000)
    if (forced.code !== 0 && await containerState(record) !== 'stopped') throw new RuntimeStopError()
  }

  return {
    async start(record) {
      // 1. Fail closed on limits, gVisor, and the quota proxy before anything is created.
      try { await enforceLimits(runner, deps.probe, config.tools, config.limits, record.uid) }
      catch (error) { throw error instanceof LimitsError ? new RuntimeStartError('limits') : error }
      const gvisor = await runner.run(config.tools.runsc, ['--version'])
      if (gvisor.code !== 0) throw new RuntimeStartError('gvisor-unavailable')
      if (!await deps.quota.healthy().catch(() => false)) throw new RuntimeStartError('quota-unavailable')
      await ensureImage(record)
      // 2. Clear leftovers from a previous run so no stale token or socket can be published.
      await teardown(record)
      const instanceId = randomBytes(18).toString('base64url')
      let failed = true
      try {
        const sidecarPort = await allocateSidecarPort()
        const proxy = await deps.quota.open(record.userId, instanceId)
        // The firewall allows exactly this range; a proxy listening anywhere else would be unreachable or unsafe.
        if (proxy.port < config.ports.quota.min || proxy.port > config.ports.quota.max) throw new RuntimeStartError('quota-unavailable')
        await writeCredential(record, instanceId)
        await writePrivate(record, join(record.layout.home, 'public-harness-web.patch.yml'),
          webPatch(config, deps.publicHost, proxy.port, 'platform-model'))
        const argv = buildRunArgv(config, record, sidecarPort)
        assertSafeRunArgv(argv, config, record)
        const started = await asAccount(record, argv)
        if (started.code !== 0) throw new RuntimeStartError('start-failed')
        const ready = await waitForReady(record.layout.ctl, record.uid, config.readyTimeoutMs, 100, sleep, deps.clock)
          .catch(() => { throw new RuntimeStartError('not-ready') })
        void ready
        const hostPort = sidecarPort
        const deadline = (deps.clock ?? Date.now)() + config.readyTimeoutMs
        while (!await probeHealth(hostPort)) {
          if ((deps.clock ?? Date.now)() >= deadline) throw new RuntimeStartError('not-ready')
          await sleep(200)
        }
        const forwarder = await forward({ socketPath: record.layout.socketPath, port: hostPort, gid: config.socketGid })
        const timer = setInterval(() => { void writeCredential(record, instanceId).catch(() => {}) }, rotateMs)
        timer.unref()
        live.set(record.userId, { forwarder, timer, instanceId, port: hostPort })
        failed = false
        return { kind: 'unix', path: record.layout.socketPath }
      } finally {
        if (failed) await teardown(record).catch(() => {})
      }
    },
    stop: teardown,
    async launchGrant(record) {
      const ready = await readReady(record.layout.ctl, record.uid)
      if (ready === undefined) throw new Error('launch grant unavailable')
      return ready.token
    },
    isRunning: async record => await containerState(record) === 'running',
    state: containerState,
  }
}
