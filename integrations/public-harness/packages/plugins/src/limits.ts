/**
 * Plugin market limits on `dsh_plugin_limit` (design § Plugin limits, Q12).
 * Resolution reuses generalized `effectiveLimits` from `@public-harness/kb`.
 * Lowering a limit never deletes, delists, or uninstalls — only growth returns 409 `limit-reached`.
 */
import {
  atLimit,
  effectiveLimits,
  overLimit,
  type EffectiveLimit,
} from '../../kb/src/limits.ts'
import { writeAuditOutbox } from './audit.ts'
import type { PluginsDbHandle } from './migrate.ts'
import type { LimitName } from './schema.ts'
import type { PersonalizedMarketIndex, PersonalizedMarketPlugin } from './index-builder.ts'

export { atLimit, overLimit, type EffectiveLimit }

export type PluginLimitName = LimitName
export const PLUGIN_LIMIT_NAMES: readonly PluginLimitName[] = [
  'max_installed',
  'max_submissions',
  'max_submission_bytes',
] as const

/** Design Q12 defaults: 50 installs / 20 submissions / 1 GiB. */
export const DEFAULT_PLUGIN_LIMITS: Readonly<Record<PluginLimitName, number>> = {
  max_installed: 50,
  max_submissions: 20,
  max_submission_bytes: 1024 ** 3,
}

/** Inclusive allowed ranges for admin writes (mirrors KB limits-admin shape). */
export const PLUGIN_LIMIT_RANGE: Record<PluginLimitName, readonly [number, number]> = {
  max_installed: [1, 100_000],
  max_submissions: [1, 100_000],
  max_submission_bytes: [1024, 1024 ** 4],
}

export interface PluginLimitRow {
  readonly scopeType: 'global' | 'group' | 'user'
  readonly scopeId: string
  readonly name: PluginLimitName
  readonly value: number | null
  readonly updatedBy: string
  readonly updatedAt: number
}

export type EffectivePluginLimits = Record<PluginLimitName, EffectiveLimit>

export interface PluginLimitsView {
  readonly global: Record<PluginLimitName, number | null>
  readonly overrides: ReadonlyArray<{
    readonly scope: { readonly type: 'group' | 'user'; readonly id: string; readonly email?: string | null }
    readonly values: Partial<Record<PluginLimitName, number | null>>
    readonly updatedAt: number
  }>
  readonly ranges: Record<PluginLimitName, readonly [number, number]>
}

export interface PluginEffectiveView {
  readonly user: { readonly id: string; readonly email: string | null; readonly groups: readonly string[] }
  readonly limits: EffectivePluginLimits
  readonly usage: {
    readonly installed: number
    readonly submissions: number
    readonly submissionBytes: number
  }
}

export type PluginLimitErrorCode =
  | 'scope'
  | 'global-scope'
  | 'name'
  | 'value'
  | 'override-not-found'
  | 'limit-reached'
  | 'user-not-found'
  | 'not-found'

export class PluginLimitError extends Error {
  readonly status: number
  readonly code: PluginLimitErrorCode
  readonly detail: string | undefined
  constructor(code: PluginLimitErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (
      code === 'override-not-found' || code === 'user-not-found' || code === 'not-found' ? 404
        : code === 'limit-reached' ? 409
          : 400
    )
  }
}

const GROUP_ID = /^(oidc|saml|ldap|wecom|dingtalk|local):[^\0\r\n]{1,512}$/
const show = (value: number | null | undefined) => value === undefined ? 'inherit' : value === null ? 'unlimited' : String(value)

/** Seed global defaults (INSERT OR IGNORE — never clobbers admin edits). */
export function seedPluginLimits(db: PluginsDbHandle, updatedBy = 'seed', now = Date.now()): void {
  const stmt = db.db.prepare(
    `INSERT OR IGNORE INTO dsh_plugin_limit (scope_type, scope_id, name, value, updated_by, updated_at)
     VALUES ('global', '*', ?, ?, ?, ?)`,
  )
  for (const name of PLUGIN_LIMIT_NAMES) {
    stmt.run(name, DEFAULT_PLUGIN_LIMITS[name], updatedBy, now)
  }
}

/** List every limit row. */
export function listPluginLimitRows(db: PluginsDbHandle): PluginLimitRow[] {
  const rows = db.db.prepare(
    `SELECT scope_type, scope_id, name, value, updated_by, updated_at FROM dsh_plugin_limit`,
  ).all() as Array<{
    scope_type: string
    scope_id: string
    name: string
    value: number | null
    updated_by: string
    updated_at: number | bigint
  }>
  return rows.map(r => ({
    scopeType: r.scope_type as PluginLimitRow['scopeType'],
    scopeId: r.scope_id,
    name: r.name as PluginLimitName,
    value: r.value === null ? null : Number(r.value),
    updatedBy: r.updated_by,
    updatedAt: Number(r.updated_at),
  }))
}

/** Resolve plugin limits for one user (user → most permissive group → global). */
export function effectivePluginLimits(
  rows: readonly PluginLimitRow[],
  userId: string,
  groups: readonly string[],
): EffectivePluginLimits {
  return effectiveLimits(rows, userId, groups, PLUGIN_LIMIT_NAMES, DEFAULT_PLUGIN_LIMITS)
}

function getRow(
  db: PluginsDbHandle,
  scopeType: PluginLimitRow['scopeType'],
  scopeId: string,
  name: PluginLimitName,
): PluginLimitRow | undefined {
  const r = db.db.prepare(
    `SELECT scope_type, scope_id, name, value, updated_by, updated_at
     FROM dsh_plugin_limit WHERE scope_type = ? AND scope_id = ? AND name = ?`,
  ).get(scopeType, scopeId, name) as {
    scope_type: string
    scope_id: string
    name: string
    value: number | null
    updated_by: string
    updated_at: number | bigint
  } | undefined
  if (r === undefined) return undefined
  return {
    scopeType: r.scope_type as PluginLimitRow['scopeType'],
    scopeId: r.scope_id,
    name: r.name as PluginLimitName,
    value: r.value === null ? null : Number(r.value),
    updatedBy: r.updated_by,
    updatedAt: Number(r.updated_at),
  }
}

/** Admin list view (global + overrides + ranges). */
export function listPluginLimits(db: PluginsDbHandle): PluginLimitsView {
  const rows = listPluginLimitRows(db)
  const global = Object.fromEntries(
    PLUGIN_LIMIT_NAMES.map(name => {
      const found = rows.find(r => r.scopeType === 'global' && r.name === name)
      return [name, found === undefined ? DEFAULT_PLUGIN_LIMITS[name] : found.value]
    }),
  ) as Record<PluginLimitName, number | null>
  const overrides = new Map<string, {
    scope: { type: 'group' | 'user'; id: string; email?: string | null }
    values: Partial<Record<PluginLimitName, number | null>>
    updatedAt: number
  }>()
  for (const row of rows) {
    if (row.scopeType === 'global') continue
    const key = `${row.scopeType}:${row.scopeId}`
    const entry = overrides.get(key) ?? {
      scope: { type: row.scopeType, id: row.scopeId },
      values: {},
      updatedAt: 0,
    }
    entry.values[row.name] = row.value
    entry.updatedAt = Math.max(entry.updatedAt, row.updatedAt)
    overrides.set(key, entry)
  }
  return { global, overrides: [...overrides.values()], ranges: PLUGIN_LIMIT_RANGE }
}

export interface SetPluginLimitInput {
  readonly db: PluginsDbHandle
  readonly scope: { readonly type: 'global' | 'group' | 'user'; readonly id: string }
  readonly name: PluginLimitName
  readonly value: number | null
  readonly actor: string
  readonly now?: number
  /** Optional email enrichment for user-scope overrides in the returned view. */
  readonly emailFor?: (userId: string) => string | null
}

function assertScope(
  scope: { type: string; id?: string },
  allowGlobal: boolean,
): { type: PluginLimitRow['scopeType']; id: string } {
  if (scope.type === 'global' && allowGlobal) return { type: 'global', id: '*' }
  if (scope.type === 'group' && typeof scope.id === 'string' && GROUP_ID.test(scope.id)) {
    return { type: 'group', id: scope.id }
  }
  if (scope.type === 'user' && typeof scope.id === 'string' && scope.id.length > 0 && scope.id.length <= 512) {
    return { type: 'user', id: scope.id }
  }
  throw new PluginLimitError(scope.type === 'global' ? 'global-scope' : 'scope')
}

function assertName(raw: unknown): PluginLimitName {
  if (!(PLUGIN_LIMIT_NAMES as readonly unknown[]).includes(raw)) throw new PluginLimitError('name')
  return raw as PluginLimitName
}

function assertValue(name: PluginLimitName, value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < PLUGIN_LIMIT_RANGE[name][0] || value > PLUGIN_LIMIT_RANGE[name][1]) {
    throw new PluginLimitError('value', undefined, 400)
  }
  return value
}

/**
 * Set a limit row. Lowering never deletes installs/submissions/listings.
 * Audits `admin-plugin-limit-change`.
 */
export function setPluginLimit(input: SetPluginLimitInput): PluginLimitsView {
  const scope = assertScope(input.scope, true)
  const name = assertName(input.name)
  const value = assertValue(name, input.value)
  const now = input.now ?? Date.now()
  const before = getRow(input.db, scope.type, scope.id, name)
  input.db.db.prepare(
    `INSERT INTO dsh_plugin_limit (scope_type, scope_id, name, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_type, scope_id, name) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(scope.type, scope.id, name, value, input.actor, now)
  writeAuditOutbox(input.db, {
    at: now,
    event: 'admin-plugin-limit-change',
    outcome: 'ok',
    userId: scope.type === 'user' ? scope.id : null,
    actor: input.actor,
    detail: `scope=${scope.type}:${scope.id.slice(0, 200)} limit=${name} old=${show(before?.value)} new=${show(value)}`,
  })
  const view = listPluginLimits(input.db)
  if (input.emailFor !== undefined) {
    return {
      ...view,
      overrides: view.overrides.map(o => o.scope.type === 'user'
        ? { ...o, scope: { ...o.scope, email: input.emailFor!(o.scope.id) } }
        : o),
    }
  }
  return view
}

export interface DeletePluginLimitInput {
  readonly db: PluginsDbHandle
  readonly scope: { readonly type: 'group' | 'user'; readonly id: string }
  readonly name: PluginLimitName
  readonly actor: string
  readonly now?: number
}

/** Delete a group/user override (not global). Audits `admin-plugin-limit-delete`. */
export function deletePluginLimit(input: DeletePluginLimitInput): PluginLimitsView {
  const scope = assertScope(input.scope, false)
  if (scope.type === 'global') throw new PluginLimitError('global-scope')
  const name = assertName(input.name)
  const now = input.now ?? Date.now()
  const before = getRow(input.db, scope.type, scope.id, name)
  if (before === undefined) throw new PluginLimitError('override-not-found')
  input.db.db.prepare(
    `DELETE FROM dsh_plugin_limit WHERE scope_type = ? AND scope_id = ? AND name = ?`,
  ).run(scope.type, scope.id, name)
  writeAuditOutbox(input.db, {
    at: now,
    event: 'admin-plugin-limit-delete',
    outcome: 'ok',
    userId: scope.type === 'user' ? scope.id : null,
    actor: input.actor,
    detail: `scope=${scope.type}:${scope.id.slice(0, 200)} limit=${name} old=${show(before.value)} new=inherit`,
  })
  return listPluginLimits(input.db)
}

/** Packages the user owns that are pending or currently listed (design max_submissions). */
export function countUserSubmissions(db: PluginsDbHandle, userId: string): number {
  const row = db.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_package p
     WHERE p.owner_user_id = ?
       AND (
         EXISTS (SELECT 1 FROM plugin_version v WHERE v.package_id = p.id AND v.state = 'pending')
         OR EXISTS (SELECT 1 FROM plugin_listing l WHERE l.package_id = p.id)
       )`,
  ).get(userId) as { n: number }
  return Number(row.n)
}

/** Store bytes attributed to the user's submissions (version size_bytes). */
export function countUserSubmissionBytes(db: PluginsDbHandle, userId: string): number {
  const row = db.db.prepare(
    `SELECT COALESCE(SUM(v.size_bytes), 0) AS n
     FROM plugin_version v
     JOIN plugin_package p ON p.id = v.package_id
     WHERE p.owner_user_id = ?
       AND v.size_bytes IS NOT NULL
       AND v.state IN ('pending', 'approved', 'revoked')`,
  ).get(userId) as { n: number }
  return Number(row.n)
}

/** Installed count from the last sync/reconcile report, or null when unknown/stale-absent. */
export function installedCountFromReport(db: PluginsDbHandle, userId: string): number | null {
  const row = db.db.prepare(
    'SELECT last_report FROM plugin_endpoint WHERE user_id = ?',
  ).get(userId) as { last_report: string | null } | undefined
  if (row === undefined || row.last_report === null || row.last_report === '') return null
  try {
    const parsed = JSON.parse(row.last_report) as { installedCount?: unknown }
    return typeof parsed.installedCount === 'number' && Number.isFinite(parsed.installedCount)
      ? parsed.installedCount
      : null
  } catch {
    return null
  }
}

/** Names reported installed in last_report (best-effort). */
export function installedNamesFromReport(db: PluginsDbHandle, userId: string): Set<string> {
  const row = db.db.prepare(
    'SELECT last_report FROM plugin_endpoint WHERE user_id = ?',
  ).get(userId) as { last_report: string | null } | undefined
  if (row === undefined || row.last_report === null || row.last_report === '') return new Set()
  try {
    const parsed = JSON.parse(row.last_report) as { installed?: unknown }
    if (!Array.isArray(parsed.installed)) return new Set()
    const out = new Set<string>()
    for (const item of parsed.installed) {
      if (typeof item === 'string') out.add(item)
      else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        out.add((item as { name: string }).name)
      }
    }
    return out
  } catch {
    return new Set()
  }
}

export interface AssertSubmissionLimitsInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly limits: EffectivePluginLimits
  readonly additionalBytes?: number
  readonly isNewPackage: boolean
}

/** Throw `PluginLimitError('limit-reached')` when growth would exceed submissions / bytes. */
export function assertSubmissionWithinLimits(input: AssertSubmissionLimitsInput): void {
  if (input.isNewPackage && atLimit(input.limits.max_submissions, countUserSubmissions(input.db, input.userId))) {
    throw new PluginLimitError('limit-reached', 'max_submissions', 409)
  }
  const extra = input.additionalBytes ?? 0
  if (extra > 0) {
    const used = countUserSubmissionBytes(input.db, input.userId) + extra
    if (input.limits.max_submission_bytes.value !== null && used > input.limits.max_submission_bytes.value) {
      throw new PluginLimitError('limit-reached', 'max_submission_bytes', 409)
    }
  }
}

/**
 * Best-effort packument gate: refuse a listed package the user does not yet have
 * once the last report reached `max_installed`. Stale/missing reports and already-installed escape.
 */
export function packumentAllowed(opts: {
  readonly maxInstalled: number | null
  readonly installedCount: number | null
  readonly alreadyInstalled: boolean
}): boolean {
  if (opts.alreadyInstalled) return true
  if (opts.maxInstalled === null || opts.installedCount === null) return true
  return opts.installedCount < opts.maxInstalled
}

/** Mark index plugins the user cannot newly install because the last report is at `max_installed`. */
export function markIndexAtLimit(
  index: PersonalizedMarketIndex,
  opts: {
    readonly maxInstalled: number | null
    readonly installedCount: number | null
    readonly installedNames: ReadonlySet<string>
  },
): PersonalizedMarketIndex {
  if (opts.maxInstalled === null || opts.installedCount === null || opts.installedCount < opts.maxInstalled) {
    return index
  }
  const plugins: PersonalizedMarketPlugin[] = index.plugins.map(plugin => {
    if (opts.installedNames.has(plugin.name)) return plugin
    return { ...plugin, 'x-dsh-at-limit': true as const }
  })
  return { ...index, plugins }
}

export interface CreateMarketLookupPackumentOptions {
  readonly groupsFor: (userId: string) => readonly string[]
  /** Underlying packument lookup (catalogue / mirror). */
  readonly lookup: (name: string, userId: string) => unknown | undefined
}

/**
 * Adapter for `MarketRouteDeps.lookupPackument`: refuses a listed package the user
 * does not yet have once the last sync/reconcile report reached `max_installed`.
 * Returns `undefined` (→ 404) when disallowed. Stale/missing reports escape (as designed).
 */
export function createMarketLookupPackument(
  db: PluginsDbHandle,
  options: CreateMarketLookupPackumentOptions,
): (name: string, userId: string) => unknown | undefined {
  return (name: string, userId: string) => {
    const packument = options.lookup(name, userId)
    if (packument === undefined) return undefined
    const groups = options.groupsFor(userId)
    const limits = effectivePluginLimits(listPluginLimitRows(db), userId, groups)
    const installedNames = installedNamesFromReport(db, userId)
    if (!packumentAllowed({
      maxInstalled: limits.max_installed.value,
      installedCount: installedCountFromReport(db, userId),
      alreadyInstalled: installedNames.has(name),
    })) {
      return undefined
    }
    return packument
  }
}

export interface PluginLimitsAdminActor {
  readonly userId: string
  readonly email: string
}

export interface HandlePluginLimitsAdminInput {
  readonly db: PluginsDbHandle
  readonly method: string
  readonly path: string
  readonly actor: PluginLimitsAdminActor
  readonly body?: unknown
  readonly query?: URLSearchParams
  readonly groupsFor?: (userId: string) => readonly string[]
  readonly emailFor?: (userId: string) => string | null
  readonly now?: number
}

/**
 * Identity-backed admin control handlers for
 * `GET|PUT|DELETE /admin/plugins/limits` and `GET /admin/plugins/limits/effective`.
 */
export function handlePluginLimitsAdmin(input: HandlePluginLimitsAdminInput): { status: number; body: unknown } {
  const { method, path } = input
  try {
    if (method === 'GET' && path === '/admin/plugins/limits') {
      return { status: 200, body: listPluginLimits(input.db) }
    }
    if (method === 'GET' && path === '/admin/plugins/limits/effective') {
      const user = input.query?.get('user') ?? ''
      if (user === '') throw new PluginLimitError('user-not-found')
      const groups = input.groupsFor?.(user) ?? []
      const email = input.emailFor?.(user) ?? null
      const rows = listPluginLimitRows(input.db)
      const limits = effectivePluginLimits(rows, user, groups)
      return {
        status: 200,
        body: {
          user: { id: user, email, groups },
          limits,
          usage: {
            installed: installedCountFromReport(input.db, user) ?? 0,
            submissions: countUserSubmissions(input.db, user),
            submissionBytes: countUserSubmissionBytes(input.db, user),
          },
        } satisfies PluginEffectiveView,
      }
    }
    if (method === 'PUT' && path === '/admin/plugins/limits') {
      const body = (input.body ?? {}) as Record<string, unknown>
      const scopeRaw = body.scope as { type: string; id?: string } | undefined
      if (scopeRaw === undefined || scopeRaw === null || typeof scopeRaw !== 'object') {
        throw new PluginLimitError('scope')
      }
      const view = setPluginLimit({
        db: input.db,
        scope: scopeRaw as SetPluginLimitInput['scope'],
        name: body.name as PluginLimitName,
        value: body.value as number | null,
        actor: input.actor.email,
        now: input.now,
        emailFor: input.emailFor,
      })
      return { status: 200, body: view }
    }
    if (method === 'DELETE' && path === '/admin/plugins/limits') {
      const body = (input.body ?? {}) as Record<string, unknown>
      const scopeRaw = body.scope as { type: string; id: string } | undefined
      if (scopeRaw === undefined || scopeRaw === null || typeof scopeRaw !== 'object') {
        throw new PluginLimitError('scope')
      }
      if (scopeRaw.type === 'global') throw new PluginLimitError('global-scope')
      const view = deletePluginLimit({
        db: input.db,
        scope: scopeRaw as DeletePluginLimitInput['scope'],
        name: body.name as PluginLimitName,
        actor: input.actor.email,
        now: input.now,
      })
      return { status: 200, body: view }
    }
    return { status: 404, body: { error: 'not-found' } }
  } catch (error) {
    if (error instanceof PluginLimitError) {
      return {
        status: error.status,
        body: { error: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
      }
    }
    throw error
  }
}
