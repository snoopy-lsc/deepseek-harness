/** Private session lookup: router → identity over a Unix socket that the HTTPS proxy never exposes. */
import { parseUserId, type UserId } from '@public-harness/contracts'

/** Branded Better Auth session row ID. */
export type SessionId = string & { readonly __brand: 'PublicHarnessSessionId' }
/** A live, verified session. */
export interface SessionLookup { readonly userId: UserId; readonly sessionId: SessionId; readonly expiresAt: number }

/** Largest accepted request body (a cookie header) and response. */
export const MAX_SESSION_WIRE_BYTES = 8192
/** The only internal route. */
export const SESSION_PATH = '/internal/session'

/** Validate a session ID received across the wire.
 * @param value Received ID.
 * @returns Branded ID.
 */
export function parseSessionId(value: unknown): SessionId {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid session ID')
  return value as SessionId
}

/** Strictly parse a lookup response body.
 * @param value Parsed JSON.
 * @returns Session lookup.
 */
export function parseSessionLookup(value: unknown): SessionLookup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid session response')
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join(',') !== 'expiresAt,sessionId,userId' || typeof r.expiresAt !== 'number' || !Number.isSafeInteger(r.expiresAt)
    || typeof r.userId !== 'string') throw new Error('invalid session response')
  return { userId: parseUserId(r.userId), sessionId: parseSessionId(r.sessionId), expiresAt: r.expiresAt }
}
