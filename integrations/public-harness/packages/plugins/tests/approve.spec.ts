/** Path A: approve / reject with artifact pin (design § Listing flows). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { listPendingAudit } from '../src/audit.ts'
import { submitPluginVersion } from '../src/submit.ts'
import {
  ApproveError,
  approveSubmission,
  rejectSubmission,
} from '../src/approve.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-approve-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}approve-demo`
const SHA_A = 'a'.repeat(128)
const SHA_B = 'b'.repeat(128)
const SHA_C = 'c'.repeat(128)

function npmSource(name: string, version: string) {
  return { type: 'npm' as const, registry: 'https://registry.npmjs.org', name, version }
}

/** Submit then mark mirror ready with a known artifact digest (fetch lands later). */
function submitReady(
  db: PluginsDb,
  opts: {
    userId?: string
    name?: string
    version: string
    artifactSha512?: string
    installScripts?: string
    closureScripts?: Array<{ name: string; version: string; installScript: string | null }>
  },
): { packageId: string; versionId: string } {
  const name = opts.name ?? CORP
  const userId = opts.userId ?? 'user-a'
  const result = submitPluginVersion({
    db,
    userId,
    name,
    version: opts.version,
    source: npmSource(name, opts.version),
  })
  const sha = opts.artifactSha512 ?? SHA_A
  db.db.prepare(
    `UPDATE plugin_version SET mirror_state = 'ready', artifact_sha512 = ?, install_scripts = ?
     WHERE id = ?`,
  ).run(sha, opts.installScripts ?? '[]', result.versionId)

  if (opts.closureScripts) {
    const insert = db.db.prepare(
      `INSERT INTO plugin_closure (version_id, name, version, integrity, install_script)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const entry of opts.closureScripts) {
      insert.run(result.versionId, entry.name, entry.version, 'sha512-dGVzdA==', entry.installScript)
    }
  }
  return result
}

describe('self-approval', () => {
  it('refuses_when_admin_is_the_submitter', () => {
    const db = fixture()
    const { versionId } = submitReady(db, { version: '1.0.0', userId: 'admin-same' })
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-same',
      versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
    })).toThrow(ApproveError)
    try {
      approveSubmission({
        db,
        adminUserId: 'admin-same',
        versionId,
        expectedArtifactSha512: SHA_A,
        scope: { kind: 'company', target: '*' },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(ApproveError)
      expect((error as ApproveError).code).toBe('self-approval')
      expect((error as ApproveError).status).toBe(403)
    }
  })
})

describe('artifact binding', () => {
  it('refuses_artifact_mismatch', () => {
    const db = fixture()
    const { versionId } = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId,
      expectedArtifactSha512: SHA_B,
      scope: { kind: 'company', target: '*' },
    })).toThrow(/artifact-mismatch/)
  })

  it('refuses_mirror_not_ready', () => {
    const db = fixture()
    const submitted = submitPluginVersion({
      db, userId: 'user-a', name: CORP, version: '1.0.1',
      source: npmSource(CORP, '1.0.1'),
    })
    // still queued — no artifact
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId: submitted.versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
    })).toThrow(/mirror-not-ready/)

    db.db.prepare(
      `UPDATE plugin_version SET mirror_state = 'failed', mirror_error = 'boom' WHERE id = ?`,
    ).run(submitted.versionId)
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId: submitted.versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
    })).toThrow(/mirror-not-ready/)
  })
})

describe('install-scripts allow-list', () => {
  it('refuses_when_closure_has_scripts_not_in_allowed_builds', () => {
    const db = fixture()
    const { versionId } = submitReady(db, {
      version: '1.0.2',
      installScripts: JSON.stringify([{ name: 'left-pad', version: '1.0.0', installScript: 'install' }]),
      closureScripts: [
        { name: 'left-pad', version: '1.0.0', installScript: 'install' },
        { name: 'clean-dep', version: '2.0.0', installScript: null },
      ],
    })
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
      allowedBuilds: [],
    })).toThrow(/install-scripts/)

    // allowing the wrong package still fails
    expect(() => approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
      allowedBuilds: ['clean-dep'],
    })).toThrow(/install-scripts/)
  })

  it('succeeds_when_each_script_package_is_allowed', () => {
    const db = fixture()
    const { versionId, packageId } = submitReady(db, {
      version: '1.0.3',
      installScripts: JSON.stringify([{ name: 'left-pad', version: '1.0.0', installScript: 'postinstall' }]),
      closureScripts: [
        { name: 'left-pad', version: '1.0.0', installScript: 'postinstall' },
      ],
    })
    const result = approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'company', target: '*' },
      allowedBuilds: ['left-pad'],
    })
    expect(result.state).toBe('approved')
    const ver = db.db.prepare('SELECT allowed_builds FROM plugin_version WHERE id = ?').get(versionId) as {
      allowed_builds: string
    }
    expect(JSON.parse(ver.allowed_builds)).toEqual(['left-pad'])
    const audits = listPendingAudit(db)
    expect(audits.some(a => a.event === 'admin-plugin-approve')).toBe(true)
    expect(audits.some(a => a.event === 'admin-plugin-build-allow')).toBe(true)
    const listing = db.db.prepare('SELECT current_version_id FROM plugin_listing WHERE package_id = ?').get(packageId)
    expect(listing).toBeDefined()
  })
})

describe('approve success sets reviewed claimed listing and audit', () => {
  it('first_approval_claims_name_lists_and_audits', () => {
    const db = fixture()
    const now = 1_700_000_000_000
    const { versionId, packageId } = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })

    const result = approveSubmission({
      db,
      adminUserId: 'admin-1',
      versionId,
      expectedArtifactSha512: SHA_A,
      scope: { kind: 'group', target: 'eng' },
      reviewNote: 'looks good',
      now,
    })
    expect(result).toMatchObject({
      packageId, versionId, state: 'approved', madeCurrent: true, claimed: true,
    })

    const pkg = db.db.prepare('SELECT claimed_at, owner_user_id FROM plugin_package WHERE id = ?').get(packageId) as {
      claimed_at: number | null; owner_user_id: string | null
    }
    expect(pkg.claimed_at).toBe(now)
    expect(pkg.owner_user_id).toBe('user-a')

    const ver = db.db.prepare(
      'SELECT state, reviewed_by, reviewed_at, review_note FROM plugin_version WHERE id = ?',
    ).get(versionId) as {
      state: string; reviewed_by: string; reviewed_at: number; review_note: string | null
    }
    expect(ver).toMatchObject({
      state: 'approved', reviewed_by: 'admin-1', reviewed_at: now, review_note: 'looks good',
    })

    const listing = db.db.prepare(
      'SELECT current_version_id, previous_version_id, generation, listed_by FROM plugin_listing WHERE package_id = ?',
    ).get(packageId) as {
      current_version_id: string; previous_version_id: string | null; generation: number; listed_by: string
    }
    expect(listing).toMatchObject({
      current_version_id: versionId, previous_version_id: null, generation: 1, listed_by: 'admin-1',
    })

    const scope = db.db.prepare('SELECT kind, target FROM plugin_scope WHERE package_id = ?').get(packageId) as {
      kind: string; target: string
    }
    expect(scope).toEqual({ kind: 'group', target: 'eng' })

    const artifact = db.db.prepare('SELECT sha512 FROM plugin_artifact WHERE name = ? AND version = ?').get(CORP, '1.0.0') as {
      sha512: string
    }
    expect(artifact.sha512).toBe(SHA_A)

    const history = db.db.prepare(
      'SELECT action, by FROM plugin_listing_history WHERE package_id = ?',
    ).all(packageId) as Array<{ action: string; by: string }>
    expect(history).toEqual([{ action: 'list', by: 'admin-1' }])

    const audits = listPendingAudit(db)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ event: 'admin-plugin-approve', outcome: 'ok', actor: 'admin-1' })
    const detail = JSON.parse(audits[0]!.detail) as Record<string, unknown>
    expect(detail).toMatchObject({ package: CORP, version: '1.0.0', artifactSha512: SHA_A })
  })
})

describe('listing current / previous pointers', () => {
  it('newer_version_becomes_current_and_old_moves_to_previous', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    approveSubmission({
      db, adminUserId: 'admin-1', versionId: first.versionId,
      expectedArtifactSha512: SHA_A, scope: { kind: 'company', target: '*' },
    })

    const second = submitReady(db, { version: '2.0.0', artifactSha512: SHA_B })
    const result = approveSubmission({
      db, adminUserId: 'admin-2', versionId: second.versionId,
      expectedArtifactSha512: SHA_B, scope: { kind: 'company', target: '*' },
    })
    expect(result.madeCurrent).toBe(true)
    expect(result.claimed).toBe(false)

    const listing = db.db.prepare(
      'SELECT current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
    ).get(first.packageId) as {
      current_version_id: string; previous_version_id: string | null; generation: number
    }
    expect(listing.current_version_id).toBe(second.versionId)
    expect(listing.previous_version_id).toBe(first.versionId)
    expect(listing.generation).toBe(2)

    const history = db.db.prepare(
      'SELECT action FROM plugin_listing_history WHERE package_id = ? ORDER BY id',
    ).all(first.packageId) as Array<{ action: string }>
    expect(history.map(h => h.action)).toEqual(['list', 'update'])
  })

  it('lower_or_equal_version_approves_into_history_only', () => {
    const db = fixture()
    // Seed current at 2.0.0 by approving it first, then approve 1.5.0
    const high = submitReady(db, { version: '2.0.0', artifactSha512: SHA_A })
    approveSubmission({
      db, adminUserId: 'admin-1', versionId: high.versionId,
      expectedArtifactSha512: SHA_A, scope: { kind: 'company', target: '*' },
    })

    const low = submitReady(db, { version: '1.5.0', artifactSha512: SHA_C })
    const result = approveSubmission({
      db, adminUserId: 'admin-1', versionId: low.versionId,
      expectedArtifactSha512: SHA_C, scope: { kind: 'company', target: '*' },
    })
    expect(result.madeCurrent).toBe(false)
    expect(result.state).toBe('approved')

    const listing = db.db.prepare(
      'SELECT current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
    ).get(high.packageId) as {
      current_version_id: string; previous_version_id: string | null; generation: number
    }
    expect(listing.current_version_id).toBe(high.versionId)
    expect(listing.previous_version_id).toBeNull()
    expect(listing.generation).toBe(1)

    const ver = db.db.prepare('SELECT state FROM plugin_version WHERE id = ?').get(low.versionId) as { state: string }
    expect(ver.state).toBe('approved')
  })
})

describe('reject', () => {
  it('rejects_pending_writes_audit_and_frees_version_for_resubmit', () => {
    const db = fixture()
    const first = submitReady(db, { version: '3.0.0', artifactSha512: SHA_A })
    rejectSubmission({
      db, adminUserId: 'admin-1', versionId: first.versionId, reason: 'needs work', now: 42,
    })

    const ver = db.db.prepare(
      'SELECT state, reviewed_by, reviewed_at, review_note FROM plugin_version WHERE id = ?',
    ).get(first.versionId) as {
      state: string; reviewed_by: string; reviewed_at: number; review_note: string | null
    }
    expect(ver).toMatchObject({
      state: 'rejected', reviewed_by: 'admin-1', reviewed_at: 42, review_note: 'needs work',
    })

    const pkg = db.db.prepare('SELECT owner_user_id, claimed_at FROM plugin_package WHERE id = ?').get(first.packageId) as {
      owner_user_id: string | null; claimed_at: number | null
    }
    expect(pkg.owner_user_id).toBeNull()
    expect(pkg.claimed_at).toBeNull()

    const audits = listPendingAudit(db)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ event: 'admin-plugin-reject', actor: 'admin-1' })
    expect(JSON.parse(audits[0]!.detail)).toMatchObject({
      package: CORP, version: '3.0.0', reason: 'needs work',
    })

    // same version number may be submitted again by anyone (name released)
    const again = submitPluginVersion({
      db, userId: 'user-b', name: CORP, version: '3.0.0',
      source: npmSource(CORP, '3.0.0'),
    })
    expect(again.packageId).toBe(first.packageId)
    expect(again.versionId).not.toBe(first.versionId)
  })

  it('refuses_when_not_pending', () => {
    const db = fixture()
    const first = submitReady(db, { version: '3.1.0', artifactSha512: SHA_A })
    rejectSubmission({ db, adminUserId: 'admin-1', versionId: first.versionId })
    expect(() => rejectSubmission({
      db, adminUserId: 'admin-1', versionId: first.versionId,
    })).toThrow(/not-pending/)
  })
})
