/** The knowledge base gateway: personal and admin routes forwarded to the KB service socket with the verified actor, re-authentication
 * and password stripping for sensitive admin actions, principal sync on group changes, and the audit outbox drained into dsh_audit. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDirectRunner, devUserTrees, startKbService, type KbService } from '../../kb/src/index.ts'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0).reverse()) await service.close() })
const PASSWORD = 'correct horse battery'
const json = (reply: { body: string }) => JSON.parse(reply.body)
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 30)) } throw new Error('timed out') }

async function site() {
  const { dir } = await setup()
  const seen: Array<{ headers: Record<string, unknown>; body: unknown }> = []
  const kb: KbService = await startKbService({ root: join(dir, 'kb'), socket: join(dir, 'kb.sock'), users: devUserTrees(join(dir, 'storage')), runner: createDirectRunner() },
    [() => ({ 'PUT /admin/kb/limits': async request => { const body = await request.json(); seen.push({ headers: { ...request.actor }, body }); return { ok: true } },
      'GET /admin/kb': async request => { seen.push({ headers: { ...request.actor }, body: null }); return { kbs: [] } } })])
  open.push(kb)
  const { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test', DSH_KB_SOCKET: join(dir, 'kb.sock') })
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
  return { config, kb, seen, audit, root, member }
}

describe('knowledge base gateway', () => {
  it('forwards_personal_routes_with_the_session_user_and_drains_audit', async () => {
    const s = await site()
    const me = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(s.config.publicSocket, method, `/account/api/me${path}`, body, { cookie: s.member.cookie, ...headers })
    expect((await call(s.config.publicSocket, 'GET', '/account/api/me/kb')).status).toBe(401)
    const created = await me('POST', '/kb', { title: 'Runbooks' })
    expect(created.status).toBe(200)
    const kb = json(created).kb
    expect(kb).toMatchObject({ ownerUserId: s.member.id, title: 'Runbooks' })
    expect((await me('POST', `/kb/sources?kb=${kb.id}&name=a.md`, '# A\nText.', { 'content-type': 'application/octet-stream' })).status).toBe(200)
    expect((await me('POST', `/kb/sources?kb=${kb.id}&name=b.md`, '# B', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await me('POST', '/kb', { title: 'X' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await me('POST', '/kb/unknown', {})).status).toBe(404)
    const listed = json(await me('GET', '/kb'))
    expect(listed.kbs.map((k: { id: string }) => k.id)).toEqual([kb.id])
    expect(listed.kbs[0].sources).toBe(1)
    // The first request projected the new account into the service.
    expect(s.kb.core.store.principals.get(s.member.id)).toMatchObject({ disabled: false, email: 'member@example.test', groups: [] })
    // Another user sees nothing of it, and a forged actor header from the browser is ignored.
    const other = json(await call(s.config.publicSocket, 'GET', '/account/api/me/kb', undefined, { cookie: s.root.cookie, 'x-dsh-user': s.member.id }))
    expect(other.kbs).toEqual([])
    await until(() => s.audit().some(row => row.event === 'kb-create'))
    expect(s.audit().find(row => row.event === 'kb-create')).toMatchObject({ outcome: 'ok', user_id: s.member.id, email: 'member@example.test', detail: `kb=${kb.id}` })
    expect(s.kb.core.store.audit.pending()).toEqual([])
  })

  it('re_authenticates_sensitive_admin_actions_strips_the_password_and_syncs_groups', async () => {
    const s = await site()
    const admin = (method: string, path: string, body: unknown, cookie = s.root.cookie) => call(s.config.publicSocket, method, `/api/admin${path}`, body, { cookie })
    expect((await call(s.config.publicSocket, 'GET', '/api/admin/kb', undefined, { cookie: s.member.cookie })).status).toBe(403)
    expect((await call(s.config.publicSocket, 'GET', '/api/admin/kb', undefined, { cookie: s.root.cookie })).status).toBe(200)
    expect(s.seen.at(-1)!.headers).toMatchObject({ userId: s.root.id, role: 'admin', email: 'root@example.test' })
    const body = { scope: { type: 'global', id: '*' }, name: 'max_kbs', value: 3 }
    expect(json(await admin('PUT', '/kb/limits', body))).toEqual({ code: 'reauth-required', method: 'password' })
    expect(s.seen.length).toBe(1)
    expect((await admin('PUT', '/kb/limits', { ...body, password: 'wrong password!' })).status).toBe(403)
    expect((await admin('PUT', '/kb/limits', { ...body, password: PASSWORD })).status).toBe(200)
    expect(s.seen.at(-1)!.body).toEqual(body)
    // Group changes reach the service's principal projection.
    const group = json(await admin('POST', '/groups', { op: 'create', name: 'Ops' })).group
    await admin('POST', '/groups/members', { op: 'add', groupId: group.id, userId: s.member.id, password: PASSWORD })
    await until(() => (s.kb.core.store.principals.get(s.member.id)?.groups ?? []).includes(group.id))
    expect(s.kb.core.store.principals.get(s.member.id)).toMatchObject({ disabled: false, email: 'member@example.test' })
  })
})
