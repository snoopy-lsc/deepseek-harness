/**
 * Path A: user submission — ownership, pending uniqueness, name release.
 * Mirror stays `queued`; fetch/approve live in later tasks.
 */
import { COMPANY_SCOPE_PREFIX } from './schema.ts'
import { newId } from './ids.ts'
import { releaseUnclaimedName, type PluginsDbHandle } from './migrate.ts'
import { assertCompanyPluginName, UploadError } from './upload.ts'

export type SubmitErrorCode =
  | 'scope'
  | 'not-owner'
  | 'not-pending'
  | 'pending-exists'
  | 'version-exists'
  | 'limit-reached'
  | 'name-taken'
  | 'not-found'

/** Wire-facing refusal for path A submit/withdraw; `message` is the stable code. */
export class SubmitError extends Error {
  readonly status: number
  readonly code: SubmitErrorCode
  readonly detail: string | undefined
  constructor(code: SubmitErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (
      code === 'scope' ? 400
        : code === 'not-owner' ? 403
          : code === 'not-found' ? 404
            : 409
    )
  }
}

export type SubmitSource =
  | { readonly type: 'npm'; readonly registry: string; readonly name: string; readonly version: string }
  | {
      readonly type: 'git'
      readonly url: string
      readonly commit: string
      readonly name: string
      readonly version: string
      readonly path?: string
    }
  | { readonly type: 'upload'; readonly name: string; readonly version: string; readonly sizeBytes?: number }

export interface SubmitLimits {
  readonly maxSubmissions?: number | null
  readonly maxSubmissionBytes?: number | null
}

export interface SubmitInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  /** Administrators may submit later versions of a claimed package they do not own. */
  readonly isAdmin?: boolean
  readonly name: string
  readonly version: string
  readonly source: SubmitSource
  readonly requestNote?: string
  readonly kind?: 'bundle' | 'skill'
  readonly display?: string
  readonly now?: number
  readonly limits?: SubmitLimits
}

export interface SubmitResult {
  readonly packageId: string
  readonly versionId: string
  readonly name: string
  readonly version: string
  readonly state: 'pending'
  readonly mirrorState: 'queued'
}

export interface WithdrawInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly versionId: string
  readonly now?: number
}

export interface ExpireInput {
  readonly db: PluginsDbHandle
  readonly versionId: string
  readonly now?: number
}

function defaultDisplay(name: string): string {
  return JSON.stringify({
    title: name,
    description: '',
    author: '',
    homepage: '',
    repository: '',
    metadata: {},
  })
}

function sourceJson(source: SubmitSource): string {
  if (source.type === 'npm') {
    return JSON.stringify({ type: 'npm', registry: source.registry, name: source.name, version: source.version })
  }
  if (source.type === 'git') {
    return JSON.stringify({
      type: 'git',
      url: source.url,
      commit: source.commit,
      name: source.name,
      version: source.version,
      ...(source.path !== undefined ? { path: source.path } : {}),
    })
  }
  return JSON.stringify({ type: 'upload', name: source.name, version: source.version })
}

function liveVersionExists(db: PluginsDbHandle, name: string, version: string): boolean {
  const artifact = db.db.prepare('SELECT 1 AS ok FROM plugin_artifact WHERE name = ? AND version = ?').get(name, version)
  if (artifact !== undefined) return true
  const live = db.db.prepare(
    `SELECT 1 AS ok FROM plugin_version v
     JOIN plugin_package p ON p.id = v.package_id
     WHERE p.name = ? AND v.version = ? AND v.state IN ('pending', 'approved', 'revoked')
     LIMIT 1`,
  ).get(name, version)
  return live !== undefined
}

function pendingExists(db: PluginsDbHandle, packageId: string): boolean {
  return db.db.prepare(
    `SELECT 1 AS ok FROM plugin_version WHERE package_id = ? AND state = 'pending' LIMIT 1`,
  ).get(packageId) !== undefined
}

/** Packages the user owns that are pending or currently listed (design max_submissions). */
function countUserSubmissions(db: PluginsDbHandle, userId: string): number {
  const row = db.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_package p
     WHERE p.owner_user_id = ?
       AND (
         EXISTS (SELECT 1 FROM plugin_version v WHERE v.package_id = p.id AND v.state = 'pending')
         OR EXISTS (SELECT 1 FROM plugin_listing l WHERE l.package_id = p.id)
       )`,
  ).get(userId) as { n: number }
  return row.n
}

function assertCompanyName(name: string): void {
  try {
    assertCompanyPluginName(name)
  } catch (error) {
    if (error instanceof UploadError) throw new SubmitError('scope', error.detail)
    throw error
  }
  if (!name.startsWith(COMPANY_SCOPE_PREFIX)) throw new SubmitError('scope', name)
}

/**
 * Submit a new pending version. First submitter of an unclaimed name becomes owner
 * (`claimed_at` stays NULL until approve). Mirror is left `queued`.
 */
export function submitPluginVersion(input: SubmitInput): SubmitResult {
  assertCompanyName(input.name)
  if (input.source.name !== input.name || input.source.version !== input.version) {
    throw new SubmitError('scope', 'name-version-mismatch')
  }

  const now = input.now ?? Date.now()
  const note = input.requestNote ?? ''
  const kind = input.kind ?? 'bundle'
  const display = input.display ?? defaultDisplay(input.name)
  const isAdmin = input.isAdmin === true

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = input.db.db.prepare(
      'SELECT id, owner_user_id, claimed_at FROM plugin_package WHERE name = ?',
    ).get(input.name) as { id: string; owner_user_id: string | null; claimed_at: number | null } | undefined

    let packageId: string

    if (existing === undefined) {
      if (input.limits?.maxSubmissions != null && countUserSubmissions(input.db, input.userId) >= input.limits.maxSubmissions) {
        throw new SubmitError('limit-reached', 'max_submissions')
      }
      packageId = newId('plg')
      input.db.db.prepare(`INSERT INTO plugin_package
        (id, name, kind, origin, owner_user_id, claimed_at, display, icon_sha512, created_at)
        VALUES (?, ?, ?, 'submitted', ?, NULL, ?, NULL, ?)`).run(
        packageId, input.name, kind, input.userId, display, now,
      )
    } else {
      packageId = existing.id
      const owner = existing.owner_user_id
      const claimed = existing.claimed_at !== null

      if (owner !== null && owner !== input.userId && !isAdmin) {
        if (!claimed) throw new SubmitError('name-taken', owner)
        throw new SubmitError('not-owner', owner)
      }

      // Released name (owner cleared, never claimed): next submitter becomes owner.
      if (owner === null && !claimed) {
        if (input.limits?.maxSubmissions != null && countUserSubmissions(input.db, input.userId) >= input.limits.maxSubmissions) {
          throw new SubmitError('limit-reached', 'max_submissions')
        }
        input.db.db.prepare(
          'UPDATE plugin_package SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL AND claimed_at IS NULL',
        ).run(input.userId, packageId)
      } else if (owner === null && claimed && !isAdmin) {
        // Admin-listed / claimed without personal owner: only admin may add versions.
        throw new SubmitError('not-owner', 'claimed')
      }

      if (pendingExists(input.db, packageId)) {
        throw new SubmitError('pending-exists', packageId)
      }
    }

    if (liveVersionExists(input.db, input.name, input.version)) {
      throw new SubmitError('version-exists', `${input.name}@${input.version}`)
    }

    // Limit check for later versions on an owned/claimed package (new package already checked).
    if (existing !== undefined && existing.owner_user_id === input.userId) {
      // already owns; max_submissions counts packages not versions — no extra charge
    }

    const versionId = newId('plv')
    const sizeBytes = input.source.type === 'upload' ? (input.source.sizeBytes ?? null) : null
    input.db.db.prepare(`INSERT INTO plugin_version
      (id, package_id, version, source, state, mirror_state, mirror_error, artifact_sha512,
       upstream_integrity, size_bytes, engines_dsh, install_scripts, allowed_builds,
       requested_by, request_note, reviewed_by, reviewed_at, review_note, created_at)
      VALUES (?, ?, ?, ?, 'pending', 'queued', NULL, NULL, NULL, ?, NULL, '[]', '[]', ?, ?, NULL, NULL, NULL, ?)`).run(
      versionId, packageId, input.version, sourceJson(input.source),
      sizeBytes, input.userId, note, now,
    )

    input.db.db.exec('COMMIT')
    return {
      packageId,
      versionId,
      name: input.name,
      version: input.version,
      state: 'pending',
      mirrorState: 'queued',
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

function loadPendingVersion(db: PluginsDbHandle, versionId: string): {
  id: string
  package_id: string
  state: string
  requested_by: string
} {
  const row = db.db.prepare(
    'SELECT id, package_id, state, requested_by FROM plugin_version WHERE id = ?',
  ).get(versionId) as { id: string; package_id: string; state: string; requested_by: string } | undefined
  if (row === undefined) throw new SubmitError('not-found', versionId)
  return row
}

/** Submitter withdraws a pending version; releases unclaimed names. */
export function withdrawSubmission(input: WithdrawInput): void {
  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const row = loadPendingVersion(input.db, input.versionId)
    if (row.state !== 'pending') throw new SubmitError('not-pending', row.state)
    if (row.requested_by !== input.userId) throw new SubmitError('not-owner', row.requested_by)
    input.db.db.prepare(`UPDATE plugin_version SET state = 'withdrawn' WHERE id = ? AND state = 'pending'`).run(input.versionId)
    releaseUnclaimedName(input.db, row.package_id)
    input.db.db.exec('COMMIT')
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/** System expiry of a pending version; releases unclaimed names. */
export function expireSubmission(input: ExpireInput): void {
  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const row = loadPendingVersion(input.db, input.versionId)
    if (row.state !== 'pending') throw new SubmitError('not-pending', row.state)
    input.db.db.prepare(`UPDATE plugin_version SET state = 'expired' WHERE id = ? AND state = 'pending'`).run(input.versionId)
    releaseUnclaimedName(input.db, row.package_id)
    input.db.db.exec('COMMIT')
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}
