/** The knowledge base gateway: personal and admin routes forwarded to the KB service socket with the verified actor, re-authentication
 * and password stripping for sensitive admin actions, principal sync on group changes, and the audit outbox drained into dsh_audit. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDirectRunner, devUserTrees, startKbService, type KbService } from '../../kb/src/index.ts'
import { KbError } from '../../kb/src/errors.ts'
import { startIdentity } from '../src/index.ts'
import type { QuotaAdmin, QuotaLimits } from '../src/quota-account.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0).reverse()) await service.close() })
const PASSWORD = 'correct horse battery'
const json = (reply: { body: string }) => JSON.parse(reply.body)
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 30)) } throw new Error('timed out') }

function fakeQuota(): QuotaAdmin & { calls: unknown[] } {
  let limits: QuotaLimits = { configuredDailyTokens: 400000, defaultDailyTokens: 400000, overrides: [], overLimit: { mode: 'block', gracePercent: 10 } }
  const calls: unknown[] = []
  return { calls, limits: async () => limits, setDefault: async () => limits,
    setUser: async (id, n) => { calls.push(['user', id, n]); limits = { ...limits, overrides: n === null ? [] : [{ userId: id, dailyTokens: n }] }; return limits },
    setOverLimit: async () => limits }
}

async function site(options: { rejectPrincipalSync?: () => boolean } = {}) {
  const { dir } = await setup()
  const seen: Array<{ headers: Record<string, unknown>; body: unknown }> = []
  const kb: KbService = await startKbService({ root: join(dir, 'kb'), socket: join(dir, 'kb.sock'), users: devUserTrees(join(dir, 'storage')), runner: createDirectRunner() },
    [() => ({ 'PUT /admin/kb/limits': async request => { const body = await request.json(); seen.push({ headers: { ...request.actor }, body }); return { ok: true } },
      'GET /admin/kb': async request => { seen.push({ headers: { ...request.actor }, body: null }); return { kbs: [] } } }),
      ...options.rejectPrincipalSync === undefined ? [] : [() => ({ 'POST /internal/principals': async () => { if (options.rejectPrincipalSync!()) throw new KbError(503, 'sync-failed'); return { changed: 0 } } })]])
  open.push(kb)
  const { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test', DSH_KB_SOCKET: join(dir, 'kb.sock') })
  const box = mailbox()
  const quota = fakeQuota()
  const service = await startIdentity(config, { mail: box.mail, quota }); open.push(service)
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
  return { config, kb, seen, audit, root, member, quota }
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

  it('serves browser content only as the verified actor and refreshes access before each read', async () => {
    const s = await site()
    const me = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(s.config.publicSocket, method, `/account/api/me${path}`, body, { cookie: s.member.cookie, ...headers })
    const kb = json(await me('POST', '/kb', { title: 'Member files' })).kb
    await me('POST', `/kb/sources?kb=${kb.id}&name=notes.md`, '# Verified member source', { 'content-type': 'application/octet-stream' })
    const endpoint = `/account/api/me/kb/content?kb=${kb.id}&path=raw%2Fnotes.md`
    expect((await call(s.config.publicSocket, 'GET', endpoint)).status).toBe(401)
    const reply = await me('GET', `/kb/content?kb=${kb.id}&path=raw%2Fnotes.md`, undefined, { 'x-dsh-user': s.root.id, 'x-dsh-role': 'admin' })
    expect(reply.status).toBe(200)
    expect(json(reply)).toEqual({ path: 'raw/notes.md', bytes: 24, text: '# Verified member source', truncated: false })
    expect(reply.headers).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    expect((await call(s.config.publicSocket, 'GET', endpoint, undefined, { cookie: s.root.cookie, 'x-dsh-user': s.member.id, 'x-dsh-role': 'member' })).status).toBe(404)
    // A stale projected disabled state is replaced from identity before the read is authorized.
    s.kb.core.store.principals.upsert({ userId: s.member.id, groups: [], email: s.member.email, disabled: true }, Date.now())
    expect((await me('GET', `/kb/content?kb=${kb.id}`)).status).toBe(200)
    const db = new DatabaseSync(s.config.databaseFile)
    try { db.prepare('INSERT INTO dsh_user_disabled (user_id, at, reason) VALUES (?, ?, ?)').run(s.member.id, Date.now(), 'disabled') } finally { db.close() }
    expect((await me('GET', `/kb/content?kb=${kb.id}`)).status).toBe(401)
    await until(() => s.audit().some(row => row.event === 'kb-content-read'))
    const event = s.audit().find(row => row.event === 'kb-content-read')!
    expect(event).toMatchObject({ user_id: s.member.id, email: 'member@example.test' })
    expect(JSON.stringify(event)).not.toContain('# Verified member source')
  })

  it('fails closed when current principal projection cannot be refreshed', async () => {
    const s = await site({ rejectPrincipalSync: () => true })
    const endpoint = '/account/api/me/kb/content?kb=kb_aaaaaaaaaaaaaaaa'
    const response = await call(s.config.publicSocket, 'GET', endpoint, undefined, { cookie: s.member.cookie })
    expect(response.status).toBe(503)
    expect(json(response)).toEqual({ code: 'unavailable' })
    expect((await call(s.config.publicSocket, 'GET', '/account/api/me/kb/shared', undefined, { cookie: s.member.cookie })).status).toBe(503)
  })

  it('ignores stale group membership on browser listings and content reads', async () => {
    const s = await site()
    const admin = (path: string, body: unknown) => call(s.config.publicSocket, 'POST', `/api/admin${path}`, body, { cookie: s.root.cookie })
    const group = json(await admin('/groups', { op: 'create', name: 'Readers' })).group
    await admin('/groups/members', { op: 'add', groupId: group.id, userId: s.member.id, password: PASSWORD })
    const rootHeaders = { 'x-dsh-user': s.root.id, 'x-dsh-email': s.root.email, 'x-dsh-role': 'admin', 'content-type': 'application/json' }
    const org = json(await call(s.config.kbSocket!, 'POST', '/admin/kb/org', { title: 'Handbook' }, rootHeaders)).kb
    expect((await call(s.config.kbSocket!, 'POST', '/admin/kb/org/rollback', { kb: org.id, scope: [{ kind: 'group', target: group.id }] }, rootHeaders)).status).toBe(200)
    const read = (path: string) => call(s.config.publicSocket, 'GET', `/account/api/me/kb/${path}`, undefined, { cookie: s.member.cookie })
    expect((await read(`content?kb=${org.id}&path=index.md`)).status).toBe(200)
    await admin('/groups/members', { op: 'remove', groupId: group.id, userId: s.member.id, password: PASSWORD })
    s.kb.core.store.principals.upsert({ userId: s.member.id, groups: [group.id], disabled: false, email: s.member.email }, Date.now())
    expect((await read(`content?kb=${org.id}&path=index.md`)).status).toBe(404)
    s.kb.core.store.principals.upsert({ userId: s.member.id, groups: [group.id], disabled: false, email: s.member.email }, Date.now())
    expect(json(await read('shared')).kbs).toEqual([])
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
    // Group scopes must name a group identity knows.
    const seen = s.seen.length
    expect(json(await admin('PUT', '/kb/limits', { scope: { type: 'group', id: 'local:missing' }, name: 'max_kbs', value: 2, password: PASSWORD }))).toEqual({ code: 'unknown-group' })
    expect(s.seen.length).toBe(seen)
    expect((await admin('PUT', '/kb/limits', { scope: { type: 'group', id: group.id }, name: 'max_kbs', value: 2, password: PASSWORD })).status).toBe(200)
    expect(s.kb.core.store.principals.get(s.member.id)).toMatchObject({ disabled: false, email: 'member@example.test' })
    // Archiving and restoring an org KB are routed through and need re-authentication.
    for (const path of ['/kb/org/archive', '/kb/org/restore']) {
      const before = s.seen.length
      expect(json(await admin('POST', path, { kb: 'kb_aaaaaaaaaaaaaaaa' }))).toEqual({ code: 'reauth-required', method: 'password' })
      expect(s.seen.length).toBe(before)
      expect(json(await admin('POST', path, { kb: 'kb_aaaaaaaaaaaaaaaa', password: PASSWORD }))).toEqual({ code: 'kb-not-found' })
    }
  })

  it('sets_the_daily_allowance_of_an_org_kb_budget_principal_with_reauth_and_audit', async () => {
    const s = await site()
    const admin = (path: string, body: unknown, cookie = s.root.cookie) => call(s.config.publicSocket, 'POST', `/api/admin${path}`, body, { cookie })
    const org = (await s.kb.core.store.kb.insert({ id: 'kb_aaaaaaaaaaaaaaaa', kind: 'org', ownerUserId: null, slug: 'handbook', title: 'Handbook', description: '' }, Date.now()), 'kb_aaaaaaaaaaaaaaaa')
    const principal = `org-kb-${org}`
    expect((await admin('/quota/principal', { principal, dailyTokens: 50000, password: PASSWORD }, s.member.cookie)).status).toBe(403)
    expect(json(await admin('/quota/principal', { principal, dailyTokens: 50000 }))).toEqual({ code: 'reauth-required', method: 'password' })
    // Only org KB budget principals that exist are accepted; login users go through /quota/user, and nothing else reaches the ledger.
    for (const bad of [s.member.id, 'org-kb-kb_bbbbbbbbbbbbbbbb', 'org-kb-../x', `org-kb-${org}\n`, 42]) {
      const reply = await admin('/quota/principal', { principal: bad, dailyTokens: 50000, password: PASSWORD })
      expect([400, 404]).toContain(reply.status)
    }
    expect(s.quota.calls).toEqual([])
    expect(json(await admin('/quota/principal', { principal, dailyTokens: 50000, password: PASSWORD })).overrides).toEqual([{ userId: principal, dailyTokens: 50000 }])
    expect(json(await admin('/quota/principal', { principal, dailyTokens: null, password: PASSWORD })).overrides).toEqual([])
    expect(s.quota.calls).toEqual([['user', principal, 50000], ['user', principal, null]])
    expect(s.audit().filter(r => r.event === 'admin-quota-change').map(r => r.detail)).toEqual([`by=root@example.test principal=${principal} kb=${org} daily=50000`, `by=root@example.test principal=${principal} kb=${org} daily=default`])
  })
})
