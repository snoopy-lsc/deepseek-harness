/**
 * Path A: administrator approve / reject of a pending submission.
 * Approve binds `expected_artifact_sha512`, refuses self-approval, and updates listing pointers.
 */
import { writeAuditOutbox } from './audit.ts'
import { compareSemVerDescending } from './index-builder.ts'
import { releaseUnclaimedName, type PluginsDbHandle } from './migrate.ts'
import { compareExpectedArtifactSha512, MirrorError } from './mirror/index.ts'
import type { PluginScopeSpec } from './upload.ts'

export type ApproveErrorCode =
  | 'self-approval'
  | 'mirror-not-ready'
  | 'artifact-mismatch'
  | 'install-scripts'
  | 'not-pending'
  | 'not-found'

/** Wire-facing refusal for path A approve/reject; `message` is the stable code. */
export class ApproveError extends Error {
  readonly status: number
  readonly code: ApproveErrorCode
  readonly detail: string | undefined
  constructor(code: ApproveErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (
      code === 'self-approval' ? 403
        : code === 'not-found' ? 404
          : 409
    )
  }
}

export interface ApproveInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly versionId: string
  /** Digest shown on the review page; must equal stored `artifact_sha512`. */
  readonly expectedArtifactSha512: string
  readonly scope: PluginScopeSpec
  /** Packages allowed to run install scripts; empty/default refuses any scripts. */
  readonly allowedBuilds?: readonly string[]
  readonly reviewNote?: string
  readonly now?: number
}

export interface ApproveResult {
  readonly packageId: string
  readonly versionId: string
  readonly name: string
  readonly version: string
  readonly state: 'approved'
  readonly artifactSha512: string
  /** True when this version became (or created) `plugin_listing.current_version_id`. */
  readonly madeCurrent: boolean
  /** True when this approval set `plugin_package.claimed_at` for the first time. */
  readonly claimed: boolean
  readonly auditId: number
}

export interface RejectInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly versionId: string
  readonly reason?: string
  readonly now?: number
}

interface VersionRow {
  id: string
  package_id: string
  version: string
  state: string
  mirror_state: string
  artifact_sha512: string | null
  install_scripts: string
  requested_by: string
}

interface PackageRow {
  id: string
  name: string
  claimed_at: number | null
}

interface ListingRow {
  package_id: string
  current_version_id: string
  previous_version_id: string | null
  generation: number
}

function loadVersion(db: PluginsDbHandle, versionId: string): VersionRow {
  const row = db.db.prepare(
    `SELECT id, package_id, version, state, mirror_state, artifact_sha512, install_scripts, requested_by
     FROM plugin_version WHERE id = ?`,
  ).get(versionId) as VersionRow | undefined
  if (row === undefined) throw new ApproveError('not-found', versionId)
  return row
}

function loadPackage(db: PluginsDbHandle, packageId: string): PackageRow {
  const row = db.db.prepare(
    'SELECT id, name, claimed_at FROM plugin_package WHERE id = ?',
  ).get(packageId) as PackageRow | undefined
  if (row === undefined) throw new ApproveError('not-found', packageId)
  return row
}

function assertNoUnauthorizedInstallScripts(
  db: PluginsDbHandle,
  versionId: string,
  installScriptsJson: string,
  allowedBuilds: readonly string[],
): void {
  const allowed = new Set(allowedBuilds)
  let parsed: unknown
  try {
    parsed = JSON.parse(installScriptsJson)
  } catch {
    parsed = []
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const name = (entry as { name?: unknown }).name
        const script = (entry as { installScript?: unknown }).installScript
        if (typeof name === 'string' && script != null && script !== '' && !allowed.has(name)) {
          throw new ApproveError('install-scripts', name)
        }
      } else if (typeof entry === 'string' && !allowed.has(entry)) {
        // tolerate a bare package-name list
        throw new ApproveError('install-scripts', entry)
      }
    }
  }

  const closure = db.db.prepare(
    `SELECT name, install_script FROM plugin_closure WHERE version_id = ?`,
  ).all(versionId) as Array<{ name: string; install_script: string | null }>
  for (const entry of closure) {
    if (entry.install_script != null && entry.install_script !== '' && !allowed.has(entry.name)) {
      throw new ApproveError('install-scripts', entry.name)
    }
  }
}

function isNewerThan(candidate: string, current: string): boolean {
  // Descending compare: negative means candidate sorts above current → candidate is greater.
  return compareSemVerDescending(candidate, current) < 0
}

/**
 * Approve a pending, mirrored version. Binds the reviewed artifact digest,
 * refuses self-approval, and updates listing current/previous when the version is newer.
 */
export function approveSubmission(input: ApproveInput): ApproveResult {
  const now = input.now ?? Date.now()
  const allowedBuilds = input.allowedBuilds ?? []
  const reviewNote = input.reviewNote ?? null

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const version = loadVersion(input.db, input.versionId)
    if (version.state !== 'pending') throw new ApproveError('not-pending', version.state)
    if (version.requested_by === input.adminUserId) {
      throw new ApproveError('self-approval', version.requested_by)
    }
    if (version.mirror_state !== 'ready' || version.artifact_sha512 == null || version.artifact_sha512 === '') {
      throw new ApproveError('mirror-not-ready', version.mirror_state)
    }

    try {
      compareExpectedArtifactSha512(input.expectedArtifactSha512, version.artifact_sha512)
    } catch (error) {
      if (error instanceof MirrorError && error.message === 'artifact-mismatch') {
        throw new ApproveError('artifact-mismatch')
      }
      throw error
    }

    assertNoUnauthorizedInstallScripts(input.db, version.id, version.install_scripts, allowedBuilds)

    const pkg = loadPackage(input.db, version.package_id)
    const claimed = pkg.claimed_at === null
    if (claimed) {
      input.db.db.prepare(
        'UPDATE plugin_package SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL',
      ).run(now, pkg.id)
    }

    const allowedBuildsJson = JSON.stringify([...allowedBuilds])
    input.db.db.prepare(
      `UPDATE plugin_version SET state = 'approved', reviewed_by = ?, reviewed_at = ?,
         review_note = ?, allowed_builds = ?
       WHERE id = ? AND state = 'pending'`,
    ).run(input.adminUserId, now, reviewNote, allowedBuildsJson, version.id)

    // Registry map name@version → sha512 (idempotent if mirror already wrote it).
    input.db.db.prepare(
      `INSERT INTO plugin_artifact (name, version, sha512) VALUES (?, ?, ?)
       ON CONFLICT(name, version) DO UPDATE SET sha512 = excluded.sha512`,
    ).run(pkg.name, version.version, version.artifact_sha512)

    const listing = input.db.db.prepare(
      'SELECT package_id, current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
    ).get(pkg.id) as ListingRow | undefined

    let madeCurrent = false

    if (listing === undefined) {
      input.db.db.prepare(
        `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
         VALUES (?, ?, NULL, 1, ?, ?)`,
      ).run(pkg.id, version.id, input.adminUserId, now)
      input.db.db.prepare(
        `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
         VALUES (?, ?, 'list', ?, ?, ?)`,
      ).run(pkg.id, version.id, JSON.stringify({ version: version.version }), input.adminUserId, now)
      input.db.db.prepare(
        `INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)`,
      ).run(pkg.id, input.scope.kind, input.scope.target)
      madeCurrent = true
    } else {
      const currentVer = input.db.db.prepare(
        'SELECT version FROM plugin_version WHERE id = ?',
      ).get(listing.current_version_id) as { version: string } | undefined
      const currentVersion = currentVer?.version ?? '0.0.0'
      if (isNewerThan(version.version, currentVersion)) {
        input.db.db.prepare(
          `UPDATE plugin_listing
           SET previous_version_id = current_version_id,
               current_version_id = ?,
               generation = generation + 1,
               listed_by = ?,
               listed_at = ?
           WHERE package_id = ?`,
        ).run(version.id, input.adminUserId, now, pkg.id)
        input.db.db.prepare(
          `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
           VALUES (?, ?, 'update', ?, ?, ?)`,
        ).run(
          pkg.id,
          version.id,
          JSON.stringify({ from: currentVersion, to: version.version }),
          input.adminUserId,
          now,
        )
        madeCurrent = true
      }
      // else: history-only approval — version row is approved; listing pointers unchanged
    }

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-approve',
      outcome: 'ok',
      userId: version.requested_by,
      actor: input.adminUserId,
      detail: {
        package: pkg.name,
        version: version.version,
        scope: input.scope,
        artifactSha512: version.artifact_sha512,
        madeCurrent,
      },
    })

    if (allowedBuilds.length > 0) {
      writeAuditOutbox(input.db, {
        at: now,
        event: 'admin-plugin-build-allow',
        outcome: 'ok',
        userId: null,
        actor: input.adminUserId,
        detail: {
          package: pkg.name,
          version: version.version,
          allowed: [...allowedBuilds],
        },
      })
    }

    input.db.db.exec('COMMIT')
    return {
      packageId: pkg.id,
      versionId: version.id,
      name: pkg.name,
      version: version.version,
      state: 'approved',
      artifactSha512: version.artifact_sha512,
      madeCurrent,
      claimed,
      auditId,
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/** Reject a pending submission; releases an unclaimed name so others may resubmit. */
export function rejectSubmission(input: RejectInput): void {
  const now = input.now ?? Date.now()
  const reason = input.reason ?? ''

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const version = loadVersion(input.db, input.versionId)
    if (version.state !== 'pending') throw new ApproveError('not-pending', version.state)

    const pkg = loadPackage(input.db, version.package_id)

    input.db.db.prepare(
      `UPDATE plugin_version SET state = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ? AND state = 'pending'`,
    ).run(input.adminUserId, now, reason, version.id)

    releaseUnclaimedName(input.db, version.package_id)

    writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-reject',
      outcome: 'ok',
      userId: version.requested_by,
      actor: input.adminUserId,
      detail: {
        package: pkg.name,
        version: version.version,
        reason,
      },
    })

    input.db.db.exec('COMMIT')
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}
