/** Catalogue schema: partial unique indexes, artifact uniqueness, and name release. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '../src/ids.ts'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX, MAX_PLUGIN_ACCOUNTS } from '../src/schema.ts'
import { insertArtifact, insertPackage, insertVersion, releaseUnclaimedName, setVersionState } from '../src/migrate.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}demo-skill`
const DISPLAY = JSON.stringify({ title: 'Demo', description: '', author: '', homepage: '', repository: '', metadata: {} })
const SOURCE = JSON.stringify({ type: 'upload' })

function addPackage(db: PluginsDb, name: string, owner: string | null, now: number) {
  const id = newId('plg')
  insertPackage(db, {
    id, name, kind: 'skill', origin: 'submitted', ownerUserId: owner, claimedAt: null,
    display: DISPLAY, iconSha512: null, createdAt: now,
  })
  return id
}

function addVersion(
  db: PluginsDb,
  packageId: string,
  version: string,
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'revoked',
  requestedBy: string,
  now: number,
) {
  const id = newId('plv')
  insertVersion(db, {
    id, packageId, version, source: SOURCE, state,
    mirrorState: state === 'approved' ? 'ready' : 'queued',
    mirrorError: null, artifactSha512: null, upstreamIntegrity: null, sizeBytes: null,
    enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
    requestedBy, requestNote: '', reviewedBy: null, reviewedAt: null, reviewNote: null, createdAt: now,
  })
  return id
}

describe('plugin catalogue schema', () => {
  it('keeps name@version mapped to one artifact sha512', () => {
    const db = fixture()
    insertArtifact(db, { name: CORP, version: '1.0.0', sha512: 'a'.repeat(128) })
    expect(() => insertArtifact(db, { name: CORP, version: '1.0.0', sha512: 'b'.repeat(128) })).toThrow()
    const row = db.db.prepare('SELECT sha512 FROM plugin_artifact WHERE name = ? AND version = ?').get(CORP, '1.0.0') as { sha512: string }
    expect(row.sha512).toBe('a'.repeat(128))
  })

  it('allows at most one pending version per package', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = addPackage(db, CORP, 'user-a', now)
    addVersion(db, packageId, '1.0.0', 'pending', 'user-a', now)
    expect(() => addVersion(db, packageId, '1.0.1', 'pending', 'user-a', now + 1)).toThrow()
  })

  it('lets a rejected, withdrawn, or expired version number be submitted again', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = addPackage(db, CORP, 'user-a', now)
    for (const [version, endState] of [['1.0.0', 'rejected'], ['1.0.1', 'withdrawn'], ['1.0.2', 'expired']] as const) {
      const id = addVersion(db, packageId, version, 'pending', 'user-a', now)
      setVersionState(db, id, endState)
      const again = addVersion(db, packageId, version, 'pending', 'user-a', now + 1)
      expect(again).toMatch(/^plv_/)
      setVersionState(db, again, endState)
    }
  })

  it('releases an unclaimed name when the first version never approved', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = addPackage(db, CORP, 'user-a', now)
    const versionId = addVersion(db, packageId, '1.0.0', 'pending', 'user-a', now)
    setVersionState(db, versionId, 'rejected')
    expect(releaseUnclaimedName(db, packageId)).toBe(true)
    const row = db.db.prepare('SELECT owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(packageId) as {
      owner_user_id: string | null; claimed_at: number | null
    }
    expect(row.owner_user_id).toBeNull()
    expect(row.claimed_at).toBeNull()
    db.db.prepare('UPDATE plugin_package SET owner_user_id = ? WHERE id = ?').run('user-b', packageId)
    const next = addVersion(db, packageId, '1.0.0', 'pending', 'user-b', now + 2)
    expect(next).toMatch(/^plv_/)
  })

  it('does not release a claimed name after approval', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = addPackage(db, CORP, 'user-a', now)
    const versionId = addVersion(db, packageId, '1.0.0', 'pending', 'user-a', now)
    setVersionState(db, versionId, 'approved')
    db.db.prepare('UPDATE plugin_package SET claimed_at = ? WHERE id = ?').run(now + 1, packageId)
    expect(releaseUnclaimedName(db, packageId)).toBe(false)
    const row = db.db.prepare('SELECT owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(packageId) as {
      owner_user_id: string | null; claimed_at: number | null
    }
    expect(row.owner_user_id).toBe('user-a')
    expect(row.claimed_at).toBe(now + 1)
  })

  it('exposes company scope prefix and 4096 account cap constants', () => {
    expect(COMPANY_SCOPE_PREFIX).toBe('@corp-dsh/')
    expect(MAX_PLUGIN_ACCOUNTS).toBe(4096)
  })
})
