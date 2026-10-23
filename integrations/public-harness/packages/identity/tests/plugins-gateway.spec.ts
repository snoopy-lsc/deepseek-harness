/** Plugins gateway: endpoint maps, reauth set, password stripping on forward, and audit drain filtered by PLUGIN_EVENTS. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_ADMIN_ENDPOINTS,
  PLUGIN_EVENTS,
  PLUGIN_ME_ENDPOINTS,
  PLUGIN_REAUTH,
} from '../src/plugins-gateway.ts'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0).reverse()) await service.close() })
const PASSWORD = 'correct horse battery'
const json = (reply: { body: string }) => JSON.parse(reply.body)
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 30)) }
  throw new Error('timed out')
}

/** Minimal Unix HTTP peer standing in for dsh-plugins (admin/me + audit drain). */
async function startFakePlugins(socket: string, hooks: {
  onRequest?: (info: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }) => void
  pending?: Array<{ id: number; at: number; event: string; outcome: string; userId: string | null; actor: string; detail: string }>
}): Promise<{ close(): Promise<void>; acked: number[] }> {
  const pending = hooks.pending ?? []
  const acked: number[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
        try { body = JSON.parse(raw || '{}') } catch { body = raw }
      }
      const url = new URL(req.url ?? '/', 'http://plugins.local')
      const path = url.pathname
      const method = req.method ?? 'GET'
      hooks.onRequest?.({ method, path, headers: req.headers, body })
      const send = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      }
      if (method === 'POST' && path === '/internal/audit/drain') {
        send(200, { events: pending.slice() })
        return
      }
      if (method === 'POST' && path === '/internal/audit/ack') {
        const upTo = Number((body as { upTo?: unknown }).upTo)
        acked.push(upTo)
        const keep = pending.filter(row => row.id > upTo)
        pending.length = 0
        pending.push(...keep)
        send(200, { ok: true })
        return
      }
      if (method === 'GET' && (path === '/admin/plugins' || path === '/me/plugins')) {
        send(200, { packages: [] })
        return
      }
      if (method === 'PUT' && path === '/admin/plugins/limits') {
        send(200, { ok: true, received: body })
        return
      }
      if (method === 'POST' && path.startsWith('/admin/plugins/')) {
        send(200, { ok: true, received: body })
        return
      }
      if (method === 'POST' && path.startsWith('/me/plugins/')) {
        send(200, { ok: true, received: body })
        return
      }
      send(404, { code: 'not-found' })
    })().catch(() => { res.writeHead(500); res.end('{}') })
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(socket, () => resolve())
    server.once('error', reject)
  })
  return {
    acked,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
      await unlink(socket).catch(() => {})
    },
  }
}

async function site(opts: {
  pending?: Array<{ id: number; at: number; event: string; outcome: string; userId: string | null; actor: string; detail: string }>
} = {}) {
  const { dir } = await setup()
  const seen: Array<{ method: string; path: string; headers: Record<string, unknown>; body: unknown }> = []
  const sock = join(dir, 'plugins.sock')
  const plugins = await startFakePlugins(sock, {
    pending: opts.pending,
    onRequest: info => {
      seen.push({
        method: info.method,
        path: info.path,
        headers: {
          user: info.headers['x-dsh-user'],
          email: info.headers['x-dsh-email'],
          role: info.headers['x-dsh-role'],
        },
        body: info.body,
      })
    },
  })
  open.push(plugins)
  const { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test', DSH_PLUGINS_SOCKET: sock })
  const box = mailbox()
  const service = await startIdentity(config, { mail: box.mail }); open.push(service)
  let n = 0
  const enroll = async (email: string) => {
    const ip = { 'x-forwarded-for': `198.51.100.${++n}` }
    await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: email.split('@')[0], email, password: PASSWORD, callbackURL: '/account/verified' }, { ...ip, 'x-captcha-response': 'pass-captcha' })
    const verify = linkIn(box.sent.at(-1)!); await call(config.publicSocket, 'GET', verify.pathname + verify.search)
    const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password: PASSWORD }, ip)
    return { cookie: sessionCookie(reply)!, id: (JSON.parse(reply.body) as { user: { id: string } }).user.id, email }
  }
  const audit = () => {
    const db = new DatabaseSync(config.databaseFile, { readOnly: true })
    try { return db.prepare('SELECT event, outcome, user_id, email, detail FROM dsh_audit ORDER BY id').all() as Array<Record<string, string | null>> } finally { db.close() }
  }
  const root = await enroll('root@example.test'), member = await enroll('member@example.test')
  return { config, seen, audit, root, member, plugins }
}

describe('plugins gateway constants', () => {
  it('maps_admin_and_me_endpoints_from_the_design_api_table', () => {
    expect(PLUGIN_ADMIN_ENDPOINTS.GET).toEqual(expect.arrayContaining([
      '/plugins', '/plugins/requests', '/plugins/requests/detail', '/plugins/requests/file',
      '/plugins/policy', '/plugins/limits', '/plugins/limits/effective',
    ]))
    expect(PLUGIN_ADMIN_ENDPOINTS.POST).toEqual(expect.arrayContaining([
      '/plugins/requests/approve', '/plugins/requests/reject', '/plugins/upload', '/plugins/scope',
      '/plugins/rollback', '/plugins/delist', '/plugins/relist', '/plugins/revoke',
      '/plugins/defaults', '/plugins/defaults/reset', '/plugins/restore',
    ]))
    expect(PLUGIN_ADMIN_ENDPOINTS.PUT).toEqual(expect.arrayContaining(['/plugins/policy', '/plugins/limits']))
    expect(PLUGIN_ADMIN_ENDPOINTS.DELETE).toEqual(['/plugins/limits'])
    expect(PLUGIN_ME_ENDPOINTS.GET).toEqual(expect.arrayContaining(['/plugins', '/plugins/snapshots']))
    expect(PLUGIN_ME_ENDPOINTS.POST).toEqual(expect.arrayContaining([
      '/plugins/submit', '/plugins/withdraw', '/plugins/delist-request', '/plugins/defaults/reenable', '/plugins/restore',
    ]))
  })

  it('reauth_set_covers_every_sensitive_admin_row', () => {
    for (const key of [
      'POST /plugins/requests/approve', 'POST /plugins/upload', 'POST /plugins/scope', 'POST /plugins/rollback',
      'POST /plugins/delist', 'POST /plugins/relist', 'POST /plugins/revoke', 'POST /plugins/defaults',
      'POST /plugins/defaults/reset', 'PUT /plugins/policy', 'PUT /plugins/limits', 'DELETE /plugins/limits',
      'POST /plugins/restore',
    ]) expect(PLUGIN_REAUTH.has(key), key).toBe(true)
    expect(PLUGIN_REAUTH.has('POST /plugins/requests/reject')).toBe(false)
    expect(PLUGIN_REAUTH.has('GET /plugins')).toBe(false)
  })

  it('PLUGIN_EVENTS_lists_every_design_audit_event', () => {
    for (const event of [
      'plugin-submit', 'plugin-withdraw', 'plugin-expire', 'plugin-mirror-failed', 'plugin-delist-request',
      'plugin-default-reenable', 'plugin-restore', 'plugin-sync', 'plugin-reconcile', 'plugin-store-corrupt',
      'admin-plugin-approve', 'admin-plugin-reject', 'admin-plugin-upload', 'admin-plugin-scope-change',
      'admin-plugin-rollback', 'admin-plugin-delist', 'admin-plugin-relist', 'admin-plugin-revoke',
      'admin-plugin-default-set', 'admin-plugin-default-clear', 'admin-plugin-default-reset',
      'admin-plugin-build-allow', 'admin-plugin-policy-change', 'admin-plugin-limit-change',
      'admin-plugin-limit-delete', 'admin-plugin-restore', 'admin-plugin-content-read',
    ]) expect(PLUGIN_EVENTS.has(event), event).toBe(true)
  })
})

describe('plugins gateway', () => {
  it('forwards_with_verified_actor_strips_password_and_requires_reauth', async () => {
    const s = await site()
    const admin = (method: string, path: string, body?: unknown, cookie = s.root.cookie) =>
      call(s.config.publicSocket, method, `/api/admin${path}`, body, { cookie })
    expect((await call(s.config.publicSocket, 'GET', '/api/admin/plugins', undefined, { cookie: s.member.cookie })).status).toBe(403)
    expect((await admin('GET', '/plugins')).status).toBe(200)
    expect(s.seen.some(row => row.path === '/admin/plugins' && row.headers.role === 'admin' && row.headers.user === s.root.id)).toBe(true)

    const body = { scope: { kind: 'company', target: '*' }, name: 'max_submissions', value: 3 }
    expect(json(await admin('PUT', '/plugins/limits', body))).toEqual({ code: 'reauth-required', method: 'password' })
    const before = s.seen.filter(row => row.path === '/admin/plugins/limits').length
    expect(before).toBe(0)
    expect((await admin('PUT', '/plugins/limits', { ...body, password: 'wrong password!' })).status).toBe(403)
    expect((await admin('PUT', '/plugins/limits', { ...body, password: PASSWORD })).status).toBe(200)
    const forwarded = s.seen.filter(row => row.path === '/admin/plugins/limits').at(-1)!
    expect(forwarded.body).toEqual(body)
    expect(forwarded.body).not.toHaveProperty('password')
    expect(forwarded.headers).toMatchObject({ user: s.root.id, email: 'root@example.test', role: 'admin' })

    for (const path of ['/plugins/requests/approve', '/plugins/upload', '/plugins/scope', '/plugins/rollback', '/plugins/delist', '/plugins/revoke']) {
      expect(json(await admin('POST', path, { package: 'x' })).code).toBe('reauth-required')
    }
  })

  it('forwards_personal_routes_and_drains_allowlisted_audit_events_only', async () => {
    const pending = [
      { id: 1, at: Date.now(), event: 'plugin-submit', outcome: 'ok', userId: 'u1', actor: 'member@example.test', detail: 'package=@co/x' },
      { id: 2, at: Date.now(), event: 'not-a-plugin-event', outcome: 'ok', userId: 'u1', actor: 'member@example.test', detail: 'drop-me' },
      { id: 3, at: Date.now(), event: 'admin-plugin-approve', outcome: 'ok', userId: null, actor: 'root@example.test', detail: 'package=@co/x' },
    ]
    const s = await site({ pending })
    const me = (method: string, path: string, body?: unknown) =>
      call(s.config.publicSocket, method, `/account/api/me${path}`, body, { cookie: s.member.cookie })
    expect((await call(s.config.publicSocket, 'GET', '/account/api/me/plugins')).status).toBe(401)
    expect((await me('GET', '/plugins')).status).toBe(200)
    expect(s.seen.some(row => row.path === '/me/plugins' && row.headers.user === s.member.id && row.headers.role === 'member')).toBe(true)
    expect((await me('POST', '/plugins/submit', { package: '@co/x', version: '1.0.0' })).status).toBe(200)
    const submit = s.seen.filter(row => row.path === '/me/plugins/submit').at(-1)!
    expect(submit.headers).toMatchObject({ user: s.member.id, email: 'member@example.test' })

    await until(() => s.audit().some(row => row.event === 'plugin-submit') && s.plugins.acked.includes(3))
    const events = s.audit().map(row => row.event)
    expect(events).toContain('plugin-submit')
    expect(events).toContain('admin-plugin-approve')
    expect(events).not.toContain('not-a-plugin-event')
  })

  it('answers_404_for_plugin_routes_without_the_socket', async () => {
    const base = await setup()
    const { config: noPlugins } = await setup({}, { ...localEnv(base.dir), DSH_ADMIN_EMAILS: 'root@example.test' })
    expect(noPlugins.pluginsSocket).toBeUndefined()
    const box = mailbox()
    const service = await startIdentity(noPlugins, { mail: box.mail }); open.push(service)
    const ip = { 'x-forwarded-for': '198.51.100.9', 'x-captcha-response': 'pass-captcha' }
    await call(noPlugins.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'root', email: 'root@example.test', password: PASSWORD, callbackURL: '/account/verified' }, ip)
    const verify = linkIn(box.sent.at(-1)!); await call(noPlugins.publicSocket, 'GET', verify.pathname + verify.search)
    const signed = await call(noPlugins.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'root@example.test', password: PASSWORD }, { 'x-forwarded-for': '198.51.100.9' })
    const cookie = sessionCookie(signed)!
    expect((await call(noPlugins.publicSocket, 'GET', '/api/admin/plugins', undefined, { cookie })).status).toBe(404)
    expect((await call(noPlugins.publicSocket, 'GET', '/account/api/me/plugins', undefined, { cookie })).status).toBe(404)
  })
})
