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
