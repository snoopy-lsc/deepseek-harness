import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANY_SCOPE_PREFIX,
  insertPackage,
  insertVersion,
  newId,
  openEndpoint,
  openPluginsDb,
  type PluginsDb,
} from '@public-harness/plugins'
import {
  parsePluginsProfileConfig,
  productionMarketListenOptions,
  startProductionMarketServer,
  startProductionPlugins,
} from '../src/plugins-service.ts'

const roots: string[] = []
const dbs: PluginsDb[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-svc-'))
  roots.push(root)
  return root
}

function fixtureDb(): PluginsDb {
  const root = fixtureRoot()
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  dbs.push(db)
  return db
}

const deployNativeConfig = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/native/config',
)

const DISPLAY = JSON.stringify({
  title: { en: 'Demo' },
  description: { en: 'd' },
  author: 'corp',
  homepage: '',
  repository: '',
  metadata: { category: 'tools', keywords: [], labels: [], sortKeys: {} },
})

function seedListed(db: PluginsDb, name: string): void {
  const now = Date.now()
  const packageId = newId('plg')
  const versionId = newId('plv')
  insertPackage(db, {
    id: packageId, name, kind: 'bundle', origin: 'admin', ownerUserId: null, claimedAt: now,
    display: DISPLAY, iconSha512: null, createdAt: now,
  })
  insertVersion(db, {
    id: versionId, packageId, version: '1.0.0', source: JSON.stringify({ type: 'upload' }),
    state: 'approved', mirrorState: 'ready', mirrorError: null,
    artifactSha512: createHash('sha512').update(name).digest('hex'),
    upstreamIntegrity: null, sizeBytes: 12, enginesDsh: null,
    installScripts: '[]', allowedBuilds: '[]',
    requestedBy: 'admin', requestNote: '', reviewedBy: 'admin', reviewedAt: now, reviewNote: null, createdAt: now,
  })
  db.db.prepare(
    `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
     VALUES (?, ?, NULL, 1, 'admin', ?)`,
  ).run(packageId, versionId, now)
  db.db.prepare(
    'INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)',
  ).run(packageId, 'company', '*')
}

describe('plugins profile config', () => {
  it('example_plugins_json_ports_market_passes_validator', () => {
    const raw = JSON.parse(readFileSync(join(deployNativeConfig, 'plugins.json.example'), 'utf8')) as {
      database: string
      storeDir: string
      ports: { market: { min: number; max: number } }
      controlSocket: string
    }
    const parsed = parsePluginsProfileConfig({
      database: raw.database,
      storeDir: raw.storeDir,
      ports: raw.ports,
      controlSocket: raw.controlSocket,
    })
    expect(parsed.ports.market).toEqual({ min: 28_672, max: 32_767 })
    expect(parsed.controlSocket).toBe('/run/dsh-plugins/control.sock')
    expect(parsed.ports.market.max - parsed.ports.market.min + 1).toBe(4096)
  })

  it('validates_ports_market_and_requires_controlSocket', () => {
    const base = {
      database: '/var/lib/dsh-plugins/plugins.sqlite',
      storeDir: '/var/lib/dsh-plugins/store',
      ports: { market: { min: 30_000, max: 30_099 } },
      controlSocket: '/run/dsh-plugins/control.sock',
      listenPort: 30_000,
    }
    expect(parsePluginsProfileConfig(base).ports.market).toEqual({ min: 30_000, max: 30_099 })
    expect(() => parsePluginsProfileConfig({
      ...base,
      ports: { market: { min: 10_000, max: 10_000 + 4096 } },
    })).toThrow(/4096|ports\.market/)
    expect(() => parsePluginsProfileConfig({
      database: base.database,
      storeDir: base.storeDir,
      ports: base.ports,
    })).toThrow(/controlSocket|exactly/)
  })
})

describe('production market server peerCheck', () => {
  it('productionMarketListenOptions_always_includes_peerCheck_and_defaultLookup', () => {
    const db = fixtureDb()
    const options = productionMarketListenOptions(db, {
      port: 0,
      lookup: () => undefined,
      buildIndex: () => ({ format: 1, plugins: [] }),
      lookupPackument: () => undefined,
      lookupTarball: () => undefined,
    })
    expect(options.host).toBe('127.0.0.1')
    expect(options.peerCheck).toBeDefined()
    expect(typeof options.peerCheck!.ownerUidForPort).toBe('function')
    expect(options.peerLookup).toBeDefined()
  })

  it('startProductionMarketServer_constructs_server_with_peerCheck_enforced', async () => {
    const db = fixtureDb()
    db.db.prepare(
      `INSERT INTO plugin_endpoint (user_id, port, instance_id, account_uid, token_sha256, opened_at, last_report)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run('user-a', 0, 'inst-a', 4242, 'deadbeef', Date.now())

    let sawPeerHook = false
    const server = await startProductionMarketServer(db, {
      port: 0,
      lookup: () => ({ userId: 'user-a', accountUid: 4242, tokenSha256: 'deadbeef' }),
      buildIndex: () => ({ format: 1, plugins: [] }),
      lookupPackument: () => undefined,
      lookupTarball: () => undefined,
      peerCheckOverride: {
        ownerUidForPort: (port) => {
          sawPeerHook = true
          void port
          return 4242
        },
        lookupPeerUid: () => ({ ok: true, uid: 4242, method: 'inet_diag' as const }),
      },
    })
    closers.push(() => server.close())

    const response = await fetch(`http://127.0.0.1:${server.port}/index.json`)
    expect(response.status).toBe(200)
    expect(sawPeerHook).toBe(true)
  })
})

describe('B1 startProductionPlugins catalogue + refuse stub', () => {
  it('refuses_start_without_LISTEN_FDS_or_listenPort', async () => {
    const root = fixtureRoot()
    const database = join(root, 'plugins.sqlite')
    const storeDir = join(root, 'store')
    mkdirSync(storeDir)
    await expect(startProductionPlugins({
      config: {
        database,
        storeDir,
        ports: { market: { min: 31_000, max: 31_003 } },
        controlSocket: join(root, 'control.sock'),
      },
      env: {},
    })).rejects.toThrow(/LISTEN_FDS|listenPort|empty-stub/)
  })

  it('GET_index_json_serves_non_empty_catalogue_from_db_listings', async () => {
    const root = fixtureRoot()
    const database = join(root, 'plugins.sqlite')
    const storeDir = join(root, 'store')
    mkdirSync(storeDir)
    const db = openPluginsDb(database)
    const name = `${COMPANY_SCOPE_PREFIX}demo-market`
    seedListed(db, name)
    const opened = openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-a',
      accountUid: 2201,
      ports: { min: 31_010, max: 31_019 },
    })
    db.close()

    const assembly = await startProductionPlugins({
      config: {
        database,
        storeDir,
        ports: { market: { min: 31_010, max: 31_019 } },
        controlSocket: join(root, 'control.sock'),
        listenPort: opened.port,
      },
      env: {},
      peerCheckOverride: {
        ownerUidForPort: () => 2201,
        lookupPeerUid: () => ({ ok: true, uid: 2201, method: 'inet_diag' as const }),
      },
    })
    closers.push(() => assembly.close())

    expect(assembly.marketServers).toHaveLength(1)
    const response = await fetch(`http://127.0.0.1:${assembly.marketServers[0]!.port}/index.json`)
    expect(response.status).toBe(200)
    const index = await response.json() as { format: number; plugins: Array<{ name: string }> }
    expect(index.format).toBe(1)
    expect(index.plugins.some(p => p.name === name)).toBe(true)
  })

  it('starts_control_socket_alongside_catalogue', async () => {
    const root = fixtureRoot()
    const database = join(root, 'plugins.sqlite')
    const storeDir = join(root, 'store')
    mkdirSync(storeDir)
    const controlSocket = join(root, 'control.sock')
    const assembly = await startProductionPlugins({
      config: {
        database,
        storeDir,
        ports: { market: { min: 31_020, max: 31_029 } },
        controlSocket,
        listenPort: 0,
      },
      env: {},
      peerCheckOverride: {
        ownerUidForPort: () => 1,
        lookupPeerUid: () => ({ ok: true, uid: 1, method: 'inet_diag' as const }),
      },
    })
    closers.push(() => assembly.close())
    expect(assembly.control.path).toBe(controlSocket)
    expect(assembly.marketServers).toHaveLength(1)
  })
})
