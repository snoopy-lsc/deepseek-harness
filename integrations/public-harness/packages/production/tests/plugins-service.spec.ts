import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '@public-harness/plugins'
import {
  parsePluginsProfileConfig,
  productionMarketListenOptions,
  startProductionMarketServer,
} from '../src/plugins-service.ts'

const roots: string[] = []
const dbs: PluginsDb[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureDb(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-svc-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  dbs.push(db)
  return db
}

const deployNativeConfig = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/native/config',
)

describe('plugins profile config', () => {
  it('example_plugins_json_ports_market_passes_validator', () => {
    const raw = JSON.parse(readFileSync(join(deployNativeConfig, 'plugins.json.example'), 'utf8')) as {
      database: string
      storeDir: string
      ports: { market: { min: number; max: number } }
    }
    // Profile parser is strict on keys; example also documents egress which is owned by the egress service.
    const parsed = parsePluginsProfileConfig({
      database: raw.database,
      storeDir: raw.storeDir,
      ports: raw.ports,
    })
    expect(parsed.ports.market).toEqual({ min: 28_672, max: 32_767 })
    expect(parsed.ports.market.max - parsed.ports.market.min + 1).toBe(4096)
  })

  it('validates_ports_market_and_refuses_oversized_or_out_of_range', () => {
    const base = {
      database: '/var/lib/dsh-plugins/plugins.sqlite',
      storeDir: '/var/lib/dsh-plugins/store',
      ports: { market: { min: 30_000, max: 30_099 } },
      listenPort: 30_000,
    }
    expect(parsePluginsProfileConfig(base).ports.market).toEqual({ min: 30_000, max: 30_099 })
    expect(() => parsePluginsProfileConfig({
      ...base,
      ports: { market: { min: 10_000, max: 10_000 + 4096 } },
    })).toThrow(/4096|ports\.market/)
    expect(() => parsePluginsProfileConfig({
      ...base,
      ports: { market: { min: 500, max: 600 } },
    })).toThrow()
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
      // Inject hooks so we can prove the peerCheck path is active without live inet_diag.
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
