/** 1E.5: container one-shot reconcile argv allowlist (P0.5 — no live pasta/runsc). */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveNames } from '../src/accounts.ts'
import { resolveContainerConfig, validateProvisionerConfig } from '../src/config.ts'
import { marketOwnerAddArgv } from '../src/market-firewall.ts'
import {
  CONTAINER,
  INSTANCE_USERNS,
  RuntimeStartError,
  assertSafeReconcileArgv,
  buildReconcileRunArgv,
  createRuntime,
  reconcileContainerName,
  reconcilePlanContainerPath,
  type MarketBridge,
  type QuotaBridge,
} from '../src/runtime.ts'
import { layoutFor } from '../src/storage.ts'
import type { UserRecord } from '../src/users.ts'
import { FakeRunner, alice, gid, makeConfig, uid } from './helpers.ts'

const TOKEN = 'launch-token-SECRET-123'
const controllers = { controllers: async () => ['cpuset', 'cpu', 'io', 'memory', 'hugetlb', 'pids'] }
const RECONCILE_ENV_KEYS = [
  'HOME', 'DSH_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'PATH', 'NPM_CONFIG_GLOBALCONFIG',
] as const

async function setupReconcile(options: {
  marketOnly?: boolean
  reconcileFails?: boolean
} = {}) {
  const common = await makeConfig({
    ports: { quota: { min: 29100, max: 29109 }, market: { min: 30_000, max: 30_099 } },
  })
  const siblingMarket = join(common.paths.storageRoot, '..', 'instance-market')
  await mkdir(siblingMarket, { recursive: true, mode: 0o711 })
  const validated = validateProvisionerConfig({
    ...common,
    paths: { ...common.paths, marketDir: siblingMarket },
    ports: { quota: { min: 29100, max: 29109 }, market: { min: 30_000, max: 30_099 } },
  })
  const config = resolveContainerConfig(validated)
  const account = deriveNames(alice)
  const layout = layoutFor(config.paths, account.account)
  for (const dir of [layout.root, layout.home, layout.workspace, layout.ctl, layout.podman, layout.cache, layout.tmp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
  await mkdir(join(siblingMarket, account.account), { recursive: true, mode: 0o700 })
  const record: UserRecord = {
    userId: alice, account: account.account, container: account.container,
    uid, gid, lifecycle: 'starting', layout,
  }
  const runner = new FakeRunner()
  const quota: QuotaBridge = {
    healthy: async () => true,
    open: async () => ({ port: 29100 }),
    issue: async () => ({ token: 'quota-token.signed', expiresAt: Date.now() + 600_000 }),
    close: async () => {},
  }
  const market: MarketBridge = {
    open: async () => ({ port: 30_001, token: 'market-bearer-token', marketOnly: options.marketOnly === true }),
    close: async () => {},
  }
  let now = 0
  runner.handler = async (_command, args) => {
    const isReconcile = args.includes('run') && args.includes(reconcileContainerName(record))
    if (isReconcile) {
      if (options.reconcileFails) return { code: 1, stdout: '', stderr: 'reconcile failed' }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args.includes('run') && args.includes('--detach')) {
      await writeFile(
        join(layout.ctl, 'ready.json'),
        JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: TOKEN }),
        { mode: 0o600 },
      )
      return { code: 0, stdout: 'abcdef\n', stderr: '' }
    }
    return undefined
  }
  const runtime = createRuntime({
    config, runner, quota, market, probe: controllers, publicHost: 'harness.example.test',
    startForwarder: async () => ({ close: async () => {} }),
    healthProbe: async () => true,
    portFree: async () => true,
    sleep: async ms => { now += ms },
    clock: () => now,
  })
  return { config, record, runner, runtime, marketDir: siblingMarket, account: account.account }
}

function envMap(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env' && argv[i + 1] !== undefined) {
      const raw = argv[i + 1]!
      const eq = raw.indexOf('=')
      if (eq > 0) out.set(raw.slice(0, eq), raw.slice(eq + 1))
    }
  }
  return out
}

describe('buildReconcileRunArgv / assertSafeReconcileArgv', () => {
  it('admits workspace + home (snapshot) + market + assets; pasta flags; no publish', async () => {
    const { config, record, marketDir, account } = await setupReconcile()
    const argv = buildReconcileRunArgv(config, record, 30_001)
    const volumes = argv.flatMap((arg, i) => arg === '--volume' ? [argv[i + 1]!] : [])
    expect(volumes).toEqual(expect.arrayContaining([
      `${record.layout.home}:${CONTAINER.home}:rw,Z`,
      `${record.layout.workspace}:${CONTAINER.workspace}:rw,Z`,
      `${marketDir}/${account}:${CONTAINER.market}:ro,Z`,
      `${config.paths.runtimeAssets}:${CONTAINER.assets}:ro,Z`,
    ]))
    expect(volumes).not.toEqual(expect.arrayContaining([
      expect.stringContaining(CONTAINER.ctl),
    ]))
    expect(argv.includes('--publish')).toBe(false)
    expect(argv.includes('--detach')).toBe(false)
    expect(argv).toEqual(expect.arrayContaining(['--rm']))
    expect(argv[argv.indexOf('--network') + 1]).toBe('pasta:--map-host-loopback,10.0.2.2,--no-splice')
    expect(argv[argv.indexOf('--userns') + 1]).toBe(INSTANCE_USERNS)
    expect(argv).toEqual(expect.arrayContaining(['--name', reconcileContainerName(record)]))
    const imageIdx = argv.indexOf(config.image)
    expect(argv.slice(imageIdx)).toEqual([
      config.image,
      'node',
      `${CONTAINER.assets}/reconcile-entry.mjs`,
      reconcilePlanContainerPath(),
      '--market-port=30001',
    ])
    expect(() => assertSafeReconcileArgv(argv, config, record)).not.toThrow()
  })

  it('env allowlist matches native reconcile (exactly six keys)', async () => {
    const { config, record } = await setupReconcile()
    const argv = buildReconcileRunArgv(config, record, 30_001)
    const envs = envMap(argv)
    expect([...envs.keys()].sort()).toEqual([...RECONCILE_ENV_KEYS].sort())
    expect(envs.get('HOME')).toBe(CONTAINER.home)
    expect(envs.get('DSH_HOME')).toBe(CONTAINER.home)
    expect(envs.get('XDG_CACHE_HOME')).toBe(`${CONTAINER.home}/.cache`)
    expect(envs.get('TMPDIR')).toBe('/tmp')
    expect(envs.get('NPM_CONFIG_GLOBALCONFIG')).toBe(`${CONTAINER.market}/npmrc`)
    expect(envs.get('PATH')).toBeTruthy()
  })

  it('refuses publish, foreign volume, ctl volume, forbidden flags, and non-entry commands', async () => {
    const { config, record, marketDir } = await setupReconcile()
    const argv = buildReconcileRunArgv(config, record, 30_001)

    const published = [...argv]
    published.splice(published.indexOf(config.image), 0, '--publish', '127.0.0.1:29200:8081')
    expect(() => assertSafeReconcileArgv(published, config, record)).toThrow(RuntimeStartError)

    const foreign = [...argv]
    foreign.splice(foreign.indexOf(config.image), 0, '--volume', `${marketDir}/other-account:${CONTAINER.market}:ro,Z`)
    expect(() => assertSafeReconcileArgv(foreign, config, record)).toThrow(RuntimeStartError)

    const ctl = [...argv]
    ctl.splice(ctl.indexOf(config.image), 0, '--volume', `${record.layout.ctl}:${CONTAINER.ctl}:rw,Z`)
    expect(() => assertSafeReconcileArgv(ctl, config, record)).toThrow(RuntimeStartError)

    const privileged = [...argv]
    privileged.splice(privileged.indexOf(config.image), 0, '--privileged')
    expect(() => assertSafeReconcileArgv(privileged, config, record)).toThrow(RuntimeStartError)

    const badNet = [...argv]
    badNet[badNet.indexOf('--network') + 1] = 'pasta:--map-host-loopback,10.0.2.2'
    expect(() => assertSafeReconcileArgv(badNet, config, record)).toThrow(RuntimeStartError)

    const badCmd = [...argv]
    const img = badCmd.indexOf(config.image)
    badCmd.splice(img + 1, badCmd.length - img - 1, 'bash', '-c', 'id')
    expect(() => assertSafeReconcileArgv(badCmd, config, record)).toThrow(RuntimeStartError)

    const badEntry = [...argv]
    const nodeIdx = badEntry.indexOf('node')
    badEntry[nodeIdx + 1] = `${CONTAINER.assets}/container-entry.js`
    expect(() => assertSafeReconcileArgv(badEntry, config, record)).toThrow(RuntimeStartError)
  })

  it('command allowlist refuses outer pnpm (entry runs pnpm internally)', async () => {
    const { config, record } = await setupReconcile()
    const argv = buildReconcileRunArgv(config, record, 30_001)
    const img = argv.indexOf(config.image)
    const pnpmArgv = [...argv.slice(0, img + 1), 'pnpm', 'add', '@corp-dsh/x@1.0.0']
    expect(() => assertSafeReconcileArgv(pnpmArgv, config, record)).toThrow(RuntimeStartError)
  })

  it('requires --rm and --runtime matching tools.runsc', async () => {
    const { config, record } = await setupReconcile()
    const argv = buildReconcileRunArgv(config, record, 30_001)
    expect(argv).toEqual(expect.arrayContaining(['--rm', '--runtime', config.tools.runsc]))

    const noRm = argv.filter(arg => arg !== '--rm')
    expect(() => assertSafeReconcileArgv(noRm, config, record)).toThrow(RuntimeStartError)

    const badRuntime = [...argv]
    badRuntime[badRuntime.indexOf('--runtime') + 1] = '/usr/bin/runc'
    expect(() => assertSafeReconcileArgv(badRuntime, config, record)).toThrow(RuntimeStartError)

    const noRuntime = argv.filter((_, i, all) => all[i] !== '--runtime' && all[i - 1] !== '--runtime')
    expect(() => assertSafeReconcileArgv(noRuntime, config, record)).toThrow(RuntimeStartError)
  })
})

describe('container pre-start reconcile wiring', () => {
  it('runs one-shot reconcile after market_owner add and before instance start', async () => {
    const { config, record, runner, runtime } = await setupReconcile()
    await runtime.start(record)

    const addIdx = runner.calls.findIndex(call =>
      call.command === config.tools.nft && call.args[0] === 'add' && call.args.includes('market_owner'))
    const reconcileIdx = runner.calls.findIndex(call =>
      call.args.includes('run') && call.args.includes(reconcileContainerName(record)))
    const instanceIdx = runner.calls.findIndex(call =>
      call.args.includes('run') && call.args.includes('--detach'))

    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(reconcileIdx).toBeGreaterThan(addIdx)
    expect(instanceIdx).toBeGreaterThan(reconcileIdx)
    expect(runner.calls[addIdx]!.args).toEqual(marketOwnerAddArgv(record.uid, 30_001))

    const reconcileArgv = runner.calls[reconcileIdx]!.args
    expect(reconcileArgv).toEqual(expect.arrayContaining(['--rm']))
    expect(reconcileArgv.includes('--publish')).toBe(false)
    expect(reconcileArgv[reconcileArgv.indexOf('--network') + 1]).toContain('--no-splice')
    expect(reconcileArgv[reconcileArgv.indexOf('--network') + 1]).toContain('--map-host-loopback')
    expect(() => assertSafeReconcileArgv(reconcileArgv, config, record)).not.toThrow()
  })

  it('instance starts anyway when one-shot reconcile exits non-zero', async () => {
    const { record, runtime, runner } = await setupReconcile({ reconcileFails: true })
    await expect(runtime.start(record)).resolves.toMatchObject({ kind: 'unix' })
    expect(runner.calls.some(call =>
      call.args.includes('run') && call.args.includes(reconcileContainerName(record)))).toBe(true)
    expect(runner.calls.some(call =>
      call.args.includes('run') && call.args.includes('--detach'))).toBe(true)
  })

  it('owner reach fixture: market_owner uid.port present; cross-tenant market volume denied', async () => {
    const { config, record, runner, runtime, marketDir } = await setupReconcile()
    await runtime.start(record)
    const add = runner.calls.find(call =>
      call.command === config.tools.nft && call.args.includes('market_owner') && call.args[0] === 'add')
    expect(add?.args).toEqual(marketOwnerAddArgv(record.uid, 30_001))
    expect(add?.args.join(' ')).toContain(`${record.uid} . 30001`)

    const argv = buildReconcileRunArgv(config, record, 30_001)
    const peer = [...argv]
    peer.splice(peer.indexOf(config.image), 0, '--volume', `${marketDir}/peer:${CONTAINER.market}:ro,Z`)
    expect(() => assertSafeReconcileArgv(peer, config, record)).toThrow(RuntimeStartError)
  })
})
