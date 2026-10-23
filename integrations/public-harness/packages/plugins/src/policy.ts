/**
 * Plugin market policies on `plugin_policy` (design § Installation and policy).
 * `market_only` / `install_scripts` are phase-1; `egress_lock` is schema/name only (phase 2 — no firewall).
 */
import { writeAuditOutbox } from './audit.ts'
import type { PluginsDbHandle } from './migrate.ts'
import type { PolicyName } from './schema.ts'

export type PluginPolicyName = PolicyName
export const PLUGIN_POLICY_NAMES: readonly PluginPolicyName[] = [
  'market_only',
  'install_scripts',
  'egress_lock',
] as const

/** Flat admin / effective shape (UI `AdminPluginPolicy`). `install_scripts: false` = deny. */
export interface PluginPolicyFlags {
  readonly market_only: boolean
  readonly install_scripts: boolean
  readonly egress_lock: boolean
}

export const DEFAULT_PLUGIN_POLICY: PluginPolicyFlags = {
  market_only: false,
  install_scripts: false,
  egress_lock: false,
}

export interface PluginPolicyRow {
  readonly name: PluginPolicyName
  readonly scopeType: 'global' | 'group'
  readonly scopeId: string
  readonly value: boolean
  readonly updatedBy: string
  readonly updatedAt: number
}

export type PluginPolicyErrorCode =
  | 'scope'
  | 'global-scope'
  | 'name'
  | 'value'
  | 'egress-lock-phase-2'
  | 'not-found'
  | 'body'

export class PluginPolicyError extends Error {
  readonly status: number
  readonly code: PluginPolicyErrorCode
  readonly detail: string | undefined
  constructor(code: PluginPolicyErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (
      code === 'not-found' ? 404
        : code === 'egress-lock-phase-2' ? 400
          : 400
    )
  }
}

const GROUP_ID = /^(oidc|saml|ldap|wecom|dingtalk|local):[^\0\r\n]{1,512}$/

function parseBool(raw: string): boolean {
  if (raw === 'true' || raw === '1' || raw === 'allow') return true
  if (raw === 'false' || raw === '0' || raw === 'deny') return false
  return false
}

function encodeBool(value: boolean, name: PluginPolicyName): string {
  if (name === 'install_scripts') return value ? 'allow' : 'deny'
  return value ? 'true' : 'false'
}

/** List every policy row. */
export function listPluginPolicyRows(db: PluginsDbHandle): PluginPolicyRow[] {
  const rows = db.db.prepare(
    `SELECT name, scope_type, scope_id, value, updated_by, updated_at FROM plugin_policy`,
  ).all() as Array<{
    name: string
    scope_type: string
    scope_id: string
    value: string
    updated_by: string
    updated_at: number | bigint
  }>
  return rows.map(r => ({
    name: r.name as PluginPolicyName,
    scopeType: r.scope_type as PluginPolicyRow['scopeType'],
    scopeId: r.scope_id,
    value: parseBool(r.value),
    updatedBy: r.updated_by,
    updatedAt: Number(r.updated_at),
  }))
}

/**
 * Resolve policies for one user.
 * `market_only` / `install_scripts` turn on when any effective group or the global row is on;
 * default `install_scripts` = deny (false). `egress_lock` is always false in phase 1.
 */
export function effectivePolicy(
  rows: readonly PluginPolicyRow[],
  _userId: string,
  groups: readonly string[],
): PluginPolicyFlags {
  const groupSet = new Set(groups)
  const resolveOr = (name: PluginPolicyName): boolean => {
    let anyGroup = false
    let sawGroup = false
    for (const row of rows) {
      if (row.name !== name || row.scopeType !== 'group') continue
      if (!groupSet.has(row.scopeId)) continue
      sawGroup = true
      if (row.value) anyGroup = true
    }
    if (sawGroup && anyGroup) return true
    if (sawGroup && !anyGroup) {
      // All matching group rows are off — still fall through to global (OR with global).
    }
    const global = rows.find(r => r.name === name && r.scopeType === 'global' && r.scopeId === '*')
    if (global !== undefined) return global.value || anyGroup
    return anyGroup
  }

  return {
    market_only: resolveOr('market_only'),
    install_scripts: resolveOr('install_scripts'),
    // Phase 2: schema/name only — never effective in phase 1 (no firewall mutation).
    egress_lock: false,
  }
}

/** Global company policy as shown in System Admin > Policy. */
export function getGlobalPluginPolicy(db: PluginsDbHandle): PluginPolicyFlags {
  const rows = listPluginPolicyRows(db)
  const pick = (name: PluginPolicyName): boolean => {
    const found = rows.find(r => r.name === name && r.scopeType === 'global' && r.scopeId === '*')
    return found === undefined ? DEFAULT_PLUGIN_POLICY[name] : found.value
  }
  return {
    market_only: pick('market_only'),
    install_scripts: pick('install_scripts'),
    // Never surface a stored true until phase 2 implements the boundary.
    egress_lock: false,
  }
}

function assertScope(
  scope: { type: string; id?: string },
  allowGlobal: boolean,
): { type: 'global' | 'group'; id: string } {
  if (scope.type === 'global' && allowGlobal) return { type: 'global', id: '*' }
  if (scope.type === 'group' && typeof scope.id === 'string' && GROUP_ID.test(scope.id)) {
    return { type: 'group', id: scope.id }
  }
  throw new PluginPolicyError(scope.type === 'global' ? 'global-scope' : 'scope')
}

function assertName(raw: unknown): PluginPolicyName {
  if (!(PLUGIN_POLICY_NAMES as readonly unknown[]).includes(raw)) throw new PluginPolicyError('name')
  return raw as PluginPolicyName
}

function assertBool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new PluginPolicyError('value')
  return value
}

function getRow(
  db: PluginsDbHandle,
  scopeType: 'global' | 'group',
  scopeId: string,
  name: PluginPolicyName,
): PluginPolicyRow | undefined {
  const r = db.db.prepare(
    `SELECT name, scope_type, scope_id, value, updated_by, updated_at
     FROM plugin_policy WHERE name = ? AND scope_type = ? AND scope_id = ?`,
  ).get(name, scopeType, scopeId) as {
    name: string
    scope_type: string
    scope_id: string
    value: string
    updated_by: string
    updated_at: number | bigint
  } | undefined
  if (r === undefined) return undefined
  return {
    name: r.name as PluginPolicyName,
    scopeType: r.scope_type as PluginPolicyRow['scopeType'],
    scopeId: r.scope_id,
    value: parseBool(r.value),
    updatedBy: r.updated_by,
    updatedAt: Number(r.updated_at),
  }
}

export interface SetPluginPolicyRowInput {
  readonly db: PluginsDbHandle
  readonly name: PluginPolicyName
  readonly scope: { readonly type: 'global' | 'group'; readonly id?: string }
  readonly value: boolean
  readonly actor: string
  readonly now?: number
}

/**
 * Upsert one policy row. Refuses `egress_lock = true` (phase 2 stub — no firewall).
 * Audits `admin-plugin-policy-change`.
 */
export function setPluginPolicyRow(input: SetPluginPolicyRowInput): PluginPolicyFlags {
  const name = assertName(input.name)
  const value = assertBool(input.value)
  if (name === 'egress_lock' && value === true) {
    throw new PluginPolicyError('egress-lock-phase-2')
  }
  const scope = assertScope(input.scope, true)
  const now = input.now ?? Date.now()
  const before = getRow(input.db, scope.type, scope.id, name)
  const encoded = encodeBool(value, name)
  input.db.db.prepare(
    `INSERT INTO plugin_policy (name, scope_type, scope_id, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, scope_type, scope_id) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(name, scope.type, scope.id, encoded, input.actor, now)
  const show = (v: boolean | undefined) => v === undefined ? 'unset' : v ? 'on' : 'off'
  writeAuditOutbox(input.db, {
    at: now,
    event: 'admin-plugin-policy-change',
    outcome: 'ok',
    actor: input.actor,
    detail: `policy=${name} scope=${scope.type}:${scope.id.slice(0, 200)} old=${show(before?.value)} new=${show(value)}`,
  })
  return getGlobalPluginPolicy(input.db)
}

export interface SetPluginPolicyInput {
  readonly db: PluginsDbHandle
  readonly policy: PluginPolicyFlags
  readonly actor: string
  readonly now?: number
  /** Defaults to global `*`. */
  readonly scope?: { readonly type: 'global' | 'group'; readonly id?: string }
}

/**
 * Write the flat admin policy (global by default). Refuses enabling `egress_lock`.
 */
export function setPluginPolicy(input: SetPluginPolicyInput): PluginPolicyFlags {
  const scope = input.scope ?? { type: 'global' as const, id: '*' }
  if (input.policy.egress_lock === true) {
    throw new PluginPolicyError('egress-lock-phase-2')
  }
  const now = input.now ?? Date.now()
  for (const name of PLUGIN_POLICY_NAMES) {
    if (name === 'egress_lock') {
      // Persist false / ignore — never store true in phase 1.
      setPluginPolicyRow({
        db: input.db,
        name,
        scope,
        value: false,
        actor: input.actor,
        now,
      })
      continue
    }
    setPluginPolicyRow({
      db: input.db,
      name,
      scope,
      value: input.policy[name],
      actor: input.actor,
      now,
    })
  }
  return getGlobalPluginPolicy(input.db)
}

export interface PluginPolicyAdminActor {
  readonly userId: string
  readonly email: string
}

export interface HandlePluginPolicyAdminInput {
  readonly db: PluginsDbHandle
  readonly method: string
  readonly path: string
  readonly actor: PluginPolicyAdminActor
  readonly body?: unknown
  readonly now?: number
}

/**
 * Identity-backed admin control handlers for `GET|PUT /admin/plugins/policy`.
 */
export function handlePluginPolicyAdmin(input: HandlePluginPolicyAdminInput): { status: number; body: unknown } {
  const { method, path } = input
  try {
    if (method === 'GET' && path === '/admin/plugins/policy') {
      return { status: 200, body: getGlobalPluginPolicy(input.db) }
    }
    if (method === 'PUT' && path === '/admin/plugins/policy') {
      const body = (input.body ?? {}) as Record<string, unknown>
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new PluginPolicyError('body')
      }
      if (body.egress_lock === true) {
        throw new PluginPolicyError('egress-lock-phase-2')
      }
      const policy: PluginPolicyFlags = {
        market_only: assertBool(body.market_only),
        install_scripts: assertBool(body.install_scripts),
        egress_lock: assertBool(body.egress_lock ?? false),
      }
      const view = setPluginPolicy({
        db: input.db,
        policy,
        actor: input.actor.email,
        now: input.now,
      })
      return { status: 200, body: view }
    }
    return { status: 404, body: { error: 'not-found' } }
  } catch (error) {
    if (error instanceof PluginPolicyError) {
      return {
        status: error.status,
        body: { error: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
      }
    }
    throw error
  }
}

function normalizeRegistry(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase()
}

/**
 * Under `market_only`, registry specs outside the user mirror fail closed with not-found
 * (soft policy — no `egress_lock` / firewall required).
 */
export function assertRegistryUnderMarketOnly(input: {
  readonly marketOnly: boolean
  readonly registry: string
  readonly mirrorRegistry: string
}): void {
  if (!input.marketOnly) return
  if (normalizeRegistry(input.registry) !== normalizeRegistry(input.mirrorRegistry)) {
    throw new PluginPolicyError('not-found', input.registry, 404)
  }
}

/**
 * Bind resolved `market_only` into provisioner / contracts market-file writers
 * (`renderInstanceMarketNpmrc`, `pluginMarketRows`).
 */
export function instanceMarketOptionsFromPolicy<T extends Record<string, unknown>>(
  policy: PluginPolicyFlags,
  options: T,
): T & { marketOnly: boolean } {
  return { ...options, marketOnly: policy.market_only }
}
