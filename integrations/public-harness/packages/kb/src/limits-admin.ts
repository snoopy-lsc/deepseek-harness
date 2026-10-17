/** System Admin knowledge base limits: the global values and every group and user override, set and delete with old and new values
 * in the audit log, and one user's effective limits with their source and usage. Identity checks that a group scope names a known
 * group before forwarding; here group IDs are checked by shape and users against the principal projection. */
import { KbError } from './errors.ts'
import type { KbRoutes } from './server.ts'
import { usageOf, type KbCore } from './service.ts'
import { LIMIT_NAMES, type LimitName, type LimitRow } from './store.ts'

const GROUP_ID = /^(oidc|saml|ldap|wecom|dingtalk|local):[^\0\r\n]{1,512}$/
/** Allowed range of each limit (inclusive). */
export const LIMIT_RANGE: Record<LimitName, readonly [number, number]> = { max_kbs: [1, 10_000], max_bytes: [1024 * 1024, 1024 ** 4], max_pages: [1, 1_000_000] }
const show = (value: number | null | undefined) => value === undefined ? 'inherit' : value === null ? 'unlimited' : String(value)

/** Limit routes. */
export function limitsModule(core: KbCore): KbRoutes {
  const { store, clock } = core
  const scopeOf = (raw: unknown, allowGlobal: boolean): { type: LimitRow['scopeType']; id: string } => {
    const scope = raw as Record<string, unknown> | undefined
    if (scope === undefined || scope === null || typeof scope !== 'object') throw new KbError(400, 'scope')
    if (scope.type === 'global' && allowGlobal) return { type: 'global', id: '*' }
    if (scope.type === 'group' && typeof scope.id === 'string' && GROUP_ID.test(scope.id)) return { type: 'group', id: scope.id }
    if (scope.type === 'user' && typeof scope.id === 'string' && store.principals.get(scope.id) !== undefined) return { type: 'user', id: scope.id }
    throw new KbError(400, scope.type === 'global' ? 'global-scope' : 'scope')
  }
  const nameOf = (raw: unknown): LimitName => {
    if (!(LIMIT_NAMES as readonly unknown[]).includes(raw)) throw new KbError(400, 'name')
    return raw as LimitName
  }
  const view = () => {
    const rows = store.limits.list()
    const global = Object.fromEntries(LIMIT_NAMES.map(name => [name, rows.find(r => r.scopeType === 'global' && r.name === name)?.value ?? null]))
    const overrides = new Map<string, { scope: { type: 'group' | 'user'; id: string; email?: string | null }; values: Partial<Record<LimitName, number | null>>; updatedAt: number }>()
    for (const row of rows) {
      if (row.scopeType === 'global') continue
      const key = `${row.scopeType}:${row.scopeId}`
      const entry = overrides.get(key) ?? { scope: { type: row.scopeType, id: row.scopeId, ...row.scopeType === 'user' ? { email: store.principals.get(row.scopeId)?.email ?? null } : {} }, values: {}, updatedAt: 0 }
      entry.values[row.name] = row.value
      entry.updatedAt = Math.max(entry.updatedAt, row.updatedAt)
      overrides.set(key, entry)
    }
    return { global, overrides: [...overrides.values()], ranges: LIMIT_RANGE }
  }
  return {
    'GET /admin/kb/limits': async () => view(),
    'PUT /admin/kb/limits': async req => {
      const body = await req.json()
      const scope = scopeOf(body.scope, true), name = nameOf(body.name)
      const value = body.value
      if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < LIMIT_RANGE[name][0] || value > LIMIT_RANGE[name][1])) throw new KbError(400, 'value', { range: LIMIT_RANGE[name] })
      const before = store.limits.get(scope.type, scope.id, name)
      store.limits.set(scope.type, scope.id, name, value, req.actor.email, clock())
      core.audit('admin-kb-limit-change', req.actor.email, `scope=${scope.type}:${scope.id.slice(0, 200)} limit=${name} old=${show(before?.value)} new=${show(value)}`,
        { userId: scope.type === 'user' ? scope.id : null })
      return view()
    },
    'DELETE /admin/kb/limits': async req => {
      const body = await req.json()
      const scope = scopeOf(body.scope, false), name = nameOf(body.name)
      const before = store.limits.get(scope.type, scope.id, name)
      if (before === undefined) throw new KbError(404, 'override-not-found')
      store.limits.delete(scope.type, scope.id, name)
      core.audit('admin-kb-limit-delete', req.actor.email, `scope=${scope.type}:${scope.id.slice(0, 200)} limit=${name} old=${show(before.value)} new=inherit`,
        { userId: scope.type === 'user' ? scope.id : null })
      return view()
    },
    'GET /admin/kb/limits/effective': async ({ query }) => {
      const user = query.get('user') ?? ''
      const principal = store.principals.get(user)
      if (principal === undefined) throw new KbError(404, 'user-not-found')
      return { user: { id: user, email: principal.email, groups: principal.groups }, ...usageOf(core, user) }
    },
  }
}
