/** Identity HTTP surfaces: the proxied public listener and the private session-lookup listener, both on Unix sockets. */
import { chmod, chown, lstat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { IdentityAuth } from './auth.ts'
import { COOKIE_PREFIX } from './auth.ts'
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'
import { MAX_SESSION_WIRE_BYTES, SESSION_PATH } from './session-wire.ts'
import type { CaptchaProvider } from './captcha.ts'
import { IdentityUnavailableError } from './transports.ts'
import { parseUserId } from '@public-harness/contracts'

const MAX_BODY = 64 * 1024
const HOUR = 3_600_000

/** Account pages handler (Task 3); returns false when the path is not an account page. */
export type PagesHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > max) throw new HttpError(413, 'body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Count session cookies in a Cookie header; more than one means a planted or confused cookie and is refused.
 * @param header Raw Cookie header.
 * @returns Number of session-token cookies, under either prefix form.
 */
export function sessionCookieCount(header: string | undefined): number {
  if (header === undefined) return 0
  return header.split(';').map(part => part.trim().split('=')[0]).filter(name => name === `${COOKIE_PREFIX}.session_token`
    || name === `__Secure-${COOKIE_PREFIX}.session_token` || name === `__Host-${COOKIE_PREFIX}.session_token`).length
}

/** The trusted proxy's client address: the last value of the configured header, as the proxy appends it.
 * @param req Request.
 * @param header Configured header name.
 * @returns Address string, or `unknown`.
 */
export function clientIp(req: IncomingMessage, header: string): string {
  const raw = req.headers[header]
  const value = Array.isArray(raw) ? raw.at(-1) : raw
  return value?.split(',').at(-1)?.trim() || 'unknown'
}

/** Validate proxy-facing headers before any authentication work.
 * @param req Request.
 * @param config Settings.
 */
export function checkRequestOrigin(req: IncomingMessage, config: IdentityConfig): void {
  const host = new URL(config.publicOrigin).host
  if (req.headers.host !== host) throw new HttpError(400, 'host')
  const forwarded = req.headers['x-forwarded-host']
  if (forwarded !== undefined && forwarded !== host) throw new HttpError(400, 'forwarded-host')
  if (req.headers.forwarded !== undefined) throw new HttpError(400, 'forwarded')
  if (sessionCookieCount(req.headers.cookie) > 1) throw new HttpError(400, 'duplicate-session-cookie')
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'origin')
}

/** Collaborators of the public listener. */
export interface PublicDeps {
  readonly config: IdentityConfig
  readonly auth: IdentityAuth
  readonly database: IdentityDatabase
  readonly captcha: CaptchaProvider
  readonly pages?: PagesHandler
  readonly clock?: () => number
}

/** Handle one public request: origin checks, admission gates, then Better Auth.
 * @param deps Collaborators.
 * @returns Node request listener.
 */
export function publicHandler(deps: PublicDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, auth, database } = deps, clock = deps.clock ?? Date.now
  const limit = (key: string, windowMs: number, max: number) => {
    let ok: boolean
    try { ok = database.consume(key, windowMs, max, clock()) } catch { throw new IdentityUnavailableError('store') }
    if (!ok) throw new HttpError(429, 'rate-limited')
  }
  const captcha = async (req: IncomingMessage, ip: string) => {
    const response = req.headers['x-captcha-response']
    if (typeof response !== 'string' || !await deps.captcha.verify(response, ip)) throw new HttpError(400, 'captcha')
  }
  const jsonEmail = (body: Buffer | undefined) => {
    let email: unknown
    try { email = (JSON.parse(body?.toString('utf8') ?? '') as { email?: unknown }).email } catch { throw new HttpError(400, 'body') }
    if (typeof email !== 'string' || email.length > 320) throw new HttpError(400, 'body')
    return email.trim().toLowerCase()
  }
  const findUser = database.db.prepare('SELECT id FROM user WHERE email = ?')
  const userIdByEmail = (email: string) => {
    try { return (findUser.get(email) as { id: string } | undefined)?.id } catch { throw new IdentityUnavailableError('store') }
  }
  const origin = (email: string) => {
    const id = userIdByEmail(email)
    return id === undefined ? undefined : database.sso.origin(id)
  }
  return (req, res) => {
    void (async () => {
      checkRequestOrigin(req, config)
      const url = new URL(req.url ?? '/', config.publicOrigin)
      if (deps.pages !== undefined && await deps.pages(req, res, url)) return
      if (!url.pathname.startsWith('/api/auth/')) throw new HttpError(404, 'not-found')
      const ip = clientIp(req, config.clientIpHeader), route = url.pathname.slice('/api/auth'.length)
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, MAX_BODY)
      // Undo a single-use claim when the request it admitted does not complete, so a failure never burns a valid token or invite.
      let release: (() => void) | undefined
      const sso = config.sso.kind !== 'off'
      if (route === '/sign-up/email') {
        // SSO mode: employees arrive through the IdP; only invited contractors may register (decision D3).
        if (sso && !deps.captcha.invites) throw new HttpError(403, 'sso-only')
        if (deps.captcha.invites) {
          // Invite-only mode: registration is never public; each operator-minted code admits exactly one account.
          const email = jsonEmail(body)
          limit(`signup-ip:${ip}`, HOUR, config.limits.signupPerIpPerHour)
          const code = req.headers['x-invite-code']
          if (typeof code !== 'string' || !database.claimInvite(code, email, clock())) throw new HttpError(403, 'invite')
          release = () => database.releaseInvite(code)
          try { limit('signup-day', 24 * HOUR, config.limits.signupPerDay) } catch (error) { release(); throw error }
        } else {
          if (!config.enrollmentOpen) throw new HttpError(403, 'enrollment-closed')
          await captcha(req, ip)
          limit(`signup-ip:${ip}`, HOUR, config.limits.signupPerIpPerHour)
          limit('signup-day', 24 * HOUR, config.limits.signupPerDay)
        }
      } else if (route === '/sign-in/email') {
        limit(`login-ip:${ip}`, 60_000, config.limits.loginPerIpPerMinute)
        // SSO mode: the password form serves invited contractors only; SSO and emergency accounts are refused here.
        if (sso && origin(jsonEmail(body)) !== 'invite') throw new HttpError(403, 'sso-only')
      } else if (route === '/request-password-reset') {
        if (deps.captcha.invites) limit(`reset-ip:${ip}`, HOUR, config.limits.signupPerIpPerHour)
        else await captcha(req, ip)
        const email = jsonEmail(body)
        limit(`reset:${email}`, HOUR, config.limits.resetPerEmailPerHour)
        // Answer exactly as Better Auth does for an unknown address, so the reply reveals nothing and no mail is sent.
        const owner = sso ? origin(email) : 'invite'
        if (owner !== 'invite' && owner !== 'emergency') { send(res, 200, { status: true }); return }
      } else if (route.startsWith('/sso/')) {
        limit(`login-ip:${ip}`, 60_000, config.limits.loginPerIpPerMinute)
      } else if (route === '/verify-email') {
        const token = url.searchParams.get('token') ?? ''
        // Better Auth verification links are signed and stateless; the service makes each one single-use.
        if (!token || !database.claimToken('verify-email', token, clock())) throw new HttpError(400, 'token-used')
        release = () => database.releaseToken('verify-email', token)
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name.startsWith('x-forwarded-') || name === 'x-dsh-client-ip') continue
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
      }
      headers.set('x-dsh-client-ip', ip)
      let response: Response
      try {
        response = await auth.handler(new Request(url, { method: req.method, headers, ...body === undefined ? {} : { body: new Uint8Array(body) } }))
      } catch (error) {
        release?.()
        throw error
      }
      if (response.status >= 400) release?.()
      // Invite registrations are recorded so SSO mode can tell contractors from employees and never bind them to a subject.
      else if (route === '/sign-up/email' && deps.captcha.invites) {
        const id = userIdByEmail(jsonEmail(body))
        // Only a new account gets an origin; an existing SSO or emergency account is never relabeled by a sign-up for its address.
        if (id !== undefined && database.sso.origin(id) === undefined) database.sso.setOrigin(id, 'invite')
      }
      const out: Record<string, string | string[]> = { 'cache-control': 'no-store' }
      response.headers.forEach((value, name) => { if (name !== 'set-cookie') out[name] = value })
      const cookies = response.headers.getSetCookie()
      if (cookies.length) out['set-cookie'] = cookies
      res.writeHead(response.status, out)
      res.end(Buffer.from(await response.arrayBuffer()))
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof HttpError) send(res, error.status, { code: error.code })
      else if (error instanceof IdentityUnavailableError) send(res, 503, { code: 'unavailable' })
      else send(res, 500, { code: 'internal' })
    })
  }
}

/** Handle private session lookups: `POST /internal/session` with `{ cookie }`, answering the live session or 401.
 * A store failure answers 503 so the router never treats an outage as a valid or cached identity.
 * @param auth Better Auth instance.
 * @returns Node request listener.
 */
export function sessionHandler(auth: IdentityAuth): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== SESSION_PATH) throw new HttpError(404, 'not-found')
      let cookie: unknown
      try { cookie = (JSON.parse((await readBody(req, MAX_SESSION_WIRE_BYTES)).toString('utf8')) as { cookie?: unknown }).cookie } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, 'body')
      }
      if (typeof cookie !== 'string' || cookie.length > MAX_SESSION_WIRE_BYTES) throw new HttpError(400, 'body')
      if (sessionCookieCount(cookie) !== 1) throw new HttpError(401, 'unauthenticated')
      let result
      try { result = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } }) }
      catch { throw new IdentityUnavailableError('store') }
      if (result === null || !result.user.emailVerified || result.session.expiresAt.getTime() <= Date.now()) throw new HttpError(401, 'unauthenticated')
      send(res, 200, { userId: parseUserId(result.user.id), sessionId: result.session.id, expiresAt: result.session.expiresAt.getTime() })
    })().catch((error: unknown) => {
      if (error instanceof HttpError) send(res, error.status, { code: error.code })
      else send(res, 503, { code: 'unavailable' })
    })
  }
}

/** Listen on a Unix socket with an exact mode and group, replacing only a stale socket.
 * @param handler Request listener.
 * @param path Socket path.
 * @param mode Socket permissions.
 * @param gid Optional socket group.
 * @returns Listening server.
 */
export async function listenUnix(handler: (req: IncomingMessage, res: ServerResponse) => void, path: string, mode: number, gid?: number): Promise<Server> {
  const entry = await lstat(path).catch(() => undefined)
  if (entry !== undefined) { if (!entry.isSocket()) throw new Error('refusing to replace a non-socket path'); await unlink(path) }
  const server = createServer(handler)
  server.headersTimeout = 10_000; server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  try { if (gid !== undefined) await chown(path, process.getuid!(), gid); await chmod(path, mode) } catch (error) { server.close(); throw error }
  return server
}
