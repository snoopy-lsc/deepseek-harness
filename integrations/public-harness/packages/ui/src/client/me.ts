/** The signed-in user's profile as decided by the identity service. */

/** Server-decided account role. */
export type AccountRole = 'admin' | 'member'

/** Profile answered by `GET /account/api/me`. */
export interface AccountProfile { readonly id: string; readonly email: string; readonly name: string; readonly role: AccountRole }

/** Same-origin identity endpoint. */
export const ME_PATH = '/account/api/me'

/** Read the signed-in profile; any failure or malformed answer yields `undefined` so no entry is shown.
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The profile, or `undefined`.
 */
export async function loadProfile(fetcher?: typeof fetch): Promise<AccountProfile | undefined> {
  try {
    const reply = await (fetcher ?? globalThis.fetch)(ME_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (!reply.ok) return undefined
    const body = await reply.json() as Partial<Record<keyof AccountProfile, unknown>>
    if (typeof body.id !== 'string' || typeof body.email !== 'string' || typeof body.name !== 'string') return undefined
    if (body.role !== 'admin' && body.role !== 'member') return undefined
    return { id: body.id, email: body.email, name: body.name, role: body.role }
  } catch { return undefined }
}

/** Editable account details; organization fields are maintained by administrators. */
export interface UserProfile {
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly employeeId: string
  readonly department: string
  readonly jobTitle: string
  readonly avatarUrl: string | null
  readonly managedBy: 'local' | 'sso'
}
/** Contact fields a user may update; SSO names remain directory-owned. */
export interface OwnProfilePatch { readonly name?: string; readonly phone?: string }
/** Contact and organization fields administrators may update. */
export interface AdminProfilePatch extends OwnProfilePatch { readonly employeeId?: string; readonly department?: string; readonly jobTitle?: string }
/** Decoded image bytes are limited to 512 KiB by the server. Null removes an avatar. */
export type AvatarUpload = { readonly mime: 'image/png' | 'image/jpeg' | 'image/webp'; readonly data: string } | { readonly data: null }

/** How the account signs in: `password`, `emergency`, or an SSO provider kind. */
export interface AccountSecurity {
  readonly provider: string
  readonly passwordChange: boolean
  readonly bindings: ReadonlyArray<{ readonly provider: string; readonly subject: string; readonly createdAt: number; readonly lastLoginAt: number | null }>
}
/** One sign-in session; tokens never reach the browser. */
export interface AccountSession {
  readonly id: string
  readonly current: boolean
  readonly createdAt: number
  readonly lastActiveAt: number
  readonly expiresAt: number
  readonly ipAddress: string | null
  readonly userAgent: string | null
}
/** The user's own token use from the quota ledger. */
export interface AccountUsage {
  readonly day: string
  readonly usedTokens: number
  readonly limitTokens: number
  readonly resetAt: string
  readonly history: ReadonlyArray<{ readonly day: string; readonly tokens: number }>
  /** Site over-limit policy: `block` refuses at the limit, `grace` admits a grace share first, `warn` only warns. */
  readonly overLimit?: 'block' | 'grace' | 'warn'
  /** Where the user stands against that policy. */
  readonly state?: 'ok' | 'grace' | 'over' | 'blocked'
  /** Where new requests stop; null when the limit is advisory. */
  readonly hardLimitTokens?: number | null
}

/** A refused personal center request, carrying the server's stable code. */
export class AccountApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }

/** Personal center calls against the identity service. */
export interface AccountApi {
  /** @returns The signed-in account's complete profile. */
  profile(): Promise<UserProfile>
  /** Save only the signed-in account's own contact fields.
   * @param patch - Name and contact phone to replace; SSO names cannot be changed.
   * @returns Complete saved profile.
   */
  updateProfile(patch: OwnProfilePatch): Promise<UserProfile>
  /** Replace or remove the signed-in account's avatar.
   * @param image - Base64 image and MIME type, or null data to remove it.
   * @returns Complete saved profile with an authenticated avatar URL.
   */
  avatar(image: AvatarUpload): Promise<UserProfile>
  security(): Promise<AccountSecurity>
  sessions(): Promise<readonly AccountSession[]>
  /** Undefined when this deployment does not expose usage. */
  usage(): Promise<AccountUsage | undefined>
  revoke(id: string): Promise<void>
  /** @returns How many sessions were ended. */
  revokeOthers(): Promise<number>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
}

/** Create the client; reads are same-origin GETs, writes same-origin JSON POSTs (the server also checks Origin).
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The client.
 */
export function createAccountApi(fetcher?: typeof fetch): AccountApi {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const init: RequestInit = body === undefined
      ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const reply = await (fetcher ?? globalThis.fetch)(`${ME_PATH}${path}`, init)
    let parsed: unknown
    try { parsed = await reply.json() } catch { parsed = undefined }
    if (!reply.ok) {
      const code = (parsed as { code?: unknown } | undefined)?.code
      throw new AccountApiError(reply.status, typeof code === 'string' ? code : String(reply.status))
    }
    return parsed
  }
  return {
    profile: async () => await request('/profile') as UserProfile,
    updateProfile: async patch => await request('/profile', { ...patch.name === undefined ? {} : { name: patch.name }, ...patch.phone === undefined ? {} : { phone: patch.phone } }) as UserProfile,
    avatar: async image => await request('/avatar', image) as UserProfile,
    security: async () => await request('/security') as AccountSecurity,
    sessions: async () => (await request('/sessions') as { sessions: AccountSession[] }).sessions,
    usage: async () => {
      try { return await request('/usage') as AccountUsage } catch (error) { if (error instanceof AccountApiError && error.status === 404) return undefined; throw error }
    },
    revoke: async id => { await request('/sessions/revoke', { id }) },
    revokeOthers: async () => (await request('/sessions/revoke-others', {}) as { revoked: number }).revoked,
    changePassword: async (currentPassword, newPassword) => { await request('/password', { currentPassword, newPassword }) },
  }
}
