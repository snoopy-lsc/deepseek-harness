/** Path A: submit + ownership + name release (design § Listing flows). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { insertArtifact, insertPackage, insertVersion, releaseUnclaimedName, setVersionState } from '../src/migrate.ts'
import { newId } from '../src/ids.ts'
import {
  expireSubmission,
  submitPluginVersion,
  SubmitError,
  withdrawSubmission,
} from '../src/submit.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}demo`
const DISPLAY = JSON.stringify({ title: 'Demo', description: '', author: '', homepage: '', repository: '', metadata: {} })

function npmSource(name: string, version: string) {
  return { type: 'npm' as const, registry: 'https://registry.npmjs.org', name, version }
}

describe('company scope', () => {
  it('rejects_non_corp_dsh_name', () => {
    const db = fixture()
    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: 'left-pad', version: '1.0.0',
      source: npmSource('left-pad', '1.0.0'),
    })).toThrow(SubmitError)
    try {
      submitPluginVersion({
        db, userId: 'user-a', name: 'left-pad', version: '1.0.0',
        source: npmSource('left-pad', '1.0.0'),
      })
    } catch (error) {
      expect(error).toBeInstanceOf(SubmitError)
      expect((error as SubmitError).code).toBe('scope')
    }
  })
})

describe('first version claims name', () => {
  it('sets_owner_and_leaves_claimed_at_null_with_pending_queued', () => {
    const db = fixture()
    const result = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.0',
      source: npmSource(CORP, '1.0.0'), requestNote: 'please review',
    })
    expect(result.packageId).toMatch(/^plg_/)
    expect(result.versionId).toMatch(/^plv_/)
    expect(result.state).toBe('pending')
    expect(result.mirrorState).toBe('queued')

    const pkg = db.db.prepare('SELECT owner_user_id, claimed_at, origin FROM plugin_package WHERE id = ?').get(result.packageId) as {
      owner_user_id: string | null; claimed_at: number | null; origin: string
    }
    expect(pkg.owner_user_id).toBe('user-a')
    expect(pkg.claimed_at).toBeNull()
    expect(pkg.origin).toBe('submitted')

    const ver = db.db.prepare(
      'SELECT state, mirror_state, requested_by, request_note, artifact_sha512 FROM plugin_version WHERE id = ?',
    ).get(result.versionId) as {
      state: string; mirror_state: string; requested_by: string; request_note: string; artifact_sha512: string | null
    }
    expect(ver).toMatchObject({
      state: 'pending', mirror_state: 'queued', requested_by: 'user-a', request_note: 'please review',
    })
    expect(ver.artifact_sha512).toBeNull()
  })
})

describe('pending uniqueness', () => {
  it('refuses_second_pending_on_same_package', () => {
    const db = fixture()
    submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.0',
      source: npmSource(CORP, '1.0.0'),
    })
    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })).toThrow(/pending-exists/)
  })
})

describe('withdraw expire reject allow resubmit and name release', () => {
  it('withdraw_releases_unclaimed_name_so_another_user_may_claim', () => {
    const db = fixture()
    const first = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.0',
      source: npmSource(CORP, '1.0.0'),
    })
    withdrawSubmission({ db, userId: 'user-a', versionId: first.versionId })
    const after = db.db.prepare('SELECT owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(first.packageId) as {
      owner_user_id: string | null; claimed_at: number | null
    }
    expect(after.owner_user_id).toBeNull()
    expect(after.claimed_at).toBeNull()

    const second = submitPluginVersion({
      db, userId: 'user-b', name: CORP, version: '1.0.0',
      source: npmSource(CORP, '1.0.0'),
    })
    expect(second.packageId).toBe(first.packageId)
    const pkg = db.db.prepare('SELECT owner_user_id FROM plugin_package WHERE id = ?').get(first.packageId) as { owner_user_id: string }
    expect(pkg.owner_user_id).toBe('user-b')
  })

  it('expire_releases_unclaimed_name_for_resubmit', () => {
    const db = fixture()
    const first = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })
    expireSubmission({ db, versionId: first.versionId })
    const row = db.db.prepare('SELECT state FROM plugin_version WHERE id = ?').get(first.versionId) as { state: string }
    expect(row.state).toBe('expired')
    const owner = db.db.prepare('SELECT owner_user_id FROM plugin_package WHERE id = ?').get(first.packageId) as { owner_user_id: string | null }
    expect(owner.owner_user_id).toBeNull()
    const again = submitPluginVersion({
      db, userId: 'user-c', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })
    expect(again.versionId).not.toBe(first.versionId)
  })

  it('reject_then_release_allows_resubmit', () => {
    const db = fixture()
    const first = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.2',
      source: npmSource(CORP, '1.0.2'),
    })
    setVersionState(db, first.versionId, 'rejected')
    expect(releaseUnclaimedName(db, first.packageId)).toBe(true)
    const again = submitPluginVersion({
      db, userId: 'user-d', name: CORP, version: '1.0.2',
      source: npmSource(CORP, '1.0.2'),
    })
    expect(again.packageId).toBe(first.packageId)
  })
})

describe('refuse foreign ownership', () => {
  it('name_taken_while_held_by_another_pending_owner', () => {
    const db = fixture()
    submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.0',
      source: npmSource(CORP, '1.0.0'),
    })
    expect(() => submitPluginVersion({
      db, userId: 'user-b', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })).toThrow(/name-taken/)
  })

  it('not_owner_on_claimed_package_for_foreign_user', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = newId('plg')
    insertPackage(db, {
      id: packageId, name: CORP, kind: 'bundle', origin: 'submitted',
      ownerUserId: 'user-a', claimedAt: now, display: DISPLAY, iconSha512: null, createdAt: now,
    })
    insertVersion(db, {
      id: newId('plv'), packageId, version: '1.0.0', source: JSON.stringify({ type: 'npm' }),
      state: 'approved', mirrorState: 'ready', mirrorError: null,
      artifactSha512: 'a'.repeat(128), upstreamIntegrity: null, sizeBytes: 1,
      enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
      requestedBy: 'user-a', requestNote: '', reviewedBy: 'admin-1', reviewedAt: now, reviewNote: null, createdAt: now,
    })
    insertArtifact(db, { name: CORP, version: '1.0.0', sha512: 'a'.repeat(128) })

    expect(() => submitPluginVersion({
      db, userId: 'user-b', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })).toThrow(/not-owner/)

    // owner and admin may submit a later version
    const asOwner = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })
    expect(asOwner.state).toBe('pending')
    withdrawSubmission({ db, userId: 'user-a', versionId: asOwner.versionId })
    // after withdraw of a claimed package, owner stays (claimed_at set)
    const pkg = db.db.prepare('SELECT owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(packageId) as {
      owner_user_id: string | null; claimed_at: number | null
    }
    expect(pkg.owner_user_id).toBe('user-a')
    expect(pkg.claimed_at).toBe(now)

    const asAdmin = submitPluginVersion({
      db, userId: 'admin-9', isAdmin: true, name: CORP, version: '1.0.2',
      source: npmSource(CORP, '1.0.2'),
    })
    expect(asAdmin.state).toBe('pending')
  })
})

describe('version-exists and limit-reached', () => {
  it('refuses_live_version_number', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = newId('plg')
    insertPackage(db, {
      id: packageId, name: CORP, kind: 'bundle', origin: 'submitted',
      ownerUserId: 'user-a', claimedAt: now, display: DISPLAY, iconSha512: null, createdAt: now,
    })
    insertVersion(db, {
      id: newId('plv'), packageId, version: '2.0.0', source: JSON.stringify({ type: 'npm' }),
      state: 'approved', mirrorState: 'ready', mirrorError: null,
      artifactSha512: 'b'.repeat(128), upstreamIntegrity: null, sizeBytes: 1,
      enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
      requestedBy: 'user-a', requestNote: '', reviewedBy: 'admin-1', reviewedAt: now, reviewNote: null, createdAt: now,
    })
    insertArtifact(db, { name: CORP, version: '2.0.0', sha512: 'b'.repeat(128) })

    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '2.0.0',
      source: npmSource(CORP, '2.0.0'),
    })).toThrow(/version-exists/)
  })

  it('refuses_when_max_submissions_reached', () => {
    const db = fixture()
    submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}one`, version: '1.0.0',
      source: npmSource(`${COMPANY_SCOPE_PREFIX}one`, '1.0.0'),
      limits: { maxSubmissions: 1 },
    })
    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}two`, version: '1.0.0',
      source: npmSource(`${COMPANY_SCOPE_PREFIX}two`, '1.0.0'),
      limits: { maxSubmissions: 1 },
    })).toThrow(/limit-reached/)
  })
})

describe('withdraw refusals', () => {
  it('only_submitter_may_withdraw_pending', () => {
    const db = fixture()
    const first = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '3.0.0',
      source: npmSource(CORP, '3.0.0'),
    })
    expect(() => withdrawSubmission({ db, userId: 'user-b', versionId: first.versionId })).toThrow(/not-owner/)
    withdrawSubmission({ db, userId: 'user-a', versionId: first.versionId })
    expect(() => withdrawSubmission({ db, userId: 'user-a', versionId: first.versionId })).toThrow(/not-pending/)
  })
})
