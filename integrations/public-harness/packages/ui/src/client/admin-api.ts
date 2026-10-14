/** System administration client for the identity service's `/api/admin` endpoints. The server decides access; this only calls it. */

/** Same-origin administration endpoint root. */
export const ADMIN_PATH = '/api/admin'

export interface AdminInvite { readonly id: string; readonly createdAt: number; readonly expiresAt: number; readonly usedAt: number | null; readonly usedBy: string | null; readonly revokedAt: number | null; readonly note: string | null }
export interface AdminUser {
  readonly id: string; readonly email: string; readonly name: string; readonly createdAt: number | null
  readonly role: 'admin' | 'member'; readonly roleSource: 'config' | 'emergency' | 'grant' | null
  readonly status: 'active' | 'disabled'; readonly disabledAt: number | null; readonly disabledReason: string | null
  readonly provider: string; readonly lastLoginAt: number | null
}
export interface AdminUserPage { readonly total: number; readonly offset: number; readonly limit: number; readonly users: readonly AdminUser[]; readonly self: string }
export interface AdminAuditEntry { readonly id: number; readonly at: number; readonly event: string; readonly outcome: string; readonly userId: string | null; readonly email: string | null; readonly ip: string | null; readonly detail: string | null }
export interface AdminAuditPage { readonly entries: readonly AdminAuditEntry[]; readonly nextBefore: number | null }
export interface AdminSso {
  readonly provider: Record<string, unknown> & { kind: string }
  readonly emergency: { enabled: boolean; allowedIps?: readonly string[] }
  readonly deprovision: { intervalMs: number; maxInactiveDays: number; maxDisablePerRun: number }
  readonly enrollmentOpen: boolean
  readonly adminEmails: readonly string[]
  readonly reconcile: { scheduled: boolean; intervalMs: number; last: { at: number; outcome: string; detail: string | null } | null }
  readonly disabledAccounts: number
}
export interface AdminQuota { readonly configuredDailyTokens: number; readonly defaultDailyTokens: number; readonly defaultOverride?: number; readonly overrides: ReadonlyArray<{ readonly userId: string; readonly dailyTokens: number }> }

/** A refused call; `method` says how to re-authenticate when `code` is `reauth-required` or `reauth`. */
export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly method?: 'password' | 'sso') { super(code) }
}

/** Optional re-authentication proof: the administrator's current password (password accounts only). */
export type Proof = { readonly password?: string }

export interface AdminApi {
  invites(): Promise<readonly AdminInvite[]>
  createInvite(ttlHours: number, note: string): Promise<{ id: string; code: string; expiresAt: number }>
  revokeInvite(id: string): Promise<void>
  users(query: { q?: string; role?: string; status?: string; offset?: number; limit?: number }): Promise<AdminUserPage>
  disable(userId: string, reason: string, proof?: Proof): Promise<void>
  enable(userId: string): Promise<void>
  setRole(userId: string, role: 'admin' | 'member', proof?: Proof): Promise<void>
  audit(query: { event?: string; outcome?: string; q?: string; before?: number; limit?: number }): Promise<AdminAuditPage>
  sso(): Promise<AdminSso>
  /** Undefined when this deployment has no quota ledger connected. */
  quota(): Promise<AdminQuota | undefined>
  setDefaultQuota(dailyTokens: number | null, proof?: Proof): Promise<AdminQuota>
  setUserQuota(userId: string, dailyTokens: number | null, proof?: Proof): Promise<AdminQuota>
}

/** Build the client: same-origin GETs and JSON POSTs.
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The client.
 */
export function createAdminApi(fetcher?: typeof fetch): AdminApi {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const init: RequestInit = body === undefined
      ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const reply = await (fetcher ?? globalThis.fetch)(`${ADMIN_PATH}${path}`, init)
    let parsed: unknown
    try { parsed = await reply.json() } catch { parsed = undefined }
    if (!reply.ok) {
      const { code, method } = (parsed ?? {}) as { code?: unknown; method?: unknown }
      throw new AdminApiError(reply.status, typeof code === 'string' ? code : String(reply.status), method === 'password' || method === 'sso' ? method : undefined)
    }
    return parsed
  }
  const qs = (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
    const text = params.toString()
    return text ? `?${text}` : ''
  }
  const proof = (value?: Proof) => value?.password === undefined ? {} : { password: value.password }
  return {
    invites: async () => (await request('/invites') as { invites: AdminInvite[] }).invites,
    createInvite: async (ttlHours, note) => await request('/invites', { ttlHours, ...note ? { note } : {} }) as { id: string; code: string; expiresAt: number },
    revokeInvite: async id => { await request('/invites/revoke', { id }) },
    users: async query => await request(`/users${qs(query)}`) as AdminUserPage,
    disable: async (userId, reason, p) => { await request('/users/disable', { userId, reason, ...proof(p) }) },
    enable: async userId => { await request('/users/enable', { userId }) },
    setRole: async (userId, role, p) => { await request('/users/role', { userId, role, ...proof(p) }) },
    audit: async query => await request(`/audit${qs(query)}`) as AdminAuditPage,
    sso: async () => await request('/sso') as AdminSso,
    quota: async () => {
      try { return await request('/quota') as AdminQuota } catch (error) { if (error instanceof AdminApiError && error.status === 404) return undefined; throw error }
    },
    setDefaultQuota: async (dailyTokens, p) => await request('/quota/default', { dailyTokens, ...proof(p) }) as AdminQuota,
    setUserQuota: async (userId, dailyTokens, p) => await request('/quota/user', { userId, dailyTokens, ...proof(p) }) as AdminQuota,
  }
}
