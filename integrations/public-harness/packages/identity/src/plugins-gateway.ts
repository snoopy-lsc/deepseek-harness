/** Plugins market gateway: personal-center (`/account/api/me/plugins*`) and admin (`/api/admin/plugins*`) routes, forwarded to the
 * `dsh-plugins` control socket with the verified actor in `x-dsh-user`, `x-dsh-email` and `x-dsh-role`. Identity keeps browser-facing
 * checks (session, admin role, Origin, JSON bodies, rate limits, re-authentication) and strips the re-authentication password before
 * forwarding. It also drains the service's `plugin_audit_outbox` into the identity audit log, filtered by `PLUGIN_EVENTS`. */
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

/** Admin endpoints served by the plugins service, by method (identity path after `/api/admin`). */
export const PLUGIN_ADMIN_ENDPOINTS = {
  GET: ['/plugins', '/plugins/requests', '/plugins/requests/detail', '/plugins/requests/file', '/plugins/policy', '/plugins/limits', '/plugins/limits/effective'],
  POST: ['/plugins/requests/approve', '/plugins/requests/reject', '/plugins/upload', '/plugins/scope', '/plugins/rollback', '/plugins/delist', '/plugins/relist',
    '/plugins/revoke', '/plugins/defaults', '/plugins/defaults/reset', '/plugins/restore'],
  PUT: ['/plugins/policy', '/plugins/limits'],
  DELETE: ['/plugins/limits'],
} as const
/** Admin actions that need re-authentication, as `METHOD path`. */
export const PLUGIN_REAUTH = new Set([
  'POST /plugins/requests/approve', 'POST /plugins/upload', 'POST /plugins/scope', 'POST /plugins/rollback', 'POST /plugins/delist',
  'POST /plugins/relist', 'POST /plugins/revoke', 'POST /plugins/defaults', 'POST /plugins/defaults/reset', 'PUT /plugins/policy',
  'PUT /plugins/limits', 'DELETE /plugins/limits', 'POST /plugins/restore',
])
/** Personal endpoints, by method (path after `/account/api/me`). */
export const PLUGIN_ME_ENDPOINTS = {
  GET: ['/plugins', '/plugins/snapshots'],
  POST: ['/plugins/submit', '/plugins/withdraw', '/plugins/delist-request', '/plugins/defaults/reenable', '/plugins/restore'],
} as const
/** Events drained from `plugin_audit_outbox` into `dsh_audit`; anything else is dropped. */
export const PLUGIN_EVENTS = new Set<string>([
  'plugin-submit', 'plugin-withdraw', 'plugin-expire', 'plugin-mirror-failed', 'plugin-delist-request', 'plugin-default-reenable',
  'plugin-restore', 'plugin-sync', 'plugin-reconcile', 'plugin-store-corrupt',
  'admin-plugin-approve', 'admin-plugin-reject', 'admin-plugin-upload', 'admin-plugin-scope-change', 'admin-plugin-rollback',
  'admin-plugin-delist', 'admin-plugin-relist', 'admin-plugin-revoke', 'admin-plugin-default-set', 'admin-plugin-default-clear',
  'admin-plugin-default-reset', 'admin-plugin-build-allow', 'admin-plugin-policy-change', 'admin-plugin-limit-change',
  'admin-plugin-limit-delete', 'admin-plugin-restore', 'admin-plugin-content-read',
])
const MAX_JSON = 1024 * 1024
const HOUR = 3_600_000

interface Reply { status: number; type: string; body: Buffer }

/** One request to the plugins control socket. */
export function pluginsRequest(socketPath: string, method: string, path: string, headers: Record<string, string>, body?: Buffer, timeoutMs = 120_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const framed = body === undefined ? headers : { ...headers, 'content-length': String(body.length) }
    const req = request({ socketPath, method, path, headers: framed, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) { req.destroy(new Error('reply too large')); return } chunks.push(chunk) })
      res.once('end', () => resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? 'application/json'), body: Buffer.concat(chunks) }))
      res.once('error', reject)
    })
    req.once('timeout', () => req.destroy(new Error('plugins timeout')))
    req.once('error', reject)
    req.end(body)
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
  res.writeHead(reply.status, { 'content-type': json ? 'application/json; charset=utf-8' : 'application/octet-stream',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...json ? {} : { 'content-disposition': 'attachment', 'content-security-policy': "default-src 'none'; sandbox" } })
  res.end(reply.body)
}

/** Gateway collaborators. */
export interface PluginsGatewayDeps {
  readonly socket: string
  readonly config: IdentityConfig
  readonly auth: IdentityAuth
  readonly database: IdentityDatabase
  readonly clock: () => number
  readonly limit: (key: string, windowMs: number, max: number) => void
  readonly log?: (line: string) => void
}

/** The gateway: personal handler, admin module and audit drain. */
export interface PluginsGateway {
  me(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
  readonly admin: AdminModule
  /** Copy pending service audit rows into the identity audit log. */
  drainAudit(): Promise<number>
  /** Start the periodic drain; returns a stop function. */
  start(intervalMs?: number): () => void
}

/** Build the gateway.
 * @param deps Socket path and identity collaborators.
 * @returns Gateway.
 */
export function createPluginsGateway(deps: PluginsGatewayDeps): PluginsGateway {
  const { config, auth, database } = deps
  const roles = createRoles(config, database)
  const log = deps.log ?? (() => {})
  const call = async (method: string, path: string, headers: Record<string, string>, body?: Buffer) => {
    try { return await pluginsRequest(deps.socket, method, path, headers, body) } catch (error) {
      if (error instanceof MeError) throw error
      throw new IdentityUnavailableError('plugins')
    }
  }
  const internal = async (path: string, body: unknown) => {
    const reply = await call('POST', path, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(body)))
    if (reply.status !== 200) throw new Error(`plugins ${path} answered ${reply.status}`)
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
          if (!PLUGIN_EVENTS.has(row.event)) continue
          database.sso.audit({ event: row.event as AuditEvent['event'], outcome: (['ok', 'denied', 'error'].includes(row.outcome) ? row.outcome : 'error') as AuditEvent['outcome'],
            ...row.userId === null ? {} : { userId: row.userId }, email: row.actor.slice(0, 320), ip: 'plugins-service', detail: row.detail.slice(0, 1000) }, row.at)
        }
        await internal('/internal/audit/ack', { upTo: events.at(-1)!.id })
        total += events.length
        if (events.length < 500) break
      }
    } finally { draining = undefined }
    return total
  })()
  const actorHeaders = (user: { id: string; email: string }, role: 'admin' | 'member') => ({ 'x-dsh-user': user.id, 'x-dsh-email': user.email.toLowerCase(), 'x-dsh-role': role })
  const forwardBody = async (req: IncomingMessage, write: boolean, prepared?: Record<string, unknown>): Promise<{ headers: Record<string, string>; body: Buffer | undefined }> => {
    if (!write) return { headers: {}, body: undefined }
    const body = prepared ?? await readJson(req)
    const { password: _password, ...rest } = body
    return { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(rest)) }
  }
  // Plugins scopes name groups by id; identity owns the group list, so unknown groups stop here.
  const assertKnownGroups = (body: Record<string, unknown>) => {
    const ids: unknown[] = []
    const one = body.scope as Record<string, unknown> | undefined
    if (one !== null && typeof one === 'object' && one.kind === 'group') ids.push(one.target)
    const many = body.scopes
    if (Array.isArray(many)) for (const entry of many) { const e = entry as Record<string, unknown> | null; if (e?.kind === 'group') ids.push(e.target) }
    for (const id of ids) if (typeof id !== 'string' || database.groups.get(id) === undefined) throw new MeError(400, 'unknown-group')
  }
  return {
    async me(req, res, path) {
      if (path !== `${ME_PATH}/plugins` && !path.startsWith(`${ME_PATH}/plugins/`)) return false
      const sub = path.slice(ME_PATH.length), verb = req.method ?? 'GET'
      const read = verb === 'GET' || verb === 'HEAD'
      if (!(read ? PLUGIN_ME_ENDPOINTS.GET : PLUGIN_ME_ENDPOINTS.POST as readonly string[]).includes(sub) || (!read && verb !== 'POST')) throw new MeError(read || verb === 'POST' ? 404 : 405, 'not-found')
      let result
      try { result = await auth.api.getSession({ headers: new Headers({ cookie: req.headers.cookie ?? '' }), query: { disableCookieCache: true } }) }
      catch { throw new IdentityUnavailableError('store') }
      if (result === null || !result.user.emailVerified) throw new MeError(401, 'unauthenticated')
      const user = { id: result.user.id, email: result.user.email }
      deps.limit(read ? `plugins-read:${user.id}` : `plugins-write:${user.id}`, HOUR, read ? 3600 : 600)
      const role = roles.role(user.id, user.email.toLowerCase())
      const { headers, body } = await forwardBody(req, !read)
      const search = new URL(req.url ?? '/', config.publicOrigin).search
      const reply = await call(read ? 'GET' : 'POST', `/me${sub}${search}`, { ...actorHeaders(user, role), ...headers }, body)
      relay(res, reply)
      if (!read) void drainAudit().catch(error => log(`plugins: audit drain failed: ${(error as Error).message}`))
      return true
    },
    async admin(ctx: AdminContext) {
      if (ctx.sub !== '/plugins' && !ctx.sub.startsWith('/plugins/')) return false
      const write = ctx.verb !== 'GET'
      let prepared: Record<string, unknown> | undefined
      if (PLUGIN_REAUTH.has(`${ctx.verb} ${ctx.sub}`)) {
        prepared = await readJson(ctx.req)
        await ctx.reauth(prepared, `plugins${ctx.sub.slice('/plugins'.length)}`)
        assertKnownGroups(prepared)
      }
      const { headers, body } = await forwardBody(ctx.req, write, prepared)
      const reply = await call(ctx.verb, `/admin${ctx.sub}${ctx.query.size > 0 ? `?${ctx.query}` : ''}`, { ...actorHeaders({ id: ctx.session.user.id, email: ctx.session.email }, 'admin'), ...headers }, body)
      relay(ctx.res, reply)
      void drainAudit().catch(error => log(`plugins: audit drain failed: ${(error as Error).message}`))
      return true
    },
    drainAudit,
    start(intervalMs = 60_000) {
      const tick = () => { void drainAudit().catch(() => {}) }
      tick()
      const timer = setInterval(tick, intervalMs)
      timer.unref()
      return () => { clearInterval(timer) }
    },
  }
}
