import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0)) await service.close() })
const IP = { 'x-forwarded-for': '203.0.113.7' }
const CAPTCHA = { 'x-captcha-response': 'pass-captcha', ...IP }
const PASSWORD = 'correct horse battery'
const USAGE = { day: '2026-10-14', usedTokens: 1200, limitTokens: 400000, resetAt: '2026-10-15T00:00:00.000Z', history: [{ day: '2026-10-14', tokens: 1200 }] }

async function account(options: { usage?: boolean } = {}) {
  const { config } = await setup(), box = mailbox()
  const service = await startIdentity(config, { mail: box.mail, ...options.usage ? { usage: async () => USAGE } : {} }); open.push(service)
  const email = 'ann@example.test'
  await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'Ann', email, password: PASSWORD, callbackURL: '/account/verified' }, CAPTCHA)
  const verify = linkIn(box.sent[0]!)
  await call(config.publicSocket, 'GET', verify.pathname + verify.search)
  let n = 0
  // A fresh client address per sign-in keeps the per-address login limit out of these tests.
  const signIn = async (password = PASSWORD, agent = 'Browser A') => {
    const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password }, { 'x-forwarded-for': `203.0.113.${++n}`, 'user-agent': agent })
    return { status: reply.status, cookie: sessionCookie(reply), id: reply.status === 200 ? (JSON.parse(reply.body) as { user: { id: string } }).user.id : '' }
  }
  const first = await signIn()
  const get = (path: string, cookie = first.cookie!) => call(config.publicSocket, 'GET', `/account/api/me${path}`, undefined, { cookie })
  const post = (path: string, body: unknown, cookie = first.cookie!, headers: Record<string, string> = {}) => call(config.publicSocket, 'POST', `/account/api/me${path}`, body, { cookie, ...IP, 'user-agent': 'Browser A', ...headers })
  const audit = () => {
    const db = new DatabaseSync(config.databaseFile, { readOnly: true })
    try { return db.prepare('SELECT event, outcome, user_id FROM dsh_audit ORDER BY id').all() as Array<{ event: string; outcome: string; user_id: string }> } finally { db.close() }
  }
  const makeSso = () => {
    const db = new DatabaseSync(config.databaseFile)
    db.prepare("INSERT INTO dsh_user_origin (user_id, origin) VALUES (?, 'sso') ON CONFLICT(user_id) DO UPDATE SET origin = 'sso'").run(first.id)
    db.prepare("INSERT INTO dsh_sso_link (provider, subject, user_id, created_at, last_login_at) VALUES ('oidc', 'sub-ann', ?, 1760400000000, 1760403600000)").run(first.id)
    db.close()
  }
  return { config, first, signIn, get, post, audit, makeSso }
}

describe('personal center endpoints', () => {
  it('every_endpoint_requires_a_session', async () => {
    const a = await account()
    for (const path of ['/security', '/sessions', '/usage']) expect((await a.get(path, 'dsh-account.session_token=forged')).status).toBe(401)
    expect((await a.post('/sessions/revoke-others', {}, 'dsh-account.session_token=forged')).status).toBe(401)
  })

  it('writes_need_same_origin_json', async () => {
    const a = await account()
    expect((await a.post('/sessions/revoke-others', {}, a.first.cookie!, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await a.post('/sessions/revoke-others', 'x=1', a.first.cookie!, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415)
  })

  it('password_account_profile_and_security_view', async () => {
    const a = await account()
    expect(JSON.parse((await a.get('')).body)).toEqual({ id: a.first.id, email: 'ann@example.test', name: 'Ann', role: 'member', provider: 'password', passwordChange: true })
    expect(JSON.parse((await a.get('/security')).body)).toEqual({ provider: 'password', passwordChange: true, bindings: [] })
  })

  it('sso_account_sees_its_binding_and_cannot_change_a_password', async () => {
    const a = await account()
    a.makeSso()
    const security = JSON.parse((await a.get('/security')).body)
    expect(security).toEqual({ provider: 'oidc', passwordChange: false, bindings: [{ provider: 'oidc', subject: 'sub-ann', createdAt: 1760400000000, lastLoginAt: 1760403600000 }] })
    const refused = await a.post('/password', { currentPassword: PASSWORD, newPassword: 'another long passphrase' })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ code: 'sso-account' })
  })

  it('lists_sessions_without_tokens_and_revokes_one', async () => {
    const a = await account()
    const second = await a.signIn(PASSWORD, 'Browser B')
    const list = JSON.parse((await a.get('/sessions')).body) as { sessions: Array<Record<string, unknown>> }
    expect(list.sessions).toHaveLength(2)
    expect(list.sessions.filter(s => s.current)).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(a.first.cookie!.split('=')[1]!.split('.')[0]!)
    for (const s of list.sessions) expect(Object.keys(s).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'ipAddress', 'lastActiveAt', 'userAgent'])
    const other = list.sessions.find(s => !s.current)!, current = list.sessions.find(s => s.current)!
    expect(other.userAgent).toBe('Browser B')
    expect((await a.post('/sessions/revoke', { id: current.id })).status).toBe(400)
    expect((await a.post('/sessions/revoke', { id: 'not-mine' })).status).toBe(404)
    expect((await a.post('/sessions/revoke', { id: other.id })).status).toBe(200)
    expect((await a.get('', second.cookie!)).status).toBe(401)
    expect((await a.get('')).status).toBe(200)
    expect(a.audit()).toContainEqual({ event: 'session-revoke', outcome: 'ok', user_id: a.first.id })
  })

  it('signs_out_every_other_session', async () => {
    const a = await account()
    const b = await a.signIn(), c = await a.signIn()
    expect(JSON.parse((await a.post('/sessions/revoke-others', {})).body)).toEqual({ revoked: 2 })
    for (const s of [b, c]) expect((await a.get('', s.cookie!)).status).toBe(401)
    expect(JSON.parse((await a.get('/sessions')).body).sessions).toHaveLength(1)
    expect(a.audit()).toContainEqual({ event: 'sessions-revoke-others', outcome: 'ok', user_id: a.first.id })
  })

  it('password_change_reauthenticates_and_signs_out_other_sessions', async () => {
    const a = await account()
    const other = await a.signIn()
    const wrong = await a.post('/password', { currentPassword: 'not the password', newPassword: 'another long passphrase' })
    expect(wrong.status).toBe(403)
    expect(JSON.parse(wrong.body)).toEqual({ code: 'reauth' })
    expect((await a.post('/password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400)
    const changed = await a.post('/password', { currentPassword: PASSWORD, newPassword: 'another long passphrase' })
    expect(changed.status).toBe(200)
    const renewed = sessionCookie(changed)!
    // The session minted by the change keeps this device's description.
    expect(JSON.parse((await a.get('/sessions', renewed)).body).sessions).toMatchObject([{ current: true, userAgent: 'Browser A', ipAddress: '203.0.113.7' }])
    expect((await a.get('', other.cookie!)).status).toBe(401)
    expect((await a.signIn()).status).toBe(401)
    expect((await a.signIn('another long passphrase')).status).toBe(200)
    expect(a.audit()).toEqual(expect.arrayContaining([
      { event: 'password-change', outcome: 'denied', user_id: a.first.id }, { event: 'password-change', outcome: 'ok', user_id: a.first.id }]))
  })

  it('usage_is_the_users_own_ledger_view', async () => {
    const without = await account()
    expect((await without.get('/usage')).status).toBe(404)
    const a = await account({ usage: true })
    const reply = await a.get('/usage')
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual(USAGE)
  })
})
