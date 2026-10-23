/** Path B: admin upload + plugin_audit_outbox (company scope, version-exists). */
import { gzipSync } from 'node:zlib'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { insertArtifact, insertPackage, insertVersion } from '../src/migrate.ts'
import { newId } from '../src/ids.ts'
import { sha512Integrity, type ClosurePackage } from '../src/mirror/index.ts'
import { adminUpload, UploadError, assertCompanyPluginName } from '../src/upload.ts'
import { listPendingAudit } from '../src/audit.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upload-'))
  roots.push(root)
  return root
}

function fixtureDb(): { root: string; db: PluginsDb; storeRoot: string } {
  const root = tmp()
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return { root, db, storeRoot: join(root, 'store') }
}

/** Minimal ustar of regular files under a package/ prefix (npm pack layout). */
function writeUstar(files: { path: string; data: Buffer | string }[]): Buffer {
  const parts: Buffer[] = []
  const pad = (data: Buffer) => (data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))]))
  for (const file of files) {
    const data = typeof file.data === 'string' ? Buffer.from(file.data) : file.data
    const name = file.path.slice(0, 99)
    const block = Buffer.alloc(512)
    block.write(name, 0, 'utf8')
    block.write('0000644\0', 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    block.write('00000000000\0', 136, 'ascii')
    block.fill(0x20, 148, 156)
    block.write('0', 156, 'ascii')
    block.write('ustar\0', 257, 'ascii')
    block.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    parts.push(block, pad(data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function npmTgz(manifest: object, extra: { path: string; data: Buffer | string }[] = []): Buffer {
  const pkg = Buffer.from(JSON.stringify(manifest, null, 2))
  return gzipSync(writeUstar([{ path: 'package/package.json', data: pkg }, ...extra.map(e => ({ path: `package/${e.path}`, data: e.data }))]))
}

describe('company scope', () => {
  it('rejects_non_corp_dsh_upload_tarball', async () => {
    const { db, storeRoot } = fixtureDb()
    const tarball = npmTgz({ name: 'left-pad', version: '1.0.0' })
    await expect(adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })).rejects.toThrow(UploadError)
    await expect(adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })).rejects.toThrow(/scope/)
  })

  it('rejects_non_corp_dsh_git_package_name', () => {
    expect(() => assertCompanyPluginName('left-pad')).toThrow(UploadError)
    expect(() => assertCompanyPluginName('left-pad')).toThrow(/scope/)
    expect(() => assertCompanyPluginName('@other/pkg')).toThrow(/scope/)
    assertCompanyPluginName(`${COMPANY_SCOPE_PREFIX}ok`)
  })
})

describe('version-exists', () => {
  it('refuses_when_live_version_or_artifact_already_present', async () => {
    const { db, storeRoot } = fixtureDb()
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    const version = '1.0.0'
    const now = Date.now()
    const packageId = newId('plg')
    insertPackage(db, {
      id: packageId, name, kind: 'bundle', origin: 'admin', ownerUserId: null, claimedAt: now,
      display: JSON.stringify({ title: 'Demo', description: '', author: '', homepage: '', repository: '', metadata: {} }),
      iconSha512: null, createdAt: now,
    })
    insertVersion(db, {
      id: newId('plv'), packageId, version, source: JSON.stringify({ type: 'upload' }),
      state: 'approved', mirrorState: 'ready', mirrorError: null,
      artifactSha512: 'a'.repeat(128), upstreamIntegrity: null, sizeBytes: 1,
      enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
      requestedBy: 'admin-0', requestNote: '', reviewedBy: 'admin-0', reviewedAt: now, reviewNote: null, createdAt: now,
    })
    insertArtifact(db, { name, version, sha512: 'a'.repeat(128) })

    const tarball = npmTgz({ name, version })
    await expect(adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })).rejects.toThrow(UploadError)
    await expect(adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })).rejects.toThrow(/version-exists/)
  })
})

describe('admin-plugin-upload audit', () => {
  it('writes_outbox_row_and_stores_frozen_artifact_via_mirror', async () => {
    const { db, storeRoot, root } = fixtureDb()
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    const version = '1.2.3'
    const tarball = npmTgz(
      { name, version, dependencies: { 'left-pad': '^1.0.0' } },
      [{ path: 'index.js', data: 'export default 1\n' }],
    )
    const depTgz = npmTgz({ name: 'left-pad', version: '1.0.0' }, [{ path: 'index.js', data: 'module.exports = x => x\n' }])
    const closure: ClosurePackage[] = [
      { name: 'left-pad', version: '1.0.0', integrity: sha512Integrity(depTgz), installScript: null },
    ]

    const result = await adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-42',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure,
      fetchClosureTarball: async () => depTgz,
      now: 1_700_000_000_000,
    })

    expect(result.name).toBe(name)
    expect(result.version).toBe(version)
    expect(result.artifactSha512).toMatch(/^[0-9a-f]{128}$/)
    expect(result.mode).toBe('bundle')
    expect(existsSync(join(storeRoot, 'sha512', result.artifactSha512))).toBe(true)

    const versionRow = db.db.prepare(
      `SELECT state, mirror_state, artifact_sha512, requested_by, reviewed_by FROM plugin_version WHERE id = ?`,
    ).get(result.versionId) as {
      state: string; mirror_state: string; artifact_sha512: string; requested_by: string; reviewed_by: string
    }
    expect(versionRow.state).toBe('approved')
    expect(versionRow.mirror_state).toBe('ready')
    expect(versionRow.artifact_sha512).toBe(result.artifactSha512)
    expect(versionRow.requested_by).toBe('admin-42')
    expect(versionRow.reviewed_by).toBe('admin-42')

    const artifact = db.db.prepare('SELECT sha512 FROM plugin_artifact WHERE name = ? AND version = ?').get(name, version) as { sha512: string }
    expect(artifact.sha512).toBe(result.artifactSha512)

    const pkg = db.db.prepare('SELECT origin, owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(result.packageId) as {
      origin: string; owner_user_id: string | null; claimed_at: number | null
    }
    expect(pkg.origin).toBe('admin')
    expect(pkg.owner_user_id).toBeNull()
    expect(pkg.claimed_at).toBe(1_700_000_000_000)

    const listing = db.db.prepare('SELECT current_version_id, listed_by FROM plugin_listing WHERE package_id = ?').get(result.packageId) as {
      current_version_id: string; listed_by: string
    }
    expect(listing.current_version_id).toBe(result.versionId)
    expect(listing.listed_by).toBe('admin-42')

    const scope = db.db.prepare('SELECT kind, target FROM plugin_scope WHERE package_id = ?').get(result.packageId) as {
      kind: string; target: string
    }
    expect(scope).toEqual({ kind: 'company', target: '*' })

    const pending = listPendingAudit(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.event).toBe('admin-plugin-upload')
    expect(pending[0]!.outcome).toBe('ok')
    expect(pending[0]!.actor).toBe('admin-42')
    const detail = JSON.parse(pending[0]!.detail) as { package: string; version: string; sourceType: string; scope: unknown }
    expect(detail.package).toBe(name)
    expect(detail.version).toBe(version)
    expect(detail.sourceType).toBe('upload')
    expect(detail.scope).toEqual({ kind: 'company', target: '*' })
    // detail must not contain artifact bytes / tokens
    expect(pending[0]!.detail).not.toMatch(/export default/)
    expect(root).toBeTruthy()
  })
})

describe('adminUpload existing package new version', () => {
  it('reuses_package_id_and_advances_listing_for_newer_version', async () => {
    const { db, storeRoot } = fixtureDb()
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    const first = await adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball: npmTgz({ name, version: '1.0.0' }, [{ path: 'index.js', data: 'v1\n' }]) },
      closure: [],
      now: 1_700_000_000_000,
    })

    const second = await adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-2',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball: npmTgz({ name, version: '2.0.0' }, [{ path: 'index.js', data: 'v2\n' }]) },
      closure: [],
      now: 1_700_000_000_100,
    })

    expect(second.packageId).toBe(first.packageId)
    expect(second.versionId).not.toBe(first.versionId)
    expect(second.version).toBe('2.0.0')

    const packages = db.db.prepare('SELECT COUNT(*) AS n FROM plugin_package WHERE name = ?').get(name) as { n: number }
    expect(packages.n).toBe(1)

    const listing = db.db.prepare(
      'SELECT current_version_id, previous_version_id, generation, listed_by FROM plugin_listing WHERE package_id = ?',
    ).get(first.packageId) as {
      current_version_id: string
      previous_version_id: string | null
      generation: number
      listed_by: string
    }
    expect(listing.current_version_id).toBe(second.versionId)
    expect(listing.previous_version_id).toBe(first.versionId)
    expect(listing.generation).toBe(2)
    expect(listing.listed_by).toBe('admin-2')

    const scopes = db.db.prepare('SELECT COUNT(*) AS n FROM plugin_scope WHERE package_id = ?').get(first.packageId) as { n: number }
    expect(scopes.n).toBe(1)

    const history = db.db.prepare(
      `SELECT action FROM plugin_listing_history WHERE package_id = ? ORDER BY at, rowid`,
    ).all(first.packageId) as Array<{ action: string }>
    expect(history.map(h => h.action)).toEqual(['list', 'update'])
  })

  it('same_name_and_version_still_version_exists', async () => {
    const { db, storeRoot } = fixtureDb()
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    const tarball = npmTgz({ name, version: '1.0.0' }, [{ path: 'index.js', data: 'v1\n' }])
    await adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })
    await expect(adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-1',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball },
      closure: [],
    })).rejects.toThrow(/version-exists/)
  })

  it('path_b_first_list_of_existing_package_upserts_plugin_scope', async () => {
    // Existing package (e.g. user-submitted) with no listing and no scope → Path B
    // first list must still write plugin_scope (not only when createdPackage).
    const { db, storeRoot } = fixtureDb()
    const name = `${COMPANY_SCOPE_PREFIX}path-b-scope`
    const now = 1_700_000_000_000
    const packageId = newId('plg')
    insertPackage(db, {
      id: packageId, name, kind: 'bundle', origin: 'submitted', ownerUserId: 'u1', claimedAt: now,
      display: JSON.stringify({ title: 'Path B', description: '', author: '', homepage: '', repository: '', metadata: {} }),
      iconSha512: null, createdAt: now,
    })
    const scopesBefore = db.db.prepare('SELECT COUNT(*) AS n FROM plugin_scope WHERE package_id = ?').get(packageId) as { n: number }
    expect(scopesBefore.n).toBe(0)

    const result = await adminUpload({
      db,
      storeRoot,
      adminUserId: 'admin-path-b',
      scope: { kind: 'company', target: '*' },
      source: { type: 'upload', tarball: npmTgz({ name, version: '1.0.0' }, [{ path: 'index.js', data: 'ok\n' }]) },
      closure: [],
      now: now + 1,
    })
    expect(result.packageId).toBe(packageId)
    const listing = db.db.prepare(
      'SELECT current_version_id FROM plugin_listing WHERE package_id = ?',
    ).get(packageId) as { current_version_id: string } | undefined
    expect(listing?.current_version_id).toBe(result.versionId)
    const scope = db.db.prepare('SELECT kind, target FROM plugin_scope WHERE package_id = ?').get(packageId) as {
      kind: string; target: string
    }
    expect(scope).toEqual({ kind: 'company', target: '*' })
  })
})
