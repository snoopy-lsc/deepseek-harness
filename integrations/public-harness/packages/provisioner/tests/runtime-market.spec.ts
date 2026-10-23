import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginMarketRows } from '@public-harness/contracts'
import { deriveNames } from '../src/accounts.ts'
import { resolveContainerConfig, validateProvisionerConfig } from '../src/config.ts'
import {
  MARKET_TABLE,
  marketOwnerAddArgv,
  marketOwnerDeleteArgv,
  renderMarketOwnerAdd,
  renderMarketOwnerDelete,
} from '../src/market-firewall.ts'
import {
  CONTAINER,
  RuntimeStartError,
  SIDECAR_PORT,
  assertSafeRunArgv,
  buildRunArgv,
  createRuntime,
  webPatch,
  type MarketBridge,
  type QuotaBridge,
} from '../src/runtime.ts'
import { layoutFor } from '../src/storage.ts'
import type { UserRecord } from '../src/users.ts'
import { FakeRunner, alice, gid, makeConfig, uid } from './helpers.ts'

const TOKEN = 'launch-token-SECRET-123'
const controllers = { controllers: async () => ['cpuset', 'cpu', 'io', 'memory', 'hugetlb', 'pids'] }

async function setupMarket(options: {
  marketOnly?: boolean
  marketOpenFails?: boolean
  skipMarketBridge?: boolean
} = {}) {
  const common = await makeConfig({
    ports: { quota: { min: 29100, max: 29109 }, market: { min: 30_000, max: 30_099 } },
  })
  // Re-bind marketDir onto the same tree makeConfig created (outside storageRoot).
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
  for (const dir of [layout.root, layout.home, layout.workspace, layout.ctl, layout.podman]) {
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
  const marketCalls: string[] = []
  const market: MarketBridge = {
    open: async () => {
      marketCalls.push('open')
      if (options.marketOpenFails) throw new Error('market unavailable')
      return { port: 30_001, token: 'market-bearer-token', marketOnly: options.marketOnly === true }
    },
    close: async () => { marketCalls.push('close') },
  }
  let now = 0
  runner.handler = async (_command, args) => {
    if (args.includes('run')) {
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
    config, runner, quota, probe: controllers, publicHost: 'harness.example.test',
    ...(options.skipMarketBridge ? {} : { market }),
    startForwarder: async () => ({ close: async () => {} }),
    healthProbe: async () => true,
    portFree: async () => true,
    sleep: async ms => { now += ms },
    clock: () => now,
  })
  return { config, record, runner, runtime, marketCalls, marketDir: siblingMarket, account: account.account }
}

describe('container market webPatch', () => {
  it('includes pluginMarketRows with registry host = quota.hostAddress', async () => {
    const { config } = await setupMarket()
    const text = webPatch(config, 'harness.example.test', 29100, 'platform-model', {
      port: 30_001,
      marketOnly: false,
    })
    const parsed = JSON.parse(text) as unknown[]
    const expected = pluginMarketRows({
      host: config.quota.hostAddress,
      port: 30_001,
      syncPlugin: `file://${CONTAINER.assets}/packages/plugin-sync/lib/index.js`,
      syncUrl: `http://${config.quota.hostAddress}:30001/sync`,
    })
    expect(config.quota.hostAddress).toBe('10.0.2.2')
    expect(JSON.stringify(parsed)).toContain(`http://${config.quota.hostAddress}:30001/index.json`)
    for (const row of expected) expect(parsed).toContainEqual(row)
    expect(JSON.stringify(parsed)).not.toContain('plugin-manager')
  })

  it('under marketOnly pins plugin-manager registry with empty fallbacks', async () => {
    const { config } = await setupMarket()
    const text = webPatch(config, 'harness.example.test', 29100, 'platform-model', {
      port: 30_001,
      marketOnly: true,
    })
    const parsed = JSON.parse(text) as unknown[]
    expect(parsed).toContainEqual({
      id: 'plugin-manager',
      config: {
        registry: `http://${config.quota.hostAddress}:30001/npm/`,
        fallbackRegistries: [],
      },
    })
  })

  it('without market options omits market rows (feature off)', async () => {
    const { config } = await setupMarket()
    const text = webPatch(config, 'harness.example.test', 29100, 'platform-model')
    expect(text).not.toContain('plugin-market')
    expect(text).not.toContain('plugin-manager')
  })
})

describe('container market volume allowlist', () => {
  it('admits the read-only market volume and NPM_CONFIG_GLOBALCONFIG', async () => {
    const { config, record, marketDir, account } = await setupMarket()
    const argv = buildRunArgv(config, record, 29200)
    const volume = `${marketDir}/${account}:${CONTAINER.market}:ro,Z`
    expect(argv).toEqual(expect.arrayContaining(['--volume', volume]))
    expect(argv).toEqual(expect.arrayContaining(['--env', `NPM_CONFIG_GLOBALCONFIG=${CONTAINER.market}/npmrc`]))
    expect(() => assertSafeRunArgv(argv, config, record)).not.toThrow()
  })

  it('still refuses a foreign volume and out-of-range publish when market is present', async () => {
    const { config, record } = await setupMarket()
    const argv = buildRunArgv(config, record, 29200)
    const foreign = [...argv]
    foreign.splice(foreign.indexOf(config.image), 0, '--volume', '/home/other:/x:rw,Z')
    expect(() => assertSafeRunArgv(foreign, config, record)).toThrow(RuntimeStartError)

    const published = [...argv]
    published.splice(published.indexOf(config.image), 0, '--publish', '0.0.0.0:80:80')
    expect(() => assertSafeRunArgv(published, config, record)).toThrow(RuntimeStartError)

    const badPublish = [...argv]
    const pubIdx = badPublish.indexOf('--publish')
    badPublish[pubIdx + 1] = `127.0.0.1:5432:${SIDECAR_PORT}`
    expect(() => assertSafeRunArgv(badPublish, config, record)).toThrow(RuntimeStartError)
  })
})

describe('market_owner set element helpers', () => {
  it('renders and argv-shapes match native uid . port pairs (no live nft)', () => {
    expect(MARKET_TABLE).toBe('dsh_market')
    expect(renderMarketOwnerAdd(1001, 30_001)).toBe(
      'add element inet dsh_market market_owner { 1001 . 30001 }',
    )
    expect(renderMarketOwnerDelete(1001, 30_001)).toBe(
      'delete element inet dsh_market market_owner { 1001 . 30001 }',
    )
    expect(marketOwnerAddArgv(1001, 30_001)).toEqual([
      'add', 'element', 'inet', 'dsh_market', 'market_owner', '{ 1001 . 30001 }',
    ])
    expect(marketOwnerDeleteArgv(1001, 30_001)).toEqual([
      'delete', 'element', 'inet', 'dsh_market', 'market_owner', '{ 1001 . 30001 }',
    ])
  })
})

describe('container market_owner lifecycle', () => {
  it('adds market_owner before start and removes on stop; writes npmrc under marketDir', async () => {
    const { config, record, runner, runtime, marketCalls, marketDir, account } = await setupMarket()
    await runtime.start(record)

    const nftAdds = runner.calls.filter(call =>
      call.command === config.tools.nft && call.args[0] === 'add' && call.args.includes('market_owner'))
    expect(nftAdds).toHaveLength(1)
    expect(nftAdds[0]!.args).toEqual(marketOwnerAddArgv(record.uid, 30_001))

    const runIdx = runner.calls.findIndex(call => call.args.includes('run'))
    const addIdx = runner.calls.findIndex(call =>
      call.command === config.tools.nft && call.args[0] === 'add' && call.args.includes('market_owner'))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeLessThan(runIdx)

    const patch = await readFile(join(record.layout.home, 'public-harness-web.patch.yml'), 'utf8')
    expect(patch).toContain(`http://${config.quota.hostAddress}:30001/index.json`)
    expect(patch).not.toContain('plugin-manager')

    const npmrc = await readFile(join(marketDir, account, 'npmrc'), 'utf8')
    expect(npmrc).toContain(`@corp-dsh:registry=http://${config.quota.hostAddress}:30001/npm/`)
    expect(npmrc).toContain(`//${config.quota.hostAddress}:30001/npm/:_authToken=market-bearer-token`)
    expect(npmrc).not.toMatch(/^registry=/m)

    expect(marketCalls).toEqual(['open'])

    await runtime.stop(record)
    const nftDeletes = runner.calls.filter(call =>
      call.command === config.tools.nft && call.args[0] === 'delete' && call.args.includes('market_owner'))
    expect(nftDeletes).toHaveLength(1)
    expect(nftDeletes[0]!.args).toEqual(marketOwnerDeleteArgv(record.uid, 30_001))
    expect(marketCalls).toEqual(['open', 'close'])
  })

  it('under marketOnly writes registry= npmrc and plugin-manager patch row', async () => {
    const { config, record, runtime, marketDir, account } = await setupMarket({ marketOnly: true })
    await runtime.start(record)
    const patch = await readFile(join(record.layout.home, 'public-harness-web.patch.yml'), 'utf8')
    expect(patch).toContain('"id":"plugin-manager"')
    expect(patch).toContain(`"registry":"http://${config.quota.hostAddress}:30001/npm/"`)
    expect(patch).toContain('"fallbackRegistries":[]')
    const npmrc = await readFile(join(marketDir, account, 'npmrc'), 'utf8')
    expect(npmrc).toMatch(new RegExp(`^registry=http://${config.quota.hostAddress.replace(/\./g, '\\.')}:30001/npm/$`, 'm'))
  })

  it('market open failure still starts the instance without market rows or owner element', async () => {
    const { record, runner, runtime, config } = await setupMarket({ marketOpenFails: true })
    await expect(runtime.start(record)).resolves.toMatchObject({ kind: 'unix' })
    expect(runner.calls.some(call =>
      call.command === config.tools.nft && call.args.includes('market_owner'))).toBe(false)
    const patch = await readFile(join(record.layout.home, 'public-harness-web.patch.yml'), 'utf8')
    expect(patch).not.toContain('plugin-market')
  })
})

describe('paths.marketDir and ports.market stay validated', () => {
  it('accepts marketDir beside storage and keeps ports.market overlap / width refusals', async () => {
    const common = await makeConfig()
    const marketDir = join(common.paths.storageRoot, '..', 'instance-market')
    await mkdir(marketDir, { recursive: true, mode: 0o711 })
    const ok = validateProvisionerConfig({
      ...common,
      paths: { ...common.paths, marketDir },
      ports: { ...common.ports, market: { min: 30_000, max: 30_099 } },
    })
    expect(ok.paths.marketDir).toBe(marketDir)
    expect(ok.ports.market).toEqual({ min: 30_000, max: 30_099 })

    expect(() => validateProvisionerConfig({
      ...common,
      paths: { ...common.paths, marketDir: join(common.paths.storageRoot, 'nested-market') },
    })).toThrow(/marketDir/i)

    expect(() => validateProvisionerConfig({
      ...common,
      paths: { ...common.paths, marketDir },
      ports: { ...common.ports, market: { min: 29_100, max: 29_150 } },
    })).toThrow(/overlap/i)

    expect(() => validateProvisionerConfig({
      ...common,
      paths: { ...common.paths, marketDir },
      ports: { ...common.ports, market: { min: 10_000, max: 10_000 + 4096 } },
    })).toThrow()
  })
})
