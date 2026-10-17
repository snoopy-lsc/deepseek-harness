/** Knowledge base gateway: the personal-center (`/account/api/me/kb*`) and admin (`/api/admin/kb*`) routes, forwarded to the `dsh-kb`
 * service over its private Unix socket with the verified actor in `x-dsh-user`, `x-dsh-email` and `x-dsh-role`. Identity keeps every
 * browser-facing check (session, admin role, Origin, JSON or octet-stream bodies, rate limits, re-authentication) and strips the
 * re-authentication password before forwarding. It also keeps the service's principal projection (effective groups, disabled state)
 * current and drains the service's audit outbox into the identity audit log. */
import { request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminContext, AdminModule } from './admin.ts'
import type { IdentityAuth } from './auth.ts'
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'
import { MeError, ME_PATH } from './me.ts'
import { createRoles } from './roles.ts'
import type { AuditEvent } from './sso/store.ts'
import { IdentityUnavailableError } from './transports.ts'

/** Admin endpoints served by the KB service, by method (identity path after `/api/admin`). */
export const KB_ADMIN_ENDPOINTS = {
  GET: ['/kb', '/kb/requests', '/kb/requests/content', '/kb/preview', '/kb/limits', '/kb/limits/effective', '/kb/content'],
  POST: ['/kb/requests/approve', '/kb/requests/reject', '/kb/scope', '/kb/revoke', '/kb/convert', '/kb/org', '/kb/org/sources', '/kb/org/edit',
    '/kb/org/compile', '/kb/org/rollback'],
  PUT: ['/kb/limits'],
  DELETE: ['/kb/limits'],
} as const
/** Admin actions that need re-authentication, as `METHOD path`. */
export const KB_REAUTH = new Set(['POST /kb/requests/approve', 'POST /kb/scope', 'POST /kb/revoke', 'POST /kb/convert', 'POST /kb/org', 'POST /kb/org/rollback',
  'PUT /kb/limits', 'DELETE /kb/limits'])
/** Personal endpoints, by method (path after `/account/api/me`). */
export const KB_ME_ENDPOINTS = {
  GET: ['/kb', '/kb/jobs', '/kb/shared'],
  POST: ['/kb', '/kb/sources', '/kb/compile', '/kb/share', '/kb/share/withdraw', '/kb/archive'],
} as const
/** Streamed uploads (application/octet-stream) and their cap. */
const UPLOADS = new Set(['/kb/sources', '/kb/org/sources'])
export const KB_MAX_UPLOAD = 25 * 1024 * 1024
/** JSON bodies: page edits are the largest. */
const MAX_JSON = 1024 * 1024
const HOUR = 3_600_000
const KB_EVENTS = new Set<string>(['kb-create', 'kb-archive', 'kb-compile', 'kb-share-request', 'kb-share-withdraw', 'kb-view-apply', 'admin-kb-approve', 'admin-kb-reject',
  'admin-kb-scope-change', 'admin-kb-revoke', 'admin-kb-convert', 'admin-kb-org-create', 'admin-kb-org-edit', 'admin-kb-org-compile', 'admin-kb-rollback',
  'admin-kb-limit-change', 'admin-kb-limit-delete', 'admin-kb-content-read'])

interface Reply { status: number; type: string; body: Buffer }
/** One request to the KB socket. */
export function kbRequest(socketPath: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | IncomingMessage, timeoutMs = 120_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // Without an explicit length Node sends DELETE bodies unframed; buffered bodies always carry one.
    const framed = Buffer.isBuffer(body) ? { ...headers, 'content-length': String(body.length) } : body === undefined ? headers : { ...headers, 'transfer-encoding': 'chunked' }
    const req = request({ socketPath, method, path, headers: framed, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) { req.destroy(new Error('reply too large')); return } chunks.push(chunk) })
      res.once('end', () => resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? 'application/json'), body: Buffer.concat(chunks) }))
      res.once('error', reject)
    })
    req.once('timeout', () => req.destroy(new Error('kb timeout')))
    req.once('error', reject)
    if (body === undefined || Buffer.isBuffer(body)) req.end(body)
    else {
      // Stream an upload, refusing more than the cap even when Content-Length lies.
      let size = 0
      body.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > KB_MAX_UPLOAD) { body.pause(); req.destroy(new MeError(413, 'body-too-large')); return }
        if (!req.write(chunk)) { body.pause(); req.once('drain', () => body.resume()) }
      })
      body.once('end', () => req.end())
      body.once('error', error => req.destroy(error))
    }
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) throw new MeError(415, 'json-only')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > MAX_JSON) throw new MeError(413, 'body-too-large'); chunks.push(chunk) }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new MeError(400, 'body') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MeError(400, 'body')
  return parsed as Record<string, unknown>
}

function relay(res: ServerResponse, reply: Reply): void {
  const json = /^application\/json/.test(reply.type)
  res.writeHead(reply.status, { 'content-type': json ? 'application/json; charset=utf-8' : /^text\/(plain|markdown)/.test(reply.type) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...json ? {} : { 'content-disposition': 'attachment', 'content-security-policy': "default-src 'none'; sandbox" } })
  res.end(reply.body)
}

/** Gateway collaborators. */
export interface KbGatewayDeps {
  readonly socket: string
  readonly config: IdentityConfig
  readonly auth: IdentityAuth
  readonly database: IdentityDatabase
  readonly clock: () => number
  readonly limit: (key: string, windowMs: number, max: number) => void
  readonly log?: (line: string) => void
}

/** The gateway: personal handler, admin module, principal sync and audit drain. */
export interface KbGateway {
  me(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
  readonly admin: AdminModule
  /** Push every user's effective groups and state (or only `userIds`). */
  syncPrincipals(userIds?: readonly string[]): Promise<void>
  /** Copy pending service audit rows into the identity audit log. */
  drainAudit(): Promise<number>
  /** Start the periodic sync and drain, and follow group changes; returns a stop function. */
  start(intervalMs?: number): () => void
}

/** Build the gateway.
 * @param deps Socket path and identity collaborators.
 * @returns Gateway.
 */
export function createKbGateway(deps: KbGatewayDeps): KbGateway {
  const { config, auth, database } = deps
  const roles = createRoles(config, database)
  const log = deps.log ?? (() => {})
  const users = database.db.prepare('SELECT id, email FROM user')
  const userById = database.db.prepare('SELECT id, email FROM user WHERE id = ?')
  const call = async (method: string, path: string, headers: Record<string, string>, body?: Buffer | IncomingMessage) => {
    try { return await kbRequest(deps.socket, method, path, headers, body) } catch (error) {
      if (error instanceof MeError) throw error
      throw new IdentityUnavailableError('kb')
    }
  }
  const internal = async (path: string, body: unknown) => {
    const reply = await call('POST', path, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(body)))
    if (reply.status !== 200) throw new Error(`kb ${path} answered ${reply.status}`)
    return JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>
  }
  let draining: Promise<number> | undefined
  const drainAudit = () => draining ??= (async () => {
    let total = 0
    try {
      for (;;) {
        const events = (await internal('/internal/audit/drain', {})).events as Array<{ id: number; at: number; event: string; outcome: string; userId: string | null; actor: string; detail: string }>
        if (events.length === 0) break
        for (const row of events) {
          if (!KB_EVENTS.has(row.event)) continue
          database.sso.audit({ event: row.event as AuditEvent['event'], outcome: (['ok', 'denied', 'error'].includes(row.outcome) ? row.outcome : 'error') as AuditEvent['outcome'],
            ...row.userId === null ? {} : { userId: row.userId }, email: row.actor.slice(0, 320), ip: 'kb-service', detail: row.detail.slice(0, 1000) }, row.at)
        }
        await internal('/internal/audit/ack', { upTo: events.at(-1)!.id })
        total += events.length
        if (events.length < 500) break
      }
    } finally { draining = undefined }
    return total
  })()
  const principal = (row: { id: string; email: string }) => ({ userId: row.id, email: row.email.toLowerCase(), groups: database.groups.effectiveGroupsOf(row.id),
    disabled: database.sso.disabledAt(row.id) !== undefined })
  const syncPrincipals = async (userIds?: readonly string[]) => {
    const rows = userIds === undefined ? users.all() as Array<{ id: string; email: string }>
      : userIds.map(id => userById.get(id) as { id: string; email: string } | undefined).filter(row => row !== undefined)
    if (rows.length === 0) return
    await internal('/internal/principals', { users: rows.map(principal) })
    for (const row of rows) synced.add(row.id)
  }
  // Users seen since start; a new account is projected before its first KB request instead of waiting for the periodic sync.
  const synced = new Set<string>()
  const actorHeaders = (user: { id: string; email: string }, role: 'admin' | 'member') => ({ 'x-dsh-user': user.id, 'x-dsh-email': user.email.toLowerCase(), 'x-dsh-role': role })
  const forwardBody = async (req: IncomingMessage, sub: string, write: boolean, prepared?: Record<string, unknown>): Promise<{ headers: Record<string, string>; body: Buffer | IncomingMessage | undefined }> => {
    if (!write) return { headers: {}, body: undefined }
    if (UPLOADS.has(sub)) {
      if (!/^application\/octet-stream(;|$)/.test(req.headers['content-type'] ?? '')) throw new MeError(415, 'octet-stream-only')
      const length = Number(req.headers['content-length'] ?? 0)
      if (length > KB_MAX_UPLOAD) throw new MeError(413, 'body-too-large')
      return { headers: { 'content-type': 'application/octet-stream' }, body: req }
    }
    const body = prepared ?? await readJson(req)
    const { password: _password, ...rest } = body
    return { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(rest)) }
  }

  // The KB service checks group IDs by shape only; identity owns the group list, so unknown groups stop here.
  const assertKnownGroups = (body: Record<string, unknown>) => {
    const ids: unknown[] = []
    const scope = body.scope as Record<string, unknown> | unknown[] | undefined
    if (Array.isArray(scope)) for (const entry of scope) { const e = entry as Record<string, unknown> | null; if (e?.kind === 'group') ids.push(e.target) }
    else if (scope !== null && typeof scope === 'object' && scope.type === 'group') ids.push(scope.id)
    for (const id of ids) if (typeof id !== 'string' || database.groups.get(id) === undefined) throw new MeError(400, 'unknown-group')
  }
  return {
    async me(req, res, path) {
      if (path !== `${ME_PATH}/kb` && !path.startsWith(`${ME_PATH}/kb/`)) return false
      const sub = path.slice(ME_PATH.length), verb = req.method ?? 'GET'
      const read = verb === 'GET' || verb === 'HEAD'
      if (!(read ? KB_ME_ENDPOINTS.GET : KB_ME_ENDPOINTS.POST as readonly string[]).includes(sub) || (!read && verb !== 'POST')) throw new MeError(read || verb === 'POST' ? 404 : 405, 'not-found')
      let result
      try { result = await auth.api.getSession({ headers: new Headers({ cookie: req.headers.cookie ?? '' }), query: { disableCookieCache: true } }) }
      catch { throw new IdentityUnavailableError('store') }
      if (result === null || !result.user.emailVerified) throw new MeError(401, 'unauthenticated')
      const user = { id: result.user.id, email: result.user.email }
      deps.limit(read ? `kb-read:${user.id}` : `kb-write:${user.id}`, HOUR, read ? 3600 : 600)
      const role = roles.role(user.id, user.email.toLowerCase())
      if (!synced.has(user.id)) await syncPrincipals([user.id]).catch(error => log(`kb: principal sync failed: ${(error as Error).message}`))
      const { headers, body } = await forwardBody(req, sub, !read)
      const search = new URL(req.url ?? '/', config.publicOrigin).search
      const reply = await call(read ? 'GET' : 'POST', `/me${sub}${search}`, { ...actorHeaders(user, role), ...headers }, body)
      relay(res, reply)
      if (!read) void drainAudit().catch(error => log(`kb: audit drain failed: ${(error as Error).message}`))
      return true
    },
    async admin(ctx: AdminContext) {
      if (ctx.sub !== '/kb' && !ctx.sub.startsWith('/kb/')) return false
      const write = ctx.verb !== 'GET'
      let prepared: Record<string, unknown> | undefined
      if (KB_REAUTH.has(`${ctx.verb} ${ctx.sub}`)) {
        prepared = await readJson(ctx.req)
        await ctx.reauth(prepared, `kb${ctx.sub.slice(3)}`)
        assertKnownGroups(prepared)
      }
      const { headers, body } = await forwardBody(ctx.req, ctx.sub, write, prepared)
      const reply = await call(ctx.verb, `/admin${ctx.sub}${ctx.query.size > 0 ? `?${ctx.query}` : ''}`, { ...actorHeaders({ id: ctx.session.user.id, email: ctx.session.email }, 'admin'), ...headers }, body)
      relay(ctx.res, reply)
      void drainAudit().catch(error => log(`kb: audit drain failed: ${(error as Error).message}`))
      return true
    },
    syncPrincipals,
    drainAudit,
    start(intervalMs = 60_000) {
      const tick = () => { void syncPrincipals().catch(error => log(`kb: principal sync failed: ${(error as Error).message}`)); void drainAudit().catch(() => {}) }
      tick()
      const timer = setInterval(tick, intervalMs)
      timer.unref()
      const unsubscribe = database.groups.subscribe(ids => { void syncPrincipals(ids).catch(error => log(`kb: principal sync failed: ${(error as Error).message}`)) })
      return () => { clearInterval(timer); unsubscribe() }
    },
  }
}
