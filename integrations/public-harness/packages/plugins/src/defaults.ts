/**
 * Default installs CRUD + per-user state (design § Default installs).
 * Sync plan (1D.2) consumes visibility / state helpers; opted-out is written only from
 * user-removed reports later — reset / reenable only clear or restore paths here.
 */
import { writeAuditOutbox } from './audit.ts'
import type { PluginsDbHandle } from './migrate.ts'
import type { PluginScopeSpec } from './upload.ts'
import { scopesVisibleToUser } from './visibility.ts'

export type DefaultStateValue =
  | 'installed'
  | 'pending'
  | 'failed'
  | 'opted-out'
  | 'user-managed'

export type DefaultErrorCode =
  | 'not-found'
  | 'not-listed'
  | 'delisted'
  | 'invalid-scope'
  | 'not-default'
  | 'not-opted-out'

/** Wire-facing refusal for default ops; `message` is the stable code. */
export class DefaultError extends Error {
  readonly status: number
  readonly code: DefaultErrorCode
  readonly detail: string | undefined
  constructor(code: DefaultErrorCode, detail?: string, status?: number) {
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

export interface SetDefaultInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly scope: PluginScopeSpec
  readonly now?: number
}

export interface ClearDefaultInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly scope: PluginScopeSpec
  readonly now?: number
}

export interface ResetDefaultInput {
  readonly db: PluginsDbHandle
  readonly adminUserId: string
  readonly packageId: string
  readonly scope: PluginScopeSpec
  readonly now?: number
}

export interface ReenableDefaultInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly packageId: string
  readonly now?: number
}

export interface DefaultMutationResult {
  readonly packageId: string
  readonly scope: PluginScopeSpec
  readonly auditId: number
}

export interface ResetDefaultResult extends DefaultMutationResult {
  readonly clearedOptOuts: number
  readonly resetAt: number
}

export interface ReenableDefaultResult {
  readonly packageId: string
  readonly state: 'pending'
  readonly auditId: number
}

export interface VisibleDefault {
  readonly packageId: string
  readonly name: string
  readonly scope: PluginScopeSpec
  readonly setAt: number
  readonly resetAt: number | null
  readonly state: DefaultStateValue | null
  readonly optedOut: boolean
}

export interface ListedDefault {
  readonly packageId: string
  readonly name: string
  readonly scope: PluginScopeSpec
  readonly setBy: string
  readonly setAt: number
  readonly resetAt: number | null
}

export interface DefaultApplyCounts {
  readonly installed: number
  readonly pending: number
  readonly failed: number
  readonly optedOut: number
  readonly userManaged: number
  /** Users currently applied (`installed`). */
  readonly applied: number
}

interface PackageRow {
  id: string
  name: string
  delisted_at: number | null
}

interface DefaultRow {
  package_id: string
  kind: string
  target: string
  set_by: string
  set_at: number
  reset_at: number | null
}

function assertValidScope(scope: PluginScopeSpec): void {
  if (scope.kind === 'company') {
    if (scope.target !== '*') throw new DefaultError('invalid-scope', 'company-target')
  } else if (scope.kind === 'group') {
    if (typeof scope.target !== 'string' || scope.target.trim() === '') {
      throw new DefaultError('invalid-scope', 'group-target')
    }
  } else {
    throw new DefaultError('invalid-scope', 'kind')
  }
}

function normalizeScope(kind: string, target: string): PluginScopeSpec {
  if (kind === 'company') return { kind: 'company', target: '*' }
  return { kind: 'group', target }
}

function loadPackage(db: PluginsDbHandle, packageId: string): PackageRow {
  const row = db.db.prepare(
    'SELECT id, name, delisted_at FROM plugin_package WHERE id = ?',
  ).get(packageId) as PackageRow | undefined
  if (row === undefined) throw new DefaultError('not-found', packageId)
  return row
}

function assertListed(db: PluginsDbHandle, packageId: string): void {
  const row = db.db.prepare(
    'SELECT package_id FROM plugin_listing WHERE package_id = ?',
  ).get(packageId) as { package_id: string } | undefined
  if (row === undefined) throw new DefaultError('not-listed', packageId)
}

function loadDefault(
  db: PluginsDbHandle,
  packageId: string,
  scope: PluginScopeSpec,
): DefaultRow | undefined {
  return db.db.prepare(
    'SELECT package_id, kind, target, set_by, set_at, reset_at FROM plugin_default WHERE package_id = ? AND kind = ? AND target = ?',
  ).get(packageId, scope.kind, scope.target) as DefaultRow | undefined
}

/** Mark a listed, non-delisted package as a company or group default. */
export function setDefault(input: SetDefaultInput): DefaultMutationResult {
  const now = input.now ?? Date.now()
  assertValidScope(input.scope)

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    if (pkg.delisted_at != null) throw new DefaultError('delisted', pkg.name)
    assertListed(input.db, pkg.id)

    const existing = loadDefault(input.db, pkg.id, input.scope)
    if (existing === undefined) {
      input.db.db.prepare(
        `INSERT INTO plugin_default (package_id, kind, target, set_by, set_at, reset_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(pkg.id, input.scope.kind, input.scope.target, input.adminUserId, now)
    } else {
      input.db.db.prepare(
        `UPDATE plugin_default SET set_by = ?, set_at = ? WHERE package_id = ? AND kind = ? AND target = ?`,
      ).run(input.adminUserId, now, pkg.id, input.scope.kind, input.scope.target)
    }

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-default-set',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: { package: pkg.name, scope: input.scope },
    })

    input.db.db.exec('COMMIT')
    return { packageId: pkg.id, scope: input.scope, auditId }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/** Remove one default row for company or group. */
export function clearDefault(input: ClearDefaultInput): DefaultMutationResult {
  const now = input.now ?? Date.now()
  assertValidScope(input.scope)

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    const existing = loadDefault(input.db, pkg.id, input.scope)
    if (existing === undefined) throw new DefaultError('not-default', pkg.name)

    input.db.db.prepare(
      'DELETE FROM plugin_default WHERE package_id = ? AND kind = ? AND target = ?',
    ).run(pkg.id, input.scope.kind, input.scope.target)

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-default-clear',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: { package: pkg.name, scope: input.scope },
    })

    input.db.db.exec('COMMIT')
    return { packageId: pkg.id, scope: input.scope, auditId }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * Administrator reset: stamp `reset_at` and clear `opted-out` rows older than it
 * (restored to `pending` so sync/reconcile can reinstall).
 */
export function resetDefault(input: ResetDefaultInput): ResetDefaultResult {
  const now = input.now ?? Date.now()
  assertValidScope(input.scope)

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    const existing = loadDefault(input.db, pkg.id, input.scope)
    if (existing === undefined) throw new DefaultError('not-default', pkg.name)

    input.db.db.prepare(
      'UPDATE plugin_default SET reset_at = ? WHERE package_id = ? AND kind = ? AND target = ?',
    ).run(now, pkg.id, input.scope.kind, input.scope.target)

    const cleared = input.db.db.prepare(
      `UPDATE plugin_default_state
       SET state = 'pending', installed_version = NULL, target_version = NULL,
           last_error = NULL, updated_at = ?
       WHERE package_id = ? AND state = 'opted-out' AND updated_at < ?`,
    ).run(now, pkg.id, now)
    const clearedOptOuts = Number(cleared.changes ?? 0)

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-default-reset',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: { package: pkg.name, scope: input.scope, clearedOptOuts },
    })

    input.db.db.exec('COMMIT')
    return {
      packageId: pkg.id,
      scope: input.scope,
      resetAt: now,
      clearedOptOuts,
      auditId,
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * User re-enable in My plugins: opted-out → pending so sync reinstalls.
 * Does not invent an opt-out source; only restores after an existing opted-out row.
 */
export function reenableDefault(input: ReenableDefaultInput): ReenableDefaultResult {
  const now = input.now ?? Date.now()

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    const pkg = loadPackage(input.db, input.packageId)
    const state = input.db.db.prepare(
      'SELECT state FROM plugin_default_state WHERE user_id = ? AND package_id = ?',
    ).get(input.userId, pkg.id) as { state: string } | undefined
    if (state === undefined || state.state !== 'opted-out') {
      throw new DefaultError('not-opted-out', pkg.name)
    }

    input.db.db.prepare(
      `UPDATE plugin_default_state
       SET state = 'pending', installed_version = NULL, target_version = NULL,
           last_error = NULL, updated_at = ?
       WHERE user_id = ? AND package_id = ?`,
    ).run(now, input.userId, pkg.id)

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'plugin-default-reenable',
      outcome: 'ok',
      userId: input.userId,
      actor: input.userId,
      detail: { package: pkg.name },
    })

    input.db.db.exec('COMMIT')
    return { packageId: pkg.id, state: 'pending', auditId }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

/**
 * A user's default set: every default whose scope is visible to them
 * (same `scopesVisibleToUser` helper as listings), excluding delisted packages.
 */
export function defaultsVisibleToUser(
  db: PluginsDbHandle,
  userId: string,
  groups: ReadonlySet<string>,
): VisibleDefault[] {
  const rows = db.db.prepare(
    `SELECT d.package_id AS package_id, d.kind AS kind, d.target AS target,
            d.set_at AS set_at, d.reset_at AS reset_at,
            p.name AS name, p.delisted_at AS delisted_at
     FROM plugin_default d
     JOIN plugin_package p ON p.id = d.package_id
     WHERE p.delisted_at IS NULL
     ORDER BY p.name COLLATE NOCASE, d.kind, d.target`,
  ).all() as Array<{
    package_id: string
    kind: string
    target: string
    set_at: number
    reset_at: number | null
    name: string
    delisted_at: number | null
  }>

  const stateStmt = db.db.prepare(
    'SELECT state FROM plugin_default_state WHERE user_id = ? AND package_id = ?',
  )

  const out: VisibleDefault[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const scope = normalizeScope(row.kind, row.target)
    if (!scopesVisibleToUser([scope], groups)) continue
    // One entry per package: prefer company over group when both match.
    if (seen.has(row.package_id)) continue
    seen.add(row.package_id)

    const stateRow = stateStmt.get(userId, row.package_id) as { state: DefaultStateValue } | undefined
    const state = stateRow?.state ?? null
    out.push({
      packageId: row.package_id,
      name: row.name,
      scope,
      setAt: row.set_at,
      resetAt: row.reset_at,
      state,
      optedOut: state === 'opted-out',
    })
  }
  return out
}

/** All default rows for admin inventory (`GET /plugins` apply-count companion). */
export function listDefaults(db: PluginsDbHandle, packageId?: string): ListedDefault[] {
  const rows = packageId === undefined
    ? db.db.prepare(
      `SELECT d.package_id AS package_id, d.kind AS kind, d.target AS target,
              d.set_by AS set_by, d.set_at AS set_at, d.reset_at AS reset_at,
              p.name AS name
       FROM plugin_default d
       JOIN plugin_package p ON p.id = d.package_id
       ORDER BY p.name COLLATE NOCASE, d.kind, d.target`,
    ).all()
    : db.db.prepare(
      `SELECT d.package_id AS package_id, d.kind AS kind, d.target AS target,
              d.set_by AS set_by, d.set_at AS set_at, d.reset_at AS reset_at,
              p.name AS name
       FROM plugin_default d
       JOIN plugin_package p ON p.id = d.package_id
       WHERE d.package_id = ?
       ORDER BY d.kind, d.target`,
    ).all(packageId)

  return (rows as Array<{
    package_id: string
    kind: string
    target: string
    set_by: string
    set_at: number
    reset_at: number | null
    name: string
  }>).map((row) => ({
    packageId: row.package_id,
    name: row.name,
    scope: normalizeScope(row.kind, row.target),
    setBy: row.set_by,
    setAt: row.set_at,
    resetAt: row.reset_at,
  }))
}

/** Per-package state tallies for admin apply counts. */
export function applyCountsForPackage(db: PluginsDbHandle, packageId: string): DefaultApplyCounts {
  const rows = db.db.prepare(
    `SELECT state, COUNT(*) AS n FROM plugin_default_state WHERE package_id = ? GROUP BY state`,
  ).all(packageId) as Array<{ state: string; n: number | bigint }>

  const counts: DefaultApplyCounts = {
    installed: 0,
    pending: 0,
    failed: 0,
    optedOut: 0,
    userManaged: 0,
    applied: 0,
  }
  for (const row of rows) {
    const n = Number(row.n)
    switch (row.state) {
      case 'installed':
        counts.installed = n
        counts.applied = n
        break
      case 'pending':
        counts.pending = n
        break
      case 'failed':
        counts.failed = n
        break
      case 'opted-out':
        counts.optedOut = n
        break
      case 'user-managed':
        counts.userManaged = n
        break
      default:
        break
    }
  }
  return counts
}
