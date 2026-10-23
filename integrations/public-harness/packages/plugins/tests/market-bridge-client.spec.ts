/** S3: MarketBridge HTTP client over plugins control socket. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { seedPluginLimits } from '../src/limits.ts'
import { startPluginsControlServer, type PluginsControlServer } from '../src/control-server.ts'
import { createPluginsMarketBridge } from '../src/market-bridge-client.ts'

const roots: string[] = []
const opened: PluginsDb[] = []
const servers: PluginsControlServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('createPluginsMarketBridge', () => {
  it('open_and_close_round_trip_via_control_socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mbridge-'))
    roots.push(root)
    const db = openPluginsDb(join(root, 'plugins.sqlite'))
    opened.push(db)
    seedPluginLimits(db)
    const socketPath = join(root, 'control.sock')
    const control = await startPluginsControlServer(
      { db, storeDir: join(root, 'store'), ports: { min: 31_300, max: 31_309 } },
      { path: socketPath },
    )
    servers.push(control)

    const bridge = createPluginsMarketBridge(socketPath)
    const openedEp = await bridge.open('user-x', 'inst-x', 2500)
    expect(openedEp.port).toBeGreaterThanOrEqual(31_300)
    expect(openedEp.token.length).toBeGreaterThanOrEqual(32)

    const row = db.db.prepare('SELECT user_id, instance_id FROM plugin_endpoint WHERE user_id = ?').get('user-x') as
      | { user_id: string; instance_id: string }
      | undefined
    expect(row?.instance_id).toBe('inst-x')

    await bridge.close('user-x')
    const after = db.db.prepare('SELECT instance_id, token_sha256 FROM plugin_endpoint WHERE user_id = ?').get('user-x') as
      | { instance_id: string | null; token_sha256: string | null }
      | undefined
    expect(after?.instance_id).toBeNull()
    expect(after?.token_sha256).toBeNull()
  })
})
