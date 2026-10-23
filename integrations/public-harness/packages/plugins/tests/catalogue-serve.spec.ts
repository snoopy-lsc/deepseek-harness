/** B1: catalogue adapters produce non-empty index / packument from DB listings. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { newId } from '../src/ids.ts'
import { insertPackage, insertVersion } from '../src/migrate.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { blobPath } from '../src/mirror/store.ts'
import {
  buildCataloguePackument,
  createCatalogueMarketRouteDeps,
  lookupCatalogueTarball,
} from '../src/catalogue-serve.ts'
import { openEndpoint, startMarketHttpServer, type MarketHttpServer } from '../src/listen.ts'

const roots: string[] = []
const opened: PluginsDb[] = []
const servers: MarketHttpServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const DISPLAY = JSON.stringify({
  title: { en: 'Demo' }, description: { en: 'd' }, author: 'corp',
  homepage: '', repository: '', metadata: { category: 'tools', keywords: [], labels: [], sortKeys: {} },
})

function seed(db: PluginsDb, storeDir: string, name: string): { sha: string; bytes: Buffer } {
  const now = Date.now()
  const packageId = newId('plg')
  const versionId = newId('plv')
  const bytes = Buffer.from('fake-tarball-bytes')
  const sha = createHash('sha512').update(bytes).digest('hex')
  mkdirSync(join(storeDir, 'sha512'), { recursive: true })
  writeFileSync(blobPath(storeDir, sha), bytes)
  insertPackage(db, {
    id: packageId, name, kind: 'bundle', origin: 'admin', ownerUserId: null, claimedAt: now,
    display: DISPLAY, iconSha512: null, createdAt: now,
  })
  insertVersion(db, {
    id: versionId, packageId, version: '1.2.3', source: JSON.stringify({ type: 'upload' }),
    state: 'approved', mirrorState: 'ready', mirrorError: null,
    artifactSha512: sha, upstreamIntegrity: null, sizeBytes: bytes.byteLength, enginesDsh: null,
    installScripts: '[]', allowedBuilds: '[]',
    requestedBy: 'admin', requestNote: '', reviewedBy: 'admin', reviewedAt: now, reviewNote: null, createdAt: now,
  })
  db.db.prepare(
    `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
     VALUES (?, ?, NULL, 1, 'admin', ?)`,
  ).run(packageId, versionId, now)
  db.db.prepare('INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)').run(packageId, 'company', '*')
  return { sha, bytes }
}

describe('catalogue-serve', () => {
  it('packument_and_tarball_and_index_via_route_deps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-catalogue-'))
    roots.push(root)
    const storeDir = join(root, 'store')
    const db = openPluginsDb(join(root, 'plugins.sqlite'))
    opened.push(db)
    const name = `${COMPANY_SCOPE_PREFIX}cat`
    const { bytes } = seed(db, storeDir, name)
    const openedEp = openEndpoint(db, {
      userId: 'u1', instanceId: 'i1', accountUid: 2400, ports: { min: 31_200, max: 31_209 },
    })
    const deps = createCatalogueMarketRouteDeps({
      db,
      storeDir,
      listenPort: openedEp.port,
      registryUrlFor: () => `http://127.0.0.1:${openedEp.port}/npm/`,
      groupsFor: () => [],
    })
    const index = deps.buildIndex('u1')
    expect(index.plugins.some(p => p.name === name)).toBe(true)

    const packument = buildCataloguePackument(db, name, 'u1', [], `http://127.0.0.1:${openedEp.port}/npm/`) as {
      versions: Record<string, unknown>
    }
    expect(packument).toBeDefined()
    expect(packument.versions['1.2.3']).toBeDefined()

    const tarball = lookupCatalogueTarball(db, storeDir, name, '1.2.3', [])
    expect(tarball?.equals(bytes)).toBe(true)

    const server = await startMarketHttpServer({
      host: '127.0.0.1',
      port: openedEp.port,
      ...deps,
    })
    servers.push(server)
    const res = await fetch(`http://127.0.0.1:${server.port}/index.json`)
    expect(res.status).toBe(200)
    const body = await res.json() as { plugins: Array<{ name: string }> }
    expect(body.plugins.some(p => p.name === name)).toBe(true)
  })
})
