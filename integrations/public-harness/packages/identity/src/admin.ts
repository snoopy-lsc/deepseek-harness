/** System administration endpoints under `/api/admin`: invites, users (disable, enable, role), the audit log, the SSO configuration
 * (read-only, secrets redacted) and daily token allowances.
 *
 * Every request: a live verified session whose account is an administrator (401 without a session, 403 for anyone else), checked before
 * the body is read. Writes also need the configured Origin (checked by the public handler before this runs) and a JSON body (415 otherwise),
 * are rate limited per administrator and leave an audit row naming the acting administrator.
 *
 * Re-authentication for disable, role change and allowance change: an administrator who signs in with a password sends it again as
 * `password` (verified by Better Auth); an SSO administrator's session must have started within the last ten minutes, otherwise the reply is
 * 401 `reauth-required` with `method: 'sso'` and the console offers a fresh SSO sign-in. Enabling an account and invite changes are not
 * re-authenticated: they restore or grant nothing beyond what an invite already allows, and each is audited. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IdentityAuth } from './auth.ts'
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'
import { MeError } from './me.ts'
import type { QuotaAdmin } from './quota-account.ts'
import { createRoles } from './roles.ts'
import type { AuditEvent } from './sso/store.ts'
import { IdentityUnavailableError } from './transports.ts'

export const ADMIN_PATH = '/api/admin'
/** How long an SSO sign-in counts as a fresh re-authentication. */
export const SSO_REAUTH_WINDOW_MS = 10 * 60_000
const HOUR = 3_600_000
const MAX_BODY = 16 * 1024

/** A refusal carrying extra reply fields (for example the re-authentication method). */
export class AdminError extends MeError { constructor(status: number, code: string, readonly extra: Record<string, string> = {}) { super(status, code) } }

/** Endpoints, by method; used by the routing table and by the test that proves members are refused everywhere. */
export const ADMIN_ENDPOINTS = {
  GET: ['/invites', '/users', '/audit', '/sso', '/quota'],
  POST: ['/invites', '/invites/revoke', '/users/disable', '/users/enable', '/users/role', '/quota/default', '/quota/user'],
} as const

/** Collaborators of the admin routes. */
export interface AdminDeps {
  readonly config: IdentityConfig
  readonly auth: IdentityAuth
  readonly database: IdentityDatabase
  readonly clock: () => number
  readonly ip: (req: IncomingMessage) => string
  readonly limit: (key: string, windowMs: number, max: number) => void
  readonly quota?: QuotaAdmin
}

const time = (value: unknown) => value === null || value === undefined ? null : typeof value === 'number' ? value : Date.parse(String(value))
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
const SECRET_FIELD = /secret|password|key|cert/i
/** Copy a provider configuration with every secret-like field replaced; certificates are reported by count only. */
export function redactSso(sso: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(sso)) {
    if (name === 'idpCerts' && Array.isArray(value)) out[name] = `${value.length} pinned`
    else if (name === 'signing' || name === 'decryption' || name === 'ca') out[name] = value === undefined ? undefined : 'configured'
    else if (SECRET_FIELD.test(name)) out[name] = '[redacted]'
    else out[name] = value
  }
  return out
}

/** Build the `/api/admin/*` router.
 * @param deps Collaborators.
 * @returns Handler answering true when it served the request.
 */
export function adminRoutes(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  const { config, auth, database, clock } = deps
  const db = database.db
  const roles = createRoles(config, database)
  const store = <T>(work: () => T): T => { try { return work() } catch (error) { if (error instanceof MeError) throw error; throw new IdentityUnavailableError('store') } }
  const userById = db.prepare('SELECT id, email, name, createdAt FROM user WHERE id = ?')
  const allUsers = db.prepare("SELECT id, email, name, createdAt FROM user WHERE (?1 = '' OR lower(email) LIKE ?1 ESCAPE '\\' OR lower(name) LIKE ?1 ESCAPE '\\') ORDER BY createdAt")
  const lastSession = db.prepare('SELECT max(createdAt) AS at FROM session WHERE userId = ?')
  // Sessions disappear on sign-out, expiry and disable; the last sign-in seen is kept so a disabled account still shows it.
  db.exec('CREATE TABLE IF NOT EXISTS dsh_last_login (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
  const keepLogin = db.prepare('INSERT INTO dsh_last_login (user_id, at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET at = max(at, excluded.at)')
  const keptLogin = db.prepare('SELECT at FROM dsh_last_login WHERE user_id = ?')
  const lastLogin = (id: string): number | null => {
    const live = time((lastSession.get(id) as { at: unknown } | undefined)?.at)
    if (live !== null && !Number.isNaN(live)) keepLogin.run(id, live)
    const kept = (keptLogin.get(id) as { at: number } | undefined)?.at
    return kept ?? null
  }
  const auditPage = db.prepare(`SELECT id, at, event, outcome, user_id, email, ip, detail FROM dsh_audit
    WHERE (?1 = '' OR event = ?1) AND (?2 = '' OR outcome = ?2) AND (?3 = '' OR lower(coalesce(email, '')) LIKE ?3 ESCAPE '\\' OR lower(coalesce(detail, '')) LIKE ?3 ESCAPE '\\')
    AND (?4 = 0 OR id < ?4) ORDER BY id DESC LIMIT ?5`)
  const lastReconcile = db.prepare("SELECT at, outcome, detail FROM dsh_audit WHERE event = 'sso-reconcile' ORDER BY id DESC LIMIT 1")

  const audit = (event: AuditEvent['event'], outcome: AuditEvent['outcome'], actor: string, req: IncomingMessage, target?: { id: string; email: string }, detail = '') =>
    store(() => database.sso.audit({ event, outcome, ip: deps.ip(req), ...target === undefined ? {} : { userId: target.id, email: target.email },
      detail: `by=${actor}${detail ? ` ${detail}` : ''}` }, clock()))

  const adminSession = async (req: IncomingMessage) => {
    let result
    try { result = await auth.api.getSession({ headers: new Headers({ cookie: req.headers.cookie ?? '' }), query: { disableCookieCache: true } }) }
    catch { throw new IdentityUnavailableError('store') }
    if (result === null || !result.user.emailVerified) throw new MeError(401, 'unauthenticated')
    const email = result.user.email.toLowerCase()
    if (store(() => roles.role(result.user.id, email)) !== 'admin' || store(() => database.sso.disabledAt(result.user.id)) !== undefined) throw new MeError(403, 'forbidden')
    return { ...result, email }
  }
  type Session = Awaited<ReturnType<typeof adminSession>>

  const reauth = async (req: IncomingMessage, session: Session, body: Record<string, unknown>, action: string) => {
    if (store(() => database.sso.origin(session.user.id)) === 'sso') {
      if (clock() - time(session.session.createdAt)! <= SSO_REAUTH_WINDOW_MS) return
      throw new AdminError(401, 'reauth-required', { method: 'sso' })
    }
    const password = body.password
    if (typeof password !== 'string' || password.length === 0) throw new AdminError(401, 'reauth-required', { method: 'password' })
    if (password.length > 256) throw new MeError(400, 'body')
    deps.limit(`admin-reauth:${session.user.id}`, HOUR, 10)
    let ok = false
    try { ok = (await auth.api.verifyPassword({ headers: new Headers({ cookie: req.headers.cookie ?? '' }), body: { password } }) as { status?: boolean }).status === true }
    catch (error) { if ((error as { body?: { code?: unknown } }).body?.code === undefined) throw new IdentityUnavailableError('store') }
    if (!ok) { audit('admin-reauth', 'denied', session.email, req, undefined, action); throw new AdminError(403, 'reauth', { method: 'password' }) }
  }

  const target = (body: Record<string, unknown>) => {
    const id = body.userId
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new MeError(400, 'body')
    const row = store(() => userById.get(id) as { id: string; email: string } | undefined)
    if (row === undefined) throw new MeError(404, 'user-not-found')
    return { id: row.id, email: row.email.toLowerCase() }
  }
  const tokens = (value: unknown): number | null => {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new MeError(400, 'body')
    return value
  }
  const quotaCall = async <T>(work: (quota: QuotaAdmin) => Promise<T>): Promise<T> => {
    if (deps.quota === undefined) throw new MeError(404, 'quota-unavailable')
    try { return await work(deps.quota) } catch { throw new IdentityUnavailableError('store') }
  }
  const userView = (row: Record<string, unknown>) => {
    const id = String(row.id), email = String(row.email).toLowerCase()
    const source = roles.source(id, email), origin = database.sso.origin(id), disabled = database.sso.disabledAt(id)
    const links = database.sso.linksOf(id)
    const sessionAt = lastLogin(id)
    const linkAt = links.reduce<number | null>((max, link) => link.lastLoginAt !== undefined && (max === null || link.lastLoginAt > max) ? link.lastLoginAt : max, null)
    return { id, email, name: String(row.name), createdAt: time(row.createdAt), role: source === undefined ? 'member' : 'admin', roleSource: source ?? null,
      status: disabled === undefined ? 'active' : 'disabled', disabledAt: disabled?.at ?? null, disabledReason: disabled?.reason ?? null,
      provider: origin === 'sso' ? links[0]?.provider ?? config.sso.kind : origin === 'emergency' ? 'emergency' : 'password',
      lastLoginAt: sessionAt === null ? linkAt : linkAt === null ? sessionAt : Math.max(sessionAt, linkAt) }
  }
  const like = (value: string | null) => value === null || value === '' ? '' : `%${value.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`

  return async (req, res, path) => {
    if (path !== ADMIN_PATH && !path.startsWith(`${ADMIN_PATH}/`)) return false
    const sub = path.slice(ADMIN_PATH.length), verb = req.method ?? 'GET'
    const read = verb === 'GET' || verb === 'HEAD'
    if (!read && verb !== 'POST') throw new MeError(405, 'method')
    if (!(read ? ADMIN_ENDPOINTS.GET as readonly string[] : ADMIN_ENDPOINTS.POST as readonly string[]).includes(sub)) throw new MeError(404, 'not-found')
    // The role is checked before anything else is read, so a member learns nothing beyond 403.
    const session = await adminSession(req)
    const actor = session.email
    const query = new URL(req.url ?? '/', config.publicOrigin).searchParams
    if (read) {
      deps.limit(`admin-read:${session.user.id}`, HOUR, 1200)
      if (sub === '/invites') { send(res, 200, { invites: store(() => database.listInvites()).reverse() }); return true }
      if (sub === '/users') {
        const offset = Math.max(0, Math.min(Number(query.get('offset')) || 0, 1_000_000)), limit = Math.max(1, Math.min(Number(query.get('limit')) || 50, 100))
        const role = query.get('role'), status = query.get('status')
        const all = store(() => (allUsers.all(like(query.get('q'))) as Array<Record<string, unknown>>).map(userView))
          .filter(user => (role !== 'admin' && role !== 'member' || user.role === role) && (status !== 'active' && status !== 'disabled' || user.status === status))
        send(res, 200, { total: all.length, offset, limit, users: all.slice(offset, offset + limit), self: session.user.id }); return true
      }
      if (sub === '/audit') {
        const limit = Math.max(1, Math.min(Number(query.get('limit')) || 50, 200)), before = Math.max(0, Number(query.get('before')) || 0)
        const event = query.get('event') ?? '', outcome = query.get('outcome') ?? ''
        if (event.length > 64 || outcome.length > 16) throw new MeError(400, 'query')
        const rows = store(() => auditPage.all(event, outcome, like(query.get('q')), before, limit + 1) as Array<Record<string, unknown>>)
        const page = rows.slice(0, limit)
        send(res, 200, { entries: page.map(row => ({ id: Number(row.id), at: Number(row.at), event: String(row.event), outcome: String(row.outcome), userId: row.user_id ?? null,
          email: row.email ?? null, ip: row.ip ?? null, detail: row.detail ?? null })), nextBefore: rows.length > limit ? Number(page.at(-1)!.id) : null })
        return true
      }
      if (sub === '/sso') {
        const last = store(() => lastReconcile.get() as Record<string, unknown> | undefined)
        send(res, 200, { provider: redactSso(config.sso), emergency: config.emergency, deprovision: config.deprovision, enrollmentOpen: config.enrollmentOpen,
          adminEmails: config.admins ?? [], reconcile: { scheduled: config.sso.kind !== 'off' && config.deprovision.intervalMs > 0, intervalMs: config.deprovision.intervalMs,
            last: last === undefined ? null : { at: Number(last.at), outcome: String(last.outcome), detail: last.detail ?? null } },
          disabledAccounts: store(() => database.sso.listDisabled()).length })
        return true
      }
      send(res, 200, await quotaCall(quota => quota.limits())); return true
    }

    const body = await jsonBody(req)
    deps.limit(`admin-write:${session.user.id}`, HOUR, 120)
    if (sub === '/invites') {
      const hours = body.ttlHours === undefined ? 168 : body.ttlHours, note = body.note
      if (typeof hours !== 'number' || !Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new MeError(400, 'body')
      if (note !== undefined && (typeof note !== 'string' || note.length > 200 || /[\r\n\0]/.test(note))) throw new MeError(400, 'body')
      const invite = store(() => database.mintInvite(hours * HOUR, note === '' ? undefined : note as string | undefined, clock()))
      audit('admin-invite-create', 'ok', actor, req, undefined, `invite=${invite.id}`)
      send(res, 200, invite); return true
    }
    if (sub === '/invites/revoke') {
      if (typeof body.id !== 'string' || body.id.length > 64) throw new MeError(400, 'body')
      if (!store(() => database.revokeInvite(body.id as string, clock()))) throw new MeError(404, 'invite-not-found')
      audit('admin-invite-revoke', 'ok', actor, req, undefined, `invite=${body.id}`)
      send(res, 200, { revoked: true }); return true
    }
    if (sub === '/users/enable') {
      const user = target(body)
      if (!store(() => database.sso.enableUser(user.id, clock(), user.email))) throw new MeError(409, 'not-disabled')
      audit('admin-user-enable', 'ok', actor, req, user)
      send(res, 200, { enabled: true }); return true
    }
    if (sub === '/users/disable') {
      const user = target(body)
      const reason = body.reason === undefined ? 'admin' : body.reason
      if (typeof reason !== 'string' || reason.length > 200 || /[\r\n\0]/.test(reason)) throw new MeError(400, 'body')
      if (store(() => database.sso.disabledAt(user.id)) !== undefined) throw new MeError(409, 'already-disabled')
      const admins = store(() => roles.activeAdmins())
      if (admins.includes(user.id) && admins.length <= 1) { audit('admin-user-disable', 'denied', actor, req, user, 'last-admin'); throw new MeError(409, 'last-admin') }
      // Disabling yourself would end this session mid-action; another administrator does it.
      if (user.id === session.user.id) throw new MeError(409, 'self')
      await reauth(req, session, body, 'disable')
      store(() => lastLogin(user.id))
      // The deprovisioning path: one transaction drops every session and writes its own `sso-disable` row.
      store(() => database.sso.disableUser(user.id, `admin:${reason}`, clock(), user.email))
      audit('admin-user-disable', 'ok', actor, req, user, `reason=${reason}`)
      send(res, 200, { disabled: true }); return true
    }
    if (sub === '/users/role') {
      const user = target(body)
      if (body.role !== 'admin' && body.role !== 'member') throw new MeError(400, 'body')
      const source = store(() => roles.source(user.id, user.email))
      if (body.role === 'member') {
        if (source === 'config' || source === 'emergency') throw new MeError(409, `${source}-admin`)
        const admins = store(() => roles.activeAdmins())
        if (admins.includes(user.id) && admins.length <= 1) { audit('admin-role-change', 'denied', actor, req, user, 'last-admin'); throw new MeError(409, 'last-admin') }
      }
      await reauth(req, session, body, 'role')
      const changed = store(() => roles.setGrant(user.id, body.role === 'admin', actor, clock()))
      if (changed) audit('admin-role-change', 'ok', actor, req, user, `role=${body.role as string}`)
      send(res, 200, { role: store(() => roles.role(user.id, user.email)), changed }); return true
    }
    // Allowance changes: the quota ledger checks the ceiling (the site's daily limit) and answers with the new limits.
    const dailyTokens = tokens(body.dailyTokens)
    if (sub === '/quota/default') {
      await reauth(req, session, body, 'quota')
      const limits = await quotaCall(quota => quota.setDefault(dailyTokens))
      audit('admin-quota-change', 'ok', actor, req, undefined, `default=${dailyTokens ?? 'configured'}`)
      send(res, 200, limits); return true
    }
    const user = target(body)
    await reauth(req, session, body, 'quota')
    const limits = await quotaCall(quota => quota.setUser(user.id, dailyTokens))
    audit('admin-quota-change', 'ok', actor, req, user, `daily=${dailyTokens ?? 'default'}`)
    send(res, 200, limits); return true
  }
}
