/** Native systemd lifecycle: ordered prepare, confined Git initialization, quota grant, Web start, verified enforcement, publication. */
import { constants } from 'node:fs'
import { open, readFile, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { ensureGitWorkspace, isolatedGitEnvironment, type InstanceEndpoint, type InstanceId, type RuntimeInstance, type UserId } from '@public-harness/contracts'
import type { MarketBridge, QuotaBridge } from '@public-harness/provisioner/runtime'
import { startUnixForwarder, type Forwarder } from '@public-harness/provisioner/forwarder'
import type { AcquiredResource } from '@public-harness/provisioner/state'
import { CommandError, KeyedLock, runChecked, type CommandRunner } from '@public-harness/provisioner/system'
import { clearReady, readReady, waitForReady, ContainerExitedError } from '@public-harness/provisioner/token-channel'
import { NativeHostError, type SystemdConfig } from './config.ts'
import { installNetwork, removeNetwork, unitCgroup, unitSlice } from './network.ts'
import { buildReconcileSystemdRunArgv, instanceMarketNpmrcPath, reconcilePlanPath } from './reconcile-unit.ts'
import { reconcileMarketFirewall, verifyEnforcement, type MarketProbeHost, type MarketProbeState, type ProbeHost } from './probe.ts'
import { DEFAULT_MARKET_RULES_PATH, MARKET_TABLE, marketOwnerArgv, parseMarketOwnerElements, type MarketEndpoint } from './market-firewall.ts'
import { DEFAULT_MARKET_LOADER_PATH } from './plugins-units.ts'
import { openDirectoryNoFollow, prepareHost } from './storage.ts'

export type NativeState = 'running' | 'stopped' | 'unknown'
type Allocation = Omit<RuntimeInstance, 'webPort' | 'quotaPort'>

/** Explicit collaborators; every host effect goes through `runner` so tests run without root. */
export interface SystemdRuntimeDeps {
  readonly config: SystemdConfig
  readonly runner: CommandRunner
  readonly quota: QuotaBridge
  /** Ports owned by durable records, including quarantined launches. */
  readonly claimedPorts: () => Promise<readonly number[]>
  /** Record a resource before relying on it, so restart recovery and quarantine know what to undo. */
  readonly acquired: (userId: UserId, instanceId: InstanceId, resource: AcquiredResource, ports?: { webPort?: number; quotaPort?: number }) => Promise<void>
  /** Other instances whose network rules must stay installed. */
  readonly active: () => Promise<readonly RuntimeInstance[]>
  /**
   * Instances the market rebuild may re-admit after a restart, plus how many unreadable records it skipped. The adapter
   * passes running, non-quarantined records only. Default: {@link active} with nothing skipped. Either way a candidate is
   * re-admitted only while `systemctl show` reports its unit running.
   */
  readonly marketCandidates?: () => Promise<{ readonly instances: readonly RuntimeInstance[]; readonly skipped: number }>
  /** Authenticated readiness: the Web server on the instance port accepts the published grant. */
  readonly webProbe: (port: number, grant: string) => Promise<boolean>
  /** Socket group for the router-facing forwarder. */
  readonly socketGid: number
  readonly probeHost?: ProbeHost
  readonly startForwarder?: typeof startUnixForwarder
  readonly prepare?: typeof prepareHost
  readonly network?: { install: typeof installNetwork; remove: typeof removeNetwork }
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
  /** Margin after a command's own timeout before the runtime stops waiting for the runner (default 1 s). */
  readonly deadlineSlackMs?: number
  readonly credentialRotateMs?: number
  /**
   * Pre-start reconcile between network.install and instance start.
   * Default runs a confined `systemd-run` one-shot (errors swallowed — instance starts anyway).
   * Pass `false` to skip (tests); pass a function to inject.
   */
  readonly preStartReconcile?: false | ((instance: RuntimeInstance) => Promise<void>)
  /**
   * User's assigned market port (+ optional hostAddress) for the default reconcile unit.
   * Required for the default hook; without it the one-shot is skipped (no tautological port).
   */
  readonly reconcileMarket?:
    | { readonly port: number; readonly hostAddress?: string }
    | ((instance: RuntimeInstance) =>
      | { readonly port: number; readonly hostAddress?: string }
      | undefined
      | Promise<{ readonly port: number; readonly hostAddress?: string } | undefined>)
  /**
   * Plugin market control (`createPluginsMarketBridge`). With `ports.market` set, start opens the account's market
   * endpoint and admits exactly its `uid . port` pair to `inet dsh_market market_owner`; stop deletes every pair of
   * that uid. Without it (or without `ports.market`) the runtime never touches the market table.
   */
  readonly market?: MarketBridge
  /** `market_owner` self-heal and reload settings; used only together with {@link market}. */
  readonly marketFirewall?: MarketFirewallSettings
}

/** Market firewall self-heal: a periodic probe makes `market_owner` exactly equal to the admitted owners. */
export interface MarketFirewallSettings {
  /** Probe interval (default 60 s); 0 disables the timer (tests call `probeMarket()` on the runtime). */
  readonly probeMs?: number
  /** Reload commands tried in order when the table or a chain is missing (default: the loader, then a socket restart). */
  readonly reload?: readonly (readonly [string, ...string[]])[]
  /** Security alert: the same stale element survived two consecutive probes (`repeated`), or an element not yet
   * accounted for was seen while the owners were being rebuilt after a restart (`unverified`, not deleted). */
  readonly onAlert?: (row: MarketEndpoint, reason: MarketAlertReason) => void
  /** Alert-only probes in a row after which each unverified extra is alerted as `stalled` (default 3). */
  readonly stalledAfter?: number
  /** The rebuild skipped this many unreadable state records; their owners stay shut out until they restart. */
  readonly onRebuildSkipped?: (records: number) => void
}

/** `repeated`: a stale element survived two deleting probes. `unverified`: an element seen while the owners are still
 * being rebuilt (not deleted). `stalled`: the same, after {@link MarketFirewallSettings.stalledAfter} probes in a row. */
export type MarketAlertReason = 'repeated' | 'unverified' | 'stalled'

/** A native lifecycle failure with a stable, path-free reason. */
export class NativeRuntimeError extends Error {
  override readonly name = 'NativeRuntimeError'
  constructor(readonly reason: 'ports-exhausted' | 'readiness' | 'spoofed-ready' | 'web-probe' | 'exited' | 'stop-unverified' | 'not-quiescent' | 'recovery-window' | 'not-confirmed' | 'runner-deadline') {
    super(`native runtime: ${reason}`)
  }
}

/** Bound every privileged command twice: by its own timeout, and by a deadline on the runner itself, so a hung
 * adapter cannot hold the per-user lock forever (handoff item 4). The late result is discarded. */
export function budgetedRunner(runner: CommandRunner, timeoutMs: number, slackMs: number): CommandRunner {
  return {
    run(command, args, options) {
      const ms = Math.min(options?.timeoutMs ?? timeoutMs, timeoutMs)
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NativeRuntimeError('runner-deadline')), ms + slackMs) })
      return Promise.race([runner.run(command, args, { ...options, timeoutMs: ms }), deadline]).finally(() => clearTimeout(timer))
    },
  }
}

/** Write a private file into the tenant-writable home without following tenant-controlled links: the home is opened
 * O_NOFOLLOW|O_DIRECTORY, the file is created O_EXCL via `/proc/self/fd`, and owner and mode are set on the handle. */
async function writeTenantFile(home: string, name: string, text: string, uid: number, gid: number): Promise<void> {
  const dir = await openDirectoryNoFollow(home)
  try {
    const base = `/proc/self/fd/${dir.fd}`, temporary = `.${name}.${randomBytes(6).toString('hex')}.tmp`
    const file = await open(`${base}/${temporary}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(text); await file.chown(uid, gid); await file.chmod(0o600) } finally { await file.close() }
    await rename(`${base}/${temporary}`, `${base}/${name}`)
  } finally { await dir.close() }
}

/** The native `InstanceRuntime` core. Lifecycle calls for one user are serialized. */
export function createSystemdRuntime(deps: SystemdRuntimeDeps) {
  const { config } = deps
  const runner = budgetedRunner(deps.runner, config.operationTimeoutMs, deps.deadlineSlackMs ?? 1000)
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const clock = deps.clock ?? Date.now
  const network = deps.network ?? { install: installNetwork, remove: removeNetwork }
  const lock = new KeyedLock(), reserved = new Map<UserId, number>()
  const live = new Map<UserId, { instance: RuntimeInstance; forwarder: Forwarder; grant: string; timer: NodeJS.Timeout }>()
  const systemctl = (...args: string[]) => runChecked(runner, config.tools.systemctl, args)
  const unitOf = (instance: Allocation) => {
    if (instance.runtime.kind !== 'systemd') throw new NativeHostError('invalid-config', 'runtime-selection')
    return instance.runtime.unit
  }
  /** Exit 5 means the unit was never loaded, which is already the stopped state. */
  const stopUnit = async (unit: string) => {
    const result = await runner.run(config.tools.systemctl, ['stop', unit])
    if (result.code !== 0 && result.code !== 5) throw new CommandError(config.tools.systemctl, result.code)
  }
  const socketPath = (instance: Allocation) => `${config.paths.socketDir}/${instance.account}.sock`

  // Market owner admission. One lock serializes every market_owner compare and mutate (start, stop and probe).
  const marketRange = deps.market === undefined ? undefined : config.ports.market
  const marketLock = new KeyedLock(), admitted = new Map<UserId, MarketEndpoint>()
  // Users whose market admission changed (start or stop) since this runtime was created. The rebuild never touches
  // them, on any attempt: a stop may already have released a user whose record is not yet marked stopped.
  const marketTouched = new Set<UserId>()
  const nft = (args: readonly string[]) => runner.run(config.tools.nft, [...args])
  const listOwners = async (): Promise<MarketEndpoint[] | undefined> => {
    const listed = await nft(['list', 'set', 'inet', MARKET_TABLE, 'market_owner'])
    return listed.code === 0 ? parseMarketOwnerElements(listed.stdout) : undefined
  }
  /** Open the endpoint and admit `uid . port`; any failure leaves the account shut out of the market, never others in. */
  async function admitMarket(instance: RuntimeInstance): Promise<MarketEndpoint | undefined> {
    if (deps.market === undefined || marketRange === undefined) return undefined
    const bridge = deps.market
    let opened: { readonly port: number }
    try { opened = await bridge.open(instance.userId, instance.instanceId, instance.uid) } catch { return undefined }
    const row = { uid: instance.uid, port: opened.port }
    try {
      if (!Number.isSafeInteger(row.port) || row.port < marketRange.min || row.port > marketRange.max) throw new Error('market port outside ports.market')
      await marketLock.run('market', async () => {
        // Drop any stale pair that shares this uid or this port before admitting the new one.
        const stale = (await listOwners() ?? []).filter(other => (other.uid === row.uid) !== (other.port === row.port))
        if (stale.length > 0) await runChecked(runner, config.tools.nft, marketOwnerArgv('delete', stale))
        await runChecked(runner, config.tools.nft, marketOwnerArgv('add', [row]))
        admitted.set(instance.userId, row)
        marketTouched.add(instance.userId)
      })
      return row
    } catch {
      await bridge.close(instance.userId).catch(() => {})
      return undefined
    }
  }
  /** Delete every pair of this uid and verify none is left; the endpoint is closed best-effort afterwards. */
  async function releaseMarket(instance: Allocation): Promise<void> {
    if (deps.market === undefined || marketRange === undefined) return
    await marketLock.run('market', async () => {
      const own = (await listOwners() ?? []).filter(row => row.uid === instance.uid)
      if (own.length > 0) {
        await runChecked(runner, config.tools.nft, marketOwnerArgv('delete', own))
        if ((await listOwners() ?? []).some(row => row.uid === instance.uid)) throw new Error('market_owner element survived deletion')
      }
    }).finally(() => {
      // Even when deletion failed the pair is no longer wanted, so the probe treats a leftover as stale.
      admitted.delete(instance.userId)
      marketTouched.add(instance.userId)
    })
    await deps.market.close(instance.userId).catch(() => {})
  }
  const marketReload = deps.marketFirewall?.reload ?? [
    [DEFAULT_MARKET_LOADER_PATH, DEFAULT_MARKET_RULES_PATH],
    // The socket unit's ExecStartPost runs the same loader while the unit's own cgroup exists.
    [config.tools.systemctl, 'restart', 'dsh-plugins.socket'],
  ]
  const marketProbeHost: MarketProbeHost = {
    withLock: task => marketLock.run('market', task),
    listEndpoints: async () => [...admitted.values()],
    async inspect() {
      const listed = await nft(['list', 'table', 'inet', MARKET_TABLE])
      const text = listed.code === 0 ? listed.stdout : ''
      // A chain that exists but lost its drop or listener rule counts as missing, so the probe reloads it.
      const input = /\bchain input \{([^}]*)\}/.exec(text)?.[1], listener = /\bchain market_listener \{([^}]*)\}/.exec(text)?.[1]
      return {
        table: /\bset market_owner \{/.test(text),
        input: input !== undefined && /\bjump market_listener\b/.test(input) && /ct mark \. tcp dport != @market_owner drop/.test(input),
        market_listener: listener !== undefined && /\bsocket cgroupv2 level \d+ "[^"]+" return\b/.test(listener) && /^\s*drop\s*$/m.test(listener),
      }
    },
    async loadTable() {
      for (const [command, ...args] of marketReload) if ((await runner.run(command, args).catch(() => undefined))?.code === 0) return
      throw new Error('inet dsh_market could not be reloaded')
    },
    listSet: async () => { const rows = await listOwners(); if (rows === undefined) throw new Error('market_owner unreadable'); return rows },
    addElements: async rows => { await runChecked(runner, config.tools.nft, marketOwnerArgv('add', rows)) },
    deleteElements: async rows => { await runChecked(runner, config.tools.nft, marketOwnerArgv('delete', rows)) },
    alertExtra: (row, reason = 'repeated') => {
      const escalated = reason === 'unverified' && marketUnverifiedRuns >= marketStalledAfter ? 'stalled' : reason
      ;(deps.marketFirewall?.onAlert ?? ((row: MarketEndpoint, reason: MarketAlertReason) => {
        process.stderr.write(reason === 'repeated'
          ? `dsh_market: stale market_owner element uid ${row.uid} port ${row.port} survived two probes\n`
          : reason === 'stalled'
            ? `dsh_market: SECURITY market_owner element uid ${row.uid} port ${row.port} unverified for ${marketUnverifiedRuns} probes; the owner rebuild is not completing\n`
            : `dsh_market: market_owner element uid ${row.uid} port ${row.port} not yet accounted for (owners still rebuilding; not deleted)\n`)
      }))(row, escalated)
    },
  }
  // After a restart `admitted` is empty while instances still run. Rebuild it from `deps.active()` (re-open each
  // endpoint, which also restores the bridge's own state, and re-admit uid . port) before the probe may delete
  // anything; until then a probe only alerts.
  let marketRebuilt = false, marketRebuilding: Promise<void> | undefined, marketUnverifiedRuns = 0
  const marketStalledAfter = deps.marketFirewall?.stalledAfter ?? 3
  const candidates = deps.marketCandidates ?? (async () => ({ instances: await deps.active(), skipped: 0 }))
  async function rebuildOwners(): Promise<void> {
    if (deps.market === undefined || marketRange === undefined) return
    const bridge = deps.market, range = marketRange
    const { instances, skipped } = await candidates()
    if (skipped > 0) (deps.marketFirewall?.onRebuildSkipped ?? (count => {
      process.stderr.write(`dsh_market: owner rebuild skipped ${count} unreadable state record(s); those owners stay shut out\n`)
    }))(skipped)
    for (const instance of instances) {
      if (admitted.has(instance.userId) || marketTouched.has(instance.userId)) continue
      // Only a unit that is running now gets its pair back; a stopped, failed or unknown unit stays out (fail closed).
      if (await state(instance).catch(() => 'unknown' as const) !== 'running') continue
      if (admitted.has(instance.userId) || marketTouched.has(instance.userId)) continue
      let row: MarketEndpoint
      try {
        const opened = await bridge.open(instance.userId, instance.instanceId, instance.uid)
        row = { uid: instance.uid, port: opened.port }
        if (!Number.isSafeInteger(row.port) || row.port < range.min || row.port > range.max) continue
      } catch { continue }
      // A failure leaves this owner out (fail closed); its endpoint stays open for the instance that holds it.
      await marketLock.run('market', async () => {
        if (admitted.has(instance.userId) || marketTouched.has(instance.userId)) return
        const stale = (await listOwners() ?? []).filter(other => (other.uid === row.uid) !== (other.port === row.port))
        if (stale.length > 0) await runChecked(runner, config.tools.nft, marketOwnerArgv('delete', stale))
        await runChecked(runner, config.tools.nft, marketOwnerArgv('add', [row]))
        admitted.set(instance.userId, row)
      }).catch(() => {})
    }
    marketRebuilt = true
  }
  const rebuildMarket = () => {
    marketRebuilding ??= rebuildOwners().finally(() => { marketRebuilding = undefined })
    return marketRebuilding
  }
  let marketProbe: MarketProbeState = { previousExtras: new Set() }
  /** One self-heal pass; failures leave the table as it is (owners may be shut out, never let in). */
  async function probeMarket(): Promise<void> {
    if (marketRange === undefined) return
    // Not rebuilt and idle: (re)try the rebuild first. Still rebuilding, or it failed: alert only.
    if (!marketRebuilt && marketRebuilding === undefined) await rebuildMarket().catch(() => {})
    marketUnverifiedRuns = marketRebuilt ? 0 : marketUnverifiedRuns + 1
    marketProbe = await reconcileMarketFirewall(marketProbeHost, marketProbe, { deleteExtras: marketRebuilt })
  }
  if (marketRange !== undefined) void rebuildMarket().catch(() => {})
  const marketProbeMs = deps.marketFirewall?.probeMs ?? 60_000
  const marketTimer = marketRange === undefined || marketProbeMs === 0 ? undefined
    : setInterval(() => { void probeMarket().catch(() => {}) }, marketProbeMs)
  marketTimer?.unref?.()

  async function credential(instance: RuntimeInstance): Promise<void> {
    const issued = await deps.quota.issue(instance.userId, instance.instanceId)
    await writeTenantFile(instance.home, 'quota-credential.json', `${JSON.stringify(issued)}\n`, instance.uid, instance.gid)
  }

  /** `systemctl show` is the only state source; a unit whose cgroup still has processes is never reported stopped. */
  async function state(instance: Allocation): Promise<NativeState> {
    const result = await runner.run(config.tools.systemctl, ['show', unitOf(instance), '--property=ActiveState', '--value']).catch(() => undefined)
    if (result === undefined || result.code !== 0) return 'unknown'
    const active = result.stdout.trim()
    if (active === 'active' || active === 'activating' || active === 'reloading') return 'running'
    if (active !== 'inactive' && active !== 'failed') return 'unknown'
    const procs = await (deps.probeHost?.read ?? (path => readFile(path, 'utf8')))(
      `/sys/fs/cgroup/${unitCgroup({ ...instance, webPort: 0, quotaPort: 0 }).path}/cgroup.procs`).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? '' : undefined)
    return procs === undefined ? 'unknown' : procs.trim() === '' ? 'stopped' : 'unknown'
  }

  /** Revoke, stop and verify; every step runs even when an earlier one fails, and any failure leaves the record for quarantine. */
  async function teardown(instance: Allocation): Promise<void> {
    const errors: unknown[] = [], attempt = async (step: () => Promise<unknown>) => { try { await step() } catch (error) { errors.push(error) } }
    const entry = live.get(instance.userId)
    if (entry !== undefined) { clearInterval(entry.timer); await attempt(() => entry.forwarder.close()) }
    await attempt(() => deps.quota.close(instance.userId))
    await attempt(() => stopUnit(unitOf(instance)))
    await attempt(() => stopUnit(unitSlice({ ...instance, webPort: 0, quotaPort: 0 })))
    await attempt(async () => { if (await state(instance) !== 'stopped') throw new NativeRuntimeError('stop-unverified') })
    const others = (await deps.active().catch(error => { errors.push(error); return [] })).filter(other => other.userId !== instance.userId)
    await attempt(() => releaseMarket(instance))
    await attempt(() => network.remove({ ...instance, webPort: 0, quotaPort: 0 }, config, runner, others))
    await attempt(() => clearReady(instance.home))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'native cleanup could not be verified')
    live.delete(instance.userId); reserved.delete(instance.userId)
  }

  async function allocate(request: Allocation): Promise<RuntimeInstance> {
    return lock.run(request.userId, async () => {
      const taken = new Set([...await deps.claimedPorts(), ...reserved.values()])
      let webPort: number | undefined
      for (let port = config.ports.web.min; port <= config.ports.web.max; port++) if (!taken.has(port)) { webPort = port; break }
      if (webPort === undefined) throw new NativeRuntimeError('ports-exhausted')
      reserved.set(request.userId, webPort)
      await deps.acquired(request.userId, request.instanceId, 'network', { webPort })
      const { port: quotaPort } = await deps.quota.open(request.userId, request.instanceId)
      await deps.acquired(request.userId, request.instanceId, 'quota', { quotaPort })
      return { ...request, webPort, quotaPort }
    })
  }

  async function prepare(instance: RuntimeInstance): Promise<void> {
    await lock.run(instance.userId, async () => {
      await (deps.prepare ?? prepareHost)(instance, config, runner)
      await deps.acquired(instance.userId, instance.instanceId, 'account')
      await deps.acquired(instance.userId, instance.instanceId, 'storage')
      await runChecked(runner, config.tools.apparmorParser, ['-r', '-W', `${instance.controlDir}/${instance.account}.apparmor`])
      await deps.acquired(instance.userId, instance.instanceId, 'policy')
      await deps.acquired(instance.userId, instance.instanceId, 'unit')
      await systemctl('link', `${instance.controlDir}/${unitOf(instance)}`)
      await systemctl('daemon-reload')
    })
  }

  /** Git runs as the account in a transient unit with the instance's profile, slice and filesystem view, never as root. */
  async function initializeWorkspace(instance: RuntimeInstance): Promise<void> {
    const slice = unitSlice(instance)
    const env = Object.entries({ ...isolatedGitEnvironment(), HOME: instance.home, PATH: '/usr/bin:/bin' }).map(([key, value]) => `--setenv=${key}=${value}`)
    await ensureGitWorkspace(instance.workspace, (args, cwd) => runChecked(runner, config.tools.systemdRun, [
      '--wait', '--collect', '--pipe', '--quiet', `--slice=${slice}`, `--uid=${instance.uid}`, `--gid=${instance.gid}`,
      `--working-directory=${cwd}`, `--property=AppArmorProfile=${instance.account}`, '--property=NoNewPrivileges=yes',
      '--property=CapabilityBoundingSet=', '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
      `--property=ReadWritePaths=${instance.workspace}`, '--property=PrivateNetwork=yes', '--property=PrivateDevices=yes',
      `--property=InaccessiblePaths=${config.paths.stateDir} ${config.paths.socketDir}`,
      `--property=MemoryMax=${config.limits.memoryBytes}`, `--property=TasksMax=${config.limits.pids}`,
      ...env, '--', config.tools.git, ...args]))
  }

  async function start(instance: RuntimeInstance): Promise<InstanceEndpoint> {
    return lock.run(instance.userId, async () => {
      try {
        await clearReady(instance.home)
        await credential(instance)
        await systemctl('start', unitSlice(instance))
        // The slice cgroup now exists, so `socket cgroupv2` resolves; rules are in place before any tenant process runs.
        await network.install(instance, config, runner, (await deps.active()).filter(other => other.userId !== instance.userId))
        // The owner pair goes in before any tenant process (the reconcile one-shot included) can dial the market.
        const ownMarket = await admitMarket(instance)
        // Native order: slice → network.install → market owner → reconcile unit → instance (design § Fallback).
        // Reconcile failures must not block the instance start.
        if (deps.preStartReconcile !== false) {
          const reconcile = deps.preStartReconcile ?? (async (target: RuntimeInstance) => {
            const market = typeof deps.reconcileMarket === 'function'
              ? await deps.reconcileMarket(target)
              : deps.reconcileMarket ?? (ownMarket === undefined ? undefined : { port: ownMarket.port })
            if (market === undefined) return
            const npmGlobalConfig = instanceMarketNpmrcPath(config, target.account) ?? '/dev/null'
            const argv = buildReconcileSystemdRunArgv({
              instance: target,
              config,
              entryPath: `${config.paths.release}/reconcile-entry.mjs`,
              planPath: reconcilePlanPath(target.home),
              npmGlobalConfig,
              marketPort: market.port,
              ...(market.hostAddress === undefined ? {} : { hostAddress: market.hostAddress }),
            })
            try { await runChecked(runner, config.tools.systemdRun, argv) } catch { /* start anyway */ }
          })
          try { await reconcile(instance) } catch { /* start anyway */ }
        }
        await systemctl('start', unitOf(instance))
        let ready
        try {
          ready = await waitForReady(instance.home, instance.uid, config.readyTimeoutMs, 100, sleep, clock,
            { check: () => state(instance), everyMs: 1000 })
        } catch (error) { throw new NativeRuntimeError(error instanceof ContainerExitedError ? 'exited' : 'readiness') }
        if (ready.port !== instance.webPort) throw new NativeRuntimeError('spoofed-ready')
        await verifyEnforcement(instance, config, runner, deps.probeHost)
        if (!await deps.webProbe(instance.webPort, ready.token).catch(() => false)) throw new NativeRuntimeError('web-probe')
        await deps.acquired(instance.userId, instance.instanceId, 'forwarder')
        const forwarder = await (deps.startForwarder ?? startUnixForwarder)({ socketPath: socketPath(instance), port: instance.webPort, gid: deps.socketGid })
        const timer = setInterval(() => { void credential(instance).catch(() => {}) }, deps.credentialRotateMs ?? 480_000)
        timer.unref?.()
        live.set(instance.userId, { instance, forwarder, grant: ready.token, timer })
        return { kind: 'unix', path: socketPath(instance) }
      } catch (error) {
        // A partial start is torn down at once; a teardown failure surfaces so the caller quarantines the record.
        try { await teardown(instance) } catch (cleanup) { throw new AggregateError([error, cleanup], 'native start failed and cleanup was not verified') }
        throw error
      }
    })
  }

  async function launchGrant(instance: Allocation): Promise<string> {
    const entry = live.get(instance.userId)
    if (entry !== undefined && entry.instance.instanceId === instance.instanceId) return entry.grant
    const ready = await readReady(instance.home, instance.uid)
    if (ready === undefined) throw new NativeRuntimeError('readiness')
    return ready.token
  }

  /** Delete a tenant's data only after the recovery window, with the unit verifiably quiescent and no process left
   * under the account's UID. The caller holds the account record; failure leaves it quarantined. */
  async function purge(instance: Allocation, deletion: { confirmed: boolean; recoveryExpiresAt: number },
    remove: (instance: Allocation) => Promise<void>, uidProcesses: (uid: number) => Promise<number>): Promise<void> {
    await lock.run(instance.userId, async () => {
      if (!deletion.confirmed) throw new NativeRuntimeError('not-confirmed')
      if (clock() < deletion.recoveryExpiresAt) throw new NativeRuntimeError('recovery-window')
      await teardown(instance)
      if (await state(instance) !== 'stopped' || await uidProcesses(instance.uid) !== 0) throw new NativeRuntimeError('not-quiescent')
      await remove(instance)
    })
  }

  return {
    kind: 'systemd' as const, allocate, prepare, initializeWorkspace, start, launchGrant, state, purge, probeMarket,
    stop: (instance: Allocation) => lock.run(instance.userId, () => teardown(instance)),
    releaseAllocation: (instance: Allocation) => lock.run(instance.userId, () => teardown(instance)),
    async close() {
      if (marketTimer !== undefined) clearInterval(marketTimer)
      const results = await Promise.allSettled([...live.values()].map(entry => lock.run(entry.instance.userId, () => teardown(entry.instance))))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'native provider shutdown failed')
    },
  }
}
