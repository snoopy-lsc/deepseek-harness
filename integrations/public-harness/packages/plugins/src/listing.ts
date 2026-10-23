/**
 * Listing ops: scope change, delist/relist, rollback, revoke (design § Listing pointer rules).
 */
import { writeAuditOutbox } from './audit.ts'
import { compareSemVerDescending } from './index-builder.ts'
import type { PluginsDbHandle } from './migrate.ts'
import type { PluginScopeSpec } from './upload.ts'

export type ListingErrorCode =
  | 'not-found'
  | 'no-previous'
  | 'not-approved'
  | 'already-delisted'
  | 'not-delisted'
  | 'invalid-scope'
  | 'not-listed'

/** Wire-facing refusal for listing ops; `message` is the stable code. */
export class ListingError extends Error {
  readonly status: number
  readonly code: ListingErrorCode
  readonly detail: string | undefined
  constructor(code: ListingErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (
      code === 'not-found' ? 404
        : code === 'invalid-scope' ? 400
          : 409
    )
  }
}

export interface ChangeScopeInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly scopes: readonly PluginScopeSpec[]
  readonly now?: number
}

export interface ChangeScopeResult {
  readonly packageId: string
  readonly oldScopes: PluginScopeSpec[]
  readonly newScopes: PluginScopeSpec[]
  readonly auditId: number
}

export interface DelistInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly reason?: string
  readonly now?: number
}

export interface RelistInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly now?: number
}

export interface RollbackInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly now?: number
}

export interface RollbackResult {
  readonly packageId: string
  readonly fromVersionId: string
  readonly toVersionId: string
  readonly previousVersionId: string | null
  readonly fromVersion: string
  readonly toVersion: string
  readonly auditId: number
}

export interface RevokeInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly versionId: string
  readonly reason?: string
  readonly now?: number
}

export interface RevokeResult {
  readonly packageId: string
  readonly versionId: string
  readonly version: string
  readonly rolledBack: boolean
  readonly delisted: boolean
  readonly toVersionId: string | null
  readonly auditId: number
}

interface PackageRow {
  id: string
  name: string
  delisted_at: number | null
  delist_reason: string | null
}

interface ListingRow {
  package_id: string
  current_version_id: string
  previous_version_id: string | null
  generation: number
}

interface VersionRow {
  id: string
  package_id: string
  version: string
  state: string
}

function loadPackage(db: PluginsDbHandle, packageId: string): PackageRow {
  const row = db.db.prepare(
    'SELECT id, name, delisted_at, delist_reason FROM plugin_package WHERE id = ?',
  ).get(packageId) as PackageRow | undefined
  if (row === undefined) throw new ListingError('not-found', packageId)
  return row
}

function loadListing(db: PluginsDbHandle, packageId: string): ListingRow {
  const row = db.db.prepare(
    'SELECT package_id, current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
  ).get(packageId) as ListingRow | undefined
  if (row === undefined) throw new ListingError('not-listed', packageId)
  return row
}

function loadVersion(db: PluginsDbHandle, versionId: string): VersionRow {
  const row = db.db.prepare(
    'SELECT id, package_id, version, state FROM plugin_version WHERE id = ?',
  ).get(versionId) as VersionRow | undefined
  if (row === undefined) throw new ListingError('not-found', versionId)
  return row
}

function readScopes(db: PluginsDbHandle, packageId: string): PluginScopeSpec[] {
  const rows = db.db.prepare(
    'SELECT kind, target FROM plugin_scope WHERE package_id = ? ORDER BY kind, target',
  ).all(packageId) as Array<{ kind: string; target: string }>
  return rows.map((row) => {
    if (row.kind === 'company') return { kind: 'company' as const, target: '*' as const }
    return { kind: 'group' as const, target: row.target }
  })
}

function assertValidScopes(scopes: readonly PluginScopeSpec[]): void {
  if (scopes.length === 0) throw new ListingError('invalid-scope', 'empty')
  for (const scope of scopes) {
    if (scope.kind === 'company') {
      if (scope.target !== '*') throw new ListingError('invalid-scope', 'company-target')
    } else if (scope.kind === 'group') {
      if (typeof scope.target !== 'string' || scope.target.trim() === '') {
        throw new ListingError('invalid-scope', 'group-target')
      }
    } else {
      throw new ListingError('invalid-scope', 'kind')
    }
  }
}

function bumpGeneration(db: PluginsDbHandle, packageId: string): void {
  db.db.prepare(
    'UPDATE plugin_listing SET generation = generation + 1 WHERE package_id = ?',
  ).run(packageId)
}

function writeHistory(
  db: PluginsDbHandle,
  opts: {
    packageId: string
    versionId: string | null
    action: 'rollback' | 'delist' | 'relist' | 'scope' | 'revoke'
    detail: unknown
    by: string
    at: number
  },
): void {
  db.db.prepare(
    `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.packageId, opts.versionId, opts.action, JSON.stringify(opts.detail), opts.by, opts.at)
}

function versionString(db: PluginsDbHandle, versionId: string): string {
  const row = db.db.prepare('SELECT version FROM plugin_version WHERE id = ?').get(versionId) as
    | { version: string }
    | undefined
  return row?.version ?? ''
}

/**
 * Highest approved, unrevoked version strictly below `belowVersion` (SemVer), or null.
 */
function highestApprovedBelow(
  db: PluginsDbHandle,
  packageId: string,
  belowVersion: string,
): string | null {
  const rows = db.db.prepare(
    `SELECT id, version FROM plugin_version
     WHERE package_id = ? AND state = 'approved'`,
  ).all(packageId) as Array<{ id: string; version: string }>
  const below = rows.filter((row) => compareSemVerDescending(row.version, belowVersion) > 0)
  if (below.length === 0) return null
  below.sort((a, b) => compareSemVerDescending(a.version, b.version))
  return below[0]!.id
}

/**
 * Apply rollback pointer rules: previous → current; new previous = highest approved
 * unrevoked below the new current. Caller must ensure `previous_version_id` is set.
 */
function applyRollbackPointers(
  db: PluginsDbHandle,
  listing: ListingRow,
  adminUserId: string,
  now: number,
): { fromVersionId: string; toVersionId: string; previousVersionId: string | null } {
  const fromVersionId = listing.current_version_id
  const toVersionId = listing.previous_version_id
  if (toVersionId == null) throw new ListingError('no-previous')

  // Refuse promoting a revoked/missing previous (pointer must stay approved+unrevoked).
  const toRow = loadVersion(db, toVersionId)
  if (toRow.state !== 'approved') {
    throw new ListingError('no-previous', 'previous-not-approved')
  }

  const toVersion = versionString(db, toVersionId)
  const newPrevious = highestApprovedBelow(db, listing.package_id, toVersion)

  db.db.prepare(
    `UPDATE plugin_listing
     SET current_version_id = ?,
         previous_version_id = ?,
         generation = generation + 1,
         listed_by = ?,
         listed_at = ?
     WHERE package_id = ?`,
  ).run(toVersionId, newPrevious, adminUserId, now, listing.package_id)

  return { fromVersionId, toVersionId, previousVersionId: newPrevious }
}

function applyDelistRow(
  db: PluginsDbHandle,
  packageId: string,
  reason: string,
  now: number,
): void {
  db.db.prepare(
    `UPDATE plugin_package SET delisted_at = ?, delist_reason = ? WHERE id = ?`,
  ).run(now, reason, packageId)
  bumpGeneration(db, packageId)
}

/** Replace a listing's scope rows; bumps generation and audits. */
export function changeScope(input: ChangeScopeInput): ChangeScopeResult {
  const now = input.now ?? Date.now()
  assertValidScopes(input.scopes)

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    loadListing(input.db, input.packageId)
    const oldScopes = readScopes(input.db, pkg.id)

    input.db.db.prepare('DELETE FROM plugin_scope WHERE package_id = ?').run(pkg.id)
    const insert = input.db.db.prepare(
      'INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)',
    )
    const seen = new Set<string>()
    for (const scope of input.scopes) {
      const key = `${scope.kind}\0${scope.target}`
      if (seen.has(key)) continue
      seen.add(key)
      insert.run(pkg.id, scope.kind, scope.target)
    }
    const newScopes = readScopes(input.db, pkg.id)

    bumpGeneration(input.db, pkg.id)
    writeHistory(input.db, {
      packageId: pkg.id,
      versionId: null,
      action: 'scope',
      detail: { oldScope: oldScopes, newScope: newScopes },
      by: input.adminUserId,
      at: now,
    })

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-scope-change',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: {
        package: pkg.name,
        oldScope: oldScopes,
        newScope: newScopes,
      },
    })

    input.db.db.exec('COMMIT')
    return { packageId: pkg.id, oldScopes, newScopes, auditId }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * Delist a package: index and defaults stop; scope rows and mirror serving for
 * the original scope are kept.
 */
export function delistPackage(input: DelistInput): void {
  const now = input.now ?? Date.now()
  const reason = input.reason ?? ''

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    loadListing(input.db, input.packageId)
    if (pkg.delisted_at != null) throw new ListingError('already-delisted', pkg.name)

    applyDelistRow(input.db, pkg.id, reason, now)
    writeHistory(input.db, {
      packageId: pkg.id,
      versionId: null,
      action: 'delist',
      detail: { reason },
      by: input.adminUserId,
      at: now,
    })
    writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-delist',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: { package: pkg.name, reason },
    })
    input.db.db.exec('COMMIT')
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/** Relist clears `delisted_at` / `delist_reason`. */
export function relistPackage(input: RelistInput): void {
  const now = input.now ?? Date.now()

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    loadListing(input.db, input.packageId)
    if (pkg.delisted_at == null) throw new ListingError('not-delisted', pkg.name)

    input.db.db.prepare(
      `UPDATE plugin_package SET delisted_at = NULL, delist_reason = NULL WHERE id = ?`,
    ).run(pkg.id)
    bumpGeneration(input.db, pkg.id)
    writeHistory(input.db, {
      packageId: pkg.id,
      versionId: null,
      action: 'relist',
      detail: {},
      by: input.adminUserId,
      at: now,
    })
    writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-relist',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: { package: pkg.name },
    })
    input.db.db.exec('COMMIT')
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * Move listing back one version. New previous = highest approved unrevoked
 * below the new current. Refuses with 409 `no-previous` when none.
 */
export function rollbackListing(input: RollbackInput): RollbackResult {
  const now = input.now ?? Date.now()

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    const listing = loadListing(input.db, input.packageId)
    if (listing.previous_version_id == null) throw new ListingError('no-previous')

    const moved = applyRollbackPointers(input.db, listing, input.adminUserId, now)
    const fromVersion = versionString(input.db, moved.fromVersionId)
    const toVersion = versionString(input.db, moved.toVersionId)

    writeHistory(input.db, {
      packageId: pkg.id,
      versionId: moved.toVersionId,
      action: 'rollback',
      detail: { from: fromVersion, to: toVersion },
      by: input.adminUserId,
      at: now,
    })

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-rollback',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: {
        package: pkg.name,
        fromVersion,
        toVersion,
      },
    })

    input.db.db.exec('COMMIT')
    return {
      packageId: pkg.id,
      fromVersionId: moved.fromVersionId,
      toVersionId: moved.toVersionId,
      previousVersionId: moved.previousVersionId,
      fromVersion,
      toVersion,
      auditId,
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * Revoke an approved version. Non-current: drop from packuments/index.
 * Current: roll back; with no previous, delist with reason `revoked`.
 */
export function revokeVersion(input: RevokeInput): RevokeResult {
  const now = input.now ?? Date.now()
  const reason = input.reason ?? ''

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const version = loadVersion(input.db, input.versionId)
    if (version.state !== 'approved') throw new ListingError('not-approved', version.state)

    const pkg = loadPackage(input.db, version.package_id)
    const listing = loadListing(input.db, version.package_id)

    input.db.db.prepare(
      `UPDATE plugin_version SET state = 'revoked', reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ? AND state = 'approved'`,
    ).run(input.adminUserId, now, reason, version.id)

    let rolledBack = false
    let delisted = false
    let toVersionId: string | null = null

    if (listing.current_version_id === version.id) {
      if (listing.previous_version_id == null) {
        applyDelistRow(input.db, pkg.id, 'revoked', now)
        delisted = true
        writeHistory(input.db, {
          packageId: pkg.id,
          versionId: version.id,
          action: 'delist',
          detail: { reason: 'revoked', via: 'revoke' },
          by: input.adminUserId,
          at: now,
        })
      } else {
        const moved = applyRollbackPointers(input.db, listing, input.adminUserId, now)
        rolledBack = true
        toVersionId = moved.toVersionId
        writeHistory(input.db, {
          packageId: pkg.id,
          versionId: moved.toVersionId,
          action: 'rollback',
          detail: {
            from: version.version,
            to: versionString(input.db, moved.toVersionId),
            via: 'revoke',
          },
          by: input.adminUserId,
          at: now,
        })
      }
    } else {
      // Keep previous_version_id = highest approved unrevoked below current.
      // Revoking the previous (or leaving it dangling) must recompute the pointer
      // so rollback cannot promote a revoked version.
      const currentVersionStr = versionString(input.db, listing.current_version_id)
      let previousNeedsFix = listing.previous_version_id === version.id
      if (!previousNeedsFix && listing.previous_version_id != null) {
        const prev = loadVersion(input.db, listing.previous_version_id)
        if (prev.state !== 'approved') previousNeedsFix = true
      }
      if (previousNeedsFix) {
        const newPrevious = highestApprovedBelow(input.db, pkg.id, currentVersionStr)
        input.db.db.prepare(
          `UPDATE plugin_listing
           SET previous_version_id = ?, generation = generation + 1
           WHERE package_id = ?`,
        ).run(newPrevious, pkg.id)
      } else {
        bumpGeneration(input.db, pkg.id)
      }
    }

    writeHistory(input.db, {
      packageId: pkg.id,
      versionId: version.id,
      action: 'revoke',
      detail: { version: version.version, reason, rolledBack, delisted },
      by: input.adminUserId,
      at: now,
    })

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-revoke',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: {
        package: pkg.name,
        version: version.version,
        reason,
        rolledBack,
        delisted,
      },
    })

    input.db.db.exec('COMMIT')
    return {
      packageId: pkg.id,
      versionId: version.id,
      version: version.version,
      rolledBack,
      delisted,
      toVersionId,
      auditId,
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}
