/** System administration client for the identity service's `/api/admin` endpoints. The server decides access; this only calls it. */

/** Same-origin administration endpoint root. */
export const ADMIN_PATH = '/api/admin'

export interface AdminInvite { readonly id: string; readonly createdAt: number; readonly expiresAt: number; readonly usedAt: number | null; readonly usedBy: string | null; readonly revokedAt: number | null; readonly note: string | null }
export interface AdminUser {
  readonly id: string; readonly email: string; readonly name: string; readonly createdAt: number | null
  readonly role: 'admin' | 'member'; readonly roleSource: 'config' | 'emergency' | 'grant' | null
  readonly status: 'active' | 'disabled'; readonly disabledAt: number | null; readonly disabledReason: string | null
  readonly provider: string; readonly lastLoginAt: number | null
  /** Direct group memberships (IDs); absent from older servers. */
  readonly groups?: readonly string[]
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
export interface AdminQuota { readonly configuredDailyTokens: number; readonly defaultDailyTokens: number; readonly defaultOverride?: number; readonly overrides: ReadonlyArray<{ readonly userId: string; readonly dailyTokens: number }>
  readonly overLimit?: { readonly mode: OverLimitMode; readonly gracePercent: number } }
/** One synced or local group. */
export interface AdminGroup { readonly id: string; readonly source: 'oidc' | 'saml' | 'ldap' | 'wecom' | 'dingtalk' | 'local'; readonly externalId: string
  readonly displayName: string | null; readonly parentId: string | null; readonly members: number; readonly updatedAt: number }
export interface AdminGroupMember { readonly userId: string; readonly email: string | null; readonly name: string | null }
/** A knowledge base scope entry: the whole company, a group ID, or a user ID. */
export interface KbScopeEntry { readonly kind: 'company' | 'group' | 'user'; readonly target: string }
/** One share request in the approval queue. */
export interface AdminKbRequest {
  readonly id: string; readonly kbId: string; readonly commitSha: string; readonly submittedBy: string; readonly submittedByEmail: string | null; readonly submittedAt: number
  readonly note: string; readonly state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired'; readonly decidedAt: number | null; readonly reason: string | null
  readonly kb: { readonly id: string; readonly title: string; readonly kind: 'personal' | 'org'; readonly ownerUserId: string | null; readonly ownerEmail: string | null }
  readonly current: { readonly snapshotId: string; readonly publishedAt: number; readonly scope: readonly KbScopeEntry[] } | null
  readonly files?: number; readonly bytes?: number
}
export interface AdminKbRequestContent {
  readonly request: AdminKbRequest
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly status: 'added' | 'changed' | 'same' }>
  readonly removed: readonly string[]; readonly log: string
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly op: string; readonly state: string; readonly finishedAt: number | null; readonly lint: number }>
}
export interface AdminKbFile { readonly path: string; readonly bytes: number; readonly text: string | null; readonly previous: string | null; readonly binary: boolean }
export type KbLimitName = 'max_kbs' | 'max_bytes' | 'max_pages'
export interface KbLimitScope { readonly type: 'global' | 'group' | 'user'; readonly id: string }
export interface AdminKbLimits {
  readonly global: Record<KbLimitName, number | null>
  readonly overrides: ReadonlyArray<{ readonly scope: { readonly type: 'group' | 'user'; readonly id: string; readonly email?: string | null }; readonly values: Partial<Record<KbLimitName, number | null>>; readonly updatedAt: number }>
  readonly ranges: Record<KbLimitName, readonly [number, number]>
}
export interface AdminKbEffective {
  readonly user: { readonly id: string; readonly email: string | null; readonly groups: readonly string[] }
  readonly limits: Record<KbLimitName, { readonly value: number | null; readonly source: string }>
  readonly usage: { readonly kbs: number; readonly maxBytes: number; readonly maxPages: number }
  readonly over: ReadonlyArray<{ readonly limit: KbLimitName; readonly kbId?: string; readonly value: number; readonly allowed: number }>
}
/** One knowledge base in the inventory. */
export interface AdminKb {
  readonly id: string; readonly kind: 'personal' | 'org'; readonly title: string; readonly description: string; readonly ownerUserId: string | null; readonly ownerEmail: string | null
  readonly bytes: number; readonly pages: number; readonly sources: number; readonly createdAt: number; readonly updatedAt: number; readonly archivedAt: number | null
  readonly share: { readonly state: 'private' | 'pending' | 'published' | 'revoked'; readonly publishedAt: number | null; readonly scope: readonly KbScopeEntry[]; readonly pendingRequest: string | null
    readonly snapshot: { readonly id: string; readonly commitSha: string; readonly includesRaw: boolean } | null }
  readonly over: ReadonlyArray<{ readonly limit: KbLimitName; readonly value: number; readonly allowed: number }>
  readonly convertedTo: string | null; readonly convertedFrom: string | null; readonly chargedTo: string | null
  readonly lastJob: { readonly id: string; readonly op: string; readonly state: string; readonly finishedAt: number | null } | null
}
export interface AdminKbContent {
  readonly kb: AdminKb; readonly head?: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }> | null
  readonly history: ReadonlyArray<{ readonly sha: string; readonly at: number; readonly subject: string; readonly published: boolean }> | null
}
export interface AdminKbPreview { readonly user: { readonly id: string; readonly email: string | null; readonly groups: readonly string[]; readonly disabled: boolean }
  readonly kbs: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: 'personal' | 'org'; readonly name: string; readonly path: string }> }
/** What the quota proxy does when a user reaches the personal daily limit. */
export type OverLimitMode = 'block' | 'grace' | 'warn'

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
  setOverLimit(mode: OverLimitMode, gracePercent: number, proof?: Proof): Promise<AdminQuota>
  /** Download address of the CSV export for these audit filters (same-origin; the browser's session authenticates it). */
  auditCsvUrl(query: { event?: string; outcome?: string; q?: string }): string
  groups(): Promise<readonly AdminGroup[]>
  groupMembers(id: string): Promise<readonly AdminGroupMember[]>
  createGroup(name: string): Promise<AdminGroup>
  /** Rename a local group, or set (null clears) the alias of a synced one. */
  nameGroup(id: string, op: 'rename' | 'alias', name: string | null): Promise<AdminGroup>
  deleteGroup(id: string, proof?: Proof): Promise<void>
  setGroupMember(groupId: string, userId: string, op: 'add' | 'remove', proof?: Proof): Promise<void>
  kbRequests(state: 'pending' | 'all'): Promise<readonly AdminKbRequest[]>
  kbRequestContent(id: string): Promise<AdminKbRequestContent>
  /** Reading a file is audited (`admin-kb-content-read`). */
  kbRequestFile(id: string, path: string): Promise<AdminKbFile>
  approveKb(id: string, scope: readonly KbScopeEntry[], includeRaw: boolean, proof?: Proof): Promise<void>
  rejectKb(id: string, reason: string): Promise<void>
  setKbScope(kbId: string, scope: readonly KbScopeEntry[], proof?: Proof): Promise<void>
  revokeKb(kbId: string, proof?: Proof): Promise<void>
  kbInventory(filter: 'all' | 'over' | 'published' | 'pending' | 'archived'): Promise<{ kbs: readonly AdminKb[]; totals: { all: number; over: number; archived: number } }>
  /** Archive an org KB (out of every reader's view, read-only) or restore it as it was. */
  archiveOrgKb(kb: string, proof?: Proof): Promise<AdminKb>
  restoreOrgKb(kb: string, proof?: Proof): Promise<AdminKb>
  kbPreview(userId: string): Promise<AdminKbPreview>
  kbContent(kb: string, path?: string, rev?: string): Promise<AdminKbContent & AdminKbFile>
  createOrgKb(title: string, description: string, proof?: Proof): Promise<AdminKb>
  uploadOrgSource(kb: string, file: { name: string; data: Blob }): Promise<void>
  editOrgPage(kb: string, path: string, text: string, message: string): Promise<void>
  compileOrgKb(kb: string, op: 'ingest' | 'lint' | 'rebuild'): Promise<void>
  /** Publish HEAD, or an earlier commit (rollback). */
  publishOrgKb(kb: string, commit: string | undefined, scope: readonly KbScopeEntry[] | undefined, proof?: Proof): Promise<void>
  convertKb(kb: string, proof?: Proof): Promise<AdminKb>
  kbLimits(): Promise<AdminKbLimits>
  setKbLimit(scope: KbLimitScope, name: KbLimitName, value: number | null, proof?: Proof): Promise<AdminKbLimits>
  deleteKbLimit(scope: KbLimitScope, name: KbLimitName, proof?: Proof): Promise<AdminKbLimits>
  kbEffective(userId: string): Promise<AdminKbEffective>
  /** Raw JSON call for the knowledge-base client (same error handling). */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown>
}

/** Build the client: same-origin GETs and JSON POSTs.
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The client.
 */
export function createAdminApi(fetcher?: typeof fetch): AdminApi {
  const request = async (path: string, body?: unknown, method?: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<unknown> => {
    const init: RequestInit = body === undefined && (method === undefined || method === 'GET')
      ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: method ?? 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
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
    setOverLimit: async (mode, gracePercent, p) => await request('/quota/over-limit', { mode, gracePercent, ...proof(p) }) as AdminQuota,
    auditCsvUrl: query => `${ADMIN_PATH}/audit.csv${qs(query)}`,
    groups: async () => (await request('/groups') as { groups: AdminGroup[] }).groups,
    groupMembers: async id => (await request(`/groups/members${qs({ group: id })}`) as { members: AdminGroupMember[] }).members,
    createGroup: async name => (await request('/groups', { op: 'create', name }) as { group: AdminGroup }).group,
    nameGroup: async (id, op, name) => (await request('/groups', { op, id, name }) as { group: AdminGroup }).group,
    deleteGroup: async (id, p) => { await request('/groups', { op: 'delete', id, ...proof(p) }) },
    setGroupMember: async (groupId, userId, op, p) => { await request('/groups/members', { op, groupId, userId, ...proof(p) }) },
    kbRequests: async state => (await request(`/kb/requests${qs({ state })}`) as { requests: AdminKbRequest[] }).requests,
    kbRequestContent: async id => await request(`/kb/requests/content${qs({ id })}`) as AdminKbRequestContent,
    kbRequestFile: async (id, path) => await request(`/kb/requests/content${qs({ id, path })}`) as AdminKbFile,
    approveKb: async (id, scope, includeRaw, p) => { await request('/kb/requests/approve', { id, scope, includeRaw, ...proof(p) }) },
    rejectKb: async (id, reason) => { await request('/kb/requests/reject', { id, reason }) },
    setKbScope: async (kb, scope, p) => { await request('/kb/scope', { kb, scope, ...proof(p) }) },
    revokeKb: async (kb, p) => { await request('/kb/revoke', { kb, ...proof(p) }) },
    kbInventory: async filter => await request(`/kb${qs({ filter })}`) as { kbs: AdminKb[]; totals: { all: number; over: number; archived: number } },
    archiveOrgKb: async (kb, p) => (await request('/kb/org/archive', { kb, ...proof(p) }) as { kb: AdminKb }).kb,
    restoreOrgKb: async (kb, p) => (await request('/kb/org/restore', { kb, ...proof(p) }) as { kb: AdminKb }).kb,
    kbPreview: async user => await request(`/kb/preview${qs({ user })}`) as AdminKbPreview,
    kbContent: async (kb, path, rev) => await request(`/kb/content${qs({ kb, path, rev })}`) as AdminKbContent & AdminKbFile,
    createOrgKb: async (title, description, p) => (await request('/kb/org', { title, description, ...proof(p) }) as { kb: AdminKb }).kb,
    uploadOrgSource: async (kb, file) => {
      const reply = await (fetcher ?? globalThis.fetch)(`${ADMIN_PATH}/kb/org/sources${qs({ kb, name: file.name })}`,
        { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/octet-stream' }, body: file.data })
      if (!reply.ok) { const parsed = await reply.json().catch(() => ({})) as { code?: unknown }; throw new AdminApiError(reply.status, typeof parsed.code === 'string' ? parsed.code : String(reply.status)) }
    },
    editOrgPage: async (kb, path, text, message) => { await request('/kb/org/edit', { kb, path, text, ...message ? { message } : {} }) },
    compileOrgKb: async (kb, op) => { await request('/kb/org/compile', { kb, op }) },
    publishOrgKb: async (kb, commit, scope, p) => { await request('/kb/org/rollback', { kb, ...commit ? { commit } : {}, ...scope ? { scope } : {}, ...proof(p) }) },
    convertKb: async (kb, p) => (await request('/kb/convert', { kb, ...proof(p) }) as { kb: AdminKb }).kb,
    kbLimits: async () => await request('/kb/limits') as AdminKbLimits,
    setKbLimit: async (scope, name, value, p) => await request('/kb/limits', { scope, name, value, ...proof(p) }, 'PUT') as AdminKbLimits,
    deleteKbLimit: async (scope, name, p) => await request('/kb/limits', { scope, name, ...proof(p) }, 'DELETE') as AdminKbLimits,
    kbEffective: async user => await request(`/kb/limits/effective${qs({ user })}`) as AdminKbEffective,
    call: (method, path, body) => request(path, body, method),
  }
}
