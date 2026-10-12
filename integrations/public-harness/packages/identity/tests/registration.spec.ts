import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0)) await service.close() })
const CAPTCHA = { 'x-captcha-response': 'pass-captcha', 'x-forwarded-for': '203.0.113.7' }
const signup = (socket: string, email: string, headers = CAPTCHA) =>
  call(socket, 'POST', '/api/auth/sign-up/email', { name: 'A', email, password: 'correct horse battery', callbackURL: '/account/verified' }, headers)
const signin = (socket: string, email: string, password = 'correct horse battery') =>
  call(socket, 'POST', '/api/auth/sign-in/email', { email, password }, { 'x-forwarded-for': '203.0.113.7' })
const lookup = (socket: string, cookie: string) => call(socket, 'POST', '/internal/session', { cookie })

async function start(overrides = {}) {
  const { config } = await setup(overrides), box = mailbox()
  const service = await startIdentity(config, { mail: box.mail }); open.push(service)
  return { config, box, service }
}

describe('verified registration', () => {
  it('unverified_user_cannot_enter_harness', async () => {
    const { config, box } = await start()
    expect((await signup(config.publicSocket, 'a@example.test')).status).toBe(200)
    expect(box.sent).toHaveLength(1)
    const reply = await signin(config.publicSocket, 'a@example.test')
    expect(reply.status).toBe(403)
    expect(sessionCookie(reply)).toBeUndefined()
    expect((await lookup(config.sessionSocket, 'dsh-account.session_token=forged')).status).toBe(401)
  })

  it('verification_and_reset_are_single_use', async () => {
    const { config, box } = await start()
    await signup(config.publicSocket, 'b@example.test')
    const verify = linkIn(box.sent[0]!)
    const first = await call(config.publicSocket, 'GET', verify.pathname + verify.search)
    expect(first.status).toBeLessThan(400)
    expect((await call(config.publicSocket, 'GET', verify.pathname + verify.search)).status).toBe(400)
    const login = await signin(config.publicSocket, 'b@example.test')
    expect(login.status).toBe(200)
    const cookie = sessionCookie(login)!
    const session = await lookup(config.sessionSocket, cookie)
    expect(session.status).toBe(200)
    expect(Object.keys(JSON.parse(session.body)).sort()).toEqual(['expiresAt', 'sessionId', 'userId'])

    expect((await call(config.publicSocket, 'POST', '/api/auth/request-password-reset', { email: 'b@example.test', redirectTo: '/account/reset' }, CAPTCHA)).status).toBe(200)
    const reset = linkIn(box.sent.at(-1)!)
    const token = reset.pathname.split('/').at(-1)!
    const change = () => call(config.publicSocket, 'POST', '/api/auth/reset-password', { token, newPassword: 'a different long password' })
    expect((await change()).status).toBe(200)
    expect((await change()).status).toBeGreaterThanOrEqual(400)
    // Password reset revokes existing sessions.
    expect((await lookup(config.sessionSocket, cookie)).status).toBe(401)
  })

  it('registration_limit_survives_restart', async () => {
    const { config } = await setup({ limits: { signupPerIpPerHour: 20, signupPerDay: 1, resetPerEmailPerHour: 5, loginPerIpPerMinute: 30 } })
    const one = await startIdentity(config, { mail: mailbox().mail })
    expect((await signup(config.publicSocket, 'c@example.test')).status).toBe(200)
    await one.close()
    const two = await startIdentity(config, { mail: mailbox().mail }); open.push(two)
    expect((await signup(config.publicSocket, 'd@example.test')).status).toBe(429)
  })

  it('forged_origin_or_proxy_denied', async () => {
    const { config } = await start()
    const body = { name: 'E', email: 'e@example.test', password: 'correct horse battery' }
    expect((await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', body, { ...CAPTCHA, origin: 'https://evil.example' })).status).toBe(403)
    expect((await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', body, { ...CAPTCHA, 'x-forwarded-host': 'evil.example' })).status).toBe(400)
    expect((await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', body, { ...CAPTCHA, host: 'evil.example' })).status).toBe(400)
    expect((await call(config.publicSocket, 'GET', '/api/auth/get-session', undefined,
      { cookie: 'dsh-account.session_token=a; dsh-account.session_token=b' })).status).toBe(400)
    expect((await lookup(config.sessionSocket, 'dsh-account.session_token=a; dsh-account.session_token=b')).status).toBe(401)
    const db = new DatabaseSync(config.databaseFile)
    expect(db.prepare('SELECT count(*) AS n FROM user').get()).toEqual({ n: 0 })
    db.close()
  })

  it('captcha, closed enrollment and mail failure never verify anyone', async () => {
    const { config } = await start()
    expect((await signup(config.publicSocket, 'f@example.test', { ...CAPTCHA, 'x-captcha-response': 'wrong' })).status).toBe(400)
    const closed = await start({ enrollmentOpen: false })
    expect((await signup(closed.config.publicSocket, 'g@example.test')).status).toBe(403)
    const { config: broken } = await setup()
    const service = await startIdentity(broken, { mail: async () => { throw new Error('smtp down') } }); open.push(service)
    await signup(broken.publicSocket, 'h@example.test')
    expect((await signin(broken.publicSocket, 'h@example.test')).status).toBe(403)
  })

  it('production configuration rejects test transports and plain HTTP', async () => {
    await expect(setup({ mode: 'production' })).rejects.toThrow(/publicOrigin|test-transport/)
    await expect(setup({ mode: 'production', publicOrigin: 'https://harness.example' })).rejects.toThrow(/test-transport-in-production/)
  })
})
