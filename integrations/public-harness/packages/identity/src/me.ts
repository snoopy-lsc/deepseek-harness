/** Personal center endpoints under `/account/api/me`: the signed-in user's profile, sign-in method, sessions, password and usage.
 * Every request needs a live, verified session; writes also need the configured Origin (checked before this runs) and a JSON body,
 * which a cross-site form cannot send without a preflight. Security-relevant writes are audited. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdentityAuth } from './auth.ts'
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'
import { IdentityUnavailableError } from './transports.ts'

/** The signed-in user's profile and server-decided role, read by the Harness Web shell. */
export const ME_PATH = '/account/api/me'
/** Roles the identity service assigns; only the server decides them. */
export type AccountRole = 'admin' | 'member'
/** How the account signs in: a password (registered or invited), the emergency path, or an SSO provider kind. */
export type SignInMethod = 'password' | 'emergency' | string

/** The user's own token use, as the quota ledger reports it. */
export interface PersonalUsage {
  readonly day: string
  readonly usedTokens: number
  readonly limitTokens: number
  readonly resetAt: string
  readonly history: ReadonlyArray<{ readonly day: string; readonly tokens: number }>
}
/** Read-only source of one user's usage, supplied by the deployment that owns the ledger. */
export type UsageSource = (userId: string) => Promise<PersonalUsage | undefined>

/** A refusal with an HTTP status and a stable code. */
export class MeError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }

/** Collaborators of the personal center routes. */
export interface MeDeps {
  readonly config: IdentityConfig
  readonly auth: IdentityAuth
  readonly database: IdentityDatabase
  readonly clock: () => number
  readonly ip: (req: IncomingMessage) => string
  readonly limit: (key: string, windowMs: number, max: number) => void
  readonly usage?: UsageSource
}

const MAX_BODY = 16 * 1024
const HOUR = 3_600_000
const time = (value: unknown) => typeof value === 'number' ? value : Date.parse(String(value))

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) throw new MeError(415, 'json-only')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > MAX_BODY) throw new MeError(413, 'body-too-large'); chunks.push(chunk) }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new MeError(400, 'body') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MeError(400, 'body')
  return parsed as Record<string, unknown>
}

/** Build the `/account/api/me*` router.
 * @param deps Collaborators.
 * @returns Handler answering true when it served the request.
 */
export function meRoutes(deps: MeDeps): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  const { config, auth, database, clock } = deps
  const admins = new Set(config.admins ?? [])
  const db = database.db
  const listSessions = db.prepare('SELECT id, createdAt, updatedAt, expiresAt, ipAddress, userAgent FROM session WHERE userId = ? ORDER BY updatedAt DESC')
  const deleteOne = db.prepare('DELETE FROM session WHERE id = ? AND userId = ?')
  const deleteOthers = db.prepare('DELETE FROM session WHERE userId = ? AND id <> ?')
  const store = <T>(work: () => T): T => { try { return work() } catch { throw new IdentityUnavailableError('store') } }

  const session = async (req: IncomingMessage) => {
    let result
    try { result = await auth.api.getSession({ headers: new Headers({ cookie: req.headers.cookie ?? '' }), query: { disableCookieCache: true } }) }
    catch { throw new IdentityUnavailableError('store') }
    if (result === null || !result.user.emailVerified) throw new MeError(401, 'unauthenticated')
    return result
  }
  const method = (userId: string) => store(() => {
    const origin = database.sso.origin(userId)
    if (origin === 'sso') return { provider: database.sso.linksOf(userId)[0]?.provider ?? config.sso.kind, passwordChange: false, origin }
    return { provider: origin === 'emergency' ? 'emergency' : 'password', passwordChange: true, origin }
  })
  const audit = (event: 'password-change' | 'session-revoke' | 'sessions-revoke-others', outcome: 'ok' | 'denied', user: { id: string; email: string }, req: IncomingMessage, detail?: string) =>
    store(() => database.sso.audit({ event, outcome, userId: user.id, email: user.email.toLowerCase(), ip: deps.ip(req), ...detail === undefined ? {} : { detail } }, clock()))

  return async (req, res, path) => {
    if (path !== ME_PATH && !path.startsWith(`${ME_PATH}/`)) return false
    const sub = path.slice(ME_PATH.length), verb = req.method ?? 'GET'
    const read = verb === 'GET' || verb === 'HEAD'
    const known = read ? ['', '/security', '/sessions', '/usage'] : ['/sessions/revoke', '/sessions/revoke-others', '/password']
    if (!known.includes(sub)) throw new MeError(read || verb === 'POST' ? 404 : 405, 'not-found')
    const body = read ? undefined : await jsonBody(req)
    const { user, session: current } = await session(req)
    const email = user.email.toLowerCase()
    if (sub === '') {
      const { provider, passwordChange, origin } = method(user.id)
      const role: AccountRole = admins.has(email) || origin === 'emergency' ? 'admin' : 'member'
      send(res, 200, { id: user.id, email, name: user.name, role, provider, passwordChange }); return true
    }
    if (sub === '/security') {
      const { provider, passwordChange } = method(user.id)
      const bindings = store(() => database.sso.linksOf(user.id)).map(link => ({ provider: link.provider, subject: link.subject, createdAt: link.createdAt, lastLoginAt: link.lastLoginAt ?? null }))
      send(res, 200, { provider, passwordChange, bindings }); return true
    }
    if (sub === '/sessions') {
      const rows = store(() => listSessions.all(user.id) as Array<Record<string, unknown>>)
      // Tokens never leave the server; the id is the session's public handle.
      send(res, 200, { sessions: rows.map(row => ({ id: String(row.id), current: row.id === current.id, createdAt: time(row.createdAt), lastActiveAt: time(row.updatedAt),
        expiresAt: time(row.expiresAt), ipAddress: row.ipAddress === null ? null : String(row.ipAddress), userAgent: row.userAgent === null ? null : String(row.userAgent) })) })
      return true
    }
    if (sub === '/usage') {
      const usage = deps.usage === undefined ? undefined : await deps.usage(user.id).catch(() => { throw new IdentityUnavailableError('store') })
      if (usage === undefined) throw new MeError(404, 'usage-unavailable')
      send(res, 200, usage); return true
    }
    deps.limit(`me-write:${user.id}`, HOUR, 60)
    if (sub === '/sessions/revoke') {
      const id = body!.id
      if (typeof id !== 'string' || id.length > 128) throw new MeError(400, 'body')
      // The current session is ended by signing out, which also clears the cookie.
      if (id === current.id) throw new MeError(400, 'current-session')
      const changes = Number(store(() => deleteOne.run(id, user.id)).changes)
      if (changes === 0) throw new MeError(404, 'session-not-found')
      audit('session-revoke', 'ok', user, req); send(res, 200, { revoked: 1 }); return true
    }
    if (sub === '/sessions/revoke-others') {
      const revoked = Number(store(() => deleteOthers.run(user.id, current.id)).changes)
      audit('sessions-revoke-others', 'ok', user, req, `revoked=${revoked}`); send(res, 200, { revoked }); return true
    }
    // Password change: only accounts that sign in with a password; the current password is the re-authentication.
    if (!method(user.id).passwordChange) throw new MeError(403, 'sso-account')
    const { currentPassword, newPassword } = body!
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || currentPassword.length > 256) throw new MeError(400, 'body')
    if (newPassword.length < 12 || newPassword.length > 256) throw new MeError(400, 'password-policy')
    deps.limit(`password-change:${user.id}`, HOUR, 5)
    let result
    try {
      // The session the change mints describes this device, as a sign-in would: the browser's agent and the proxy-reported address.
      const headers = new Headers({ cookie: req.headers.cookie ?? '', 'x-dsh-client-ip': deps.ip(req) })
      if (typeof req.headers['user-agent'] === 'string') headers.set('user-agent', req.headers['user-agent'])
      result = await auth.api.changePassword({ headers, body: { currentPassword, newPassword, revokeOtherSessions: true }, returnHeaders: true })
    } catch (error) {
      const code = (error as { body?: { code?: unknown } }).body?.code
      if (code === 'INVALID_PASSWORD') { audit('password-change', 'denied', user, req, 'reauth'); throw new MeError(403, 'reauth') }
      if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') throw new MeError(400, 'password-policy')
      throw new IdentityUnavailableError('store')
    }
    audit('password-change', 'ok', user, req)
    const cookies = result.headers.getSetCookie()
    send(res, 200, { changed: true }, cookies.length ? { 'set-cookie': cookies } : {})
    return true
  }
}
