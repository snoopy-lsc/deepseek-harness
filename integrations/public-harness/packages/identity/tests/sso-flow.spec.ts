/** Enterprise SSO through the public listener against a local mock IdP: JIT, binding, group policy, state, gates and sign-out. */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, mailbox, sessionCookie, setup, type Reply } from './helpers.ts'
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, startMockIdp, type MockIdp } from './mock-oidc.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const IP = { 'x-forwarded-for': '203.0.113.7' }
const ssoEnv = (idp: MockIdp, extra: Record<string, string> = {}) => ({ DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: idp.issuer, DSH_OIDC_CLIENT_ID: MOCK_CLIENT_ID,
  DSH_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET, DSH_SSO_ALLOWED_GROUPS: 'engineering,/corp/research', DSH_OIDC_TIMEOUT_MS: '2000', ...extra })

async function start(extra: Record<string, string> = {}) {
  const idp = await startMockIdp(); open.push(idp)
  const { config } = await setup({}, ssoEnv(idp, extra)), box = mailbox()
  const service = await startIdentity(config, { mail: box.mail }); open.push(service)
  return { idp, config, box }
}
const cookiesOf = (reply: Reply) => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]!)
/** Run one browser sign-in: start, IdP redirect, callback. Returns the callback reply. */
async function ssoLogin(socket: string, idp: MockIdp, opts: { returnTo?: string; swapBrowser?: boolean } = {}) {
  const begin = await call(socket, 'GET', `/api/auth/sso/start${opts.returnTo === undefined ? '' : `?return=${encodeURIComponent(opts.returnTo)}`}`, undefined, IP)
  expect(begin.status).toBe(302)
  const browser = cookiesOf(begin).find(cookie => cookie.startsWith('dsh-sso='))
  expect(browser).toBeDefined()
  const back = await idp.authorize(String(begin.headers.location))
  const cookie = opts.swapBrowser ? 'dsh-sso=someone-else' : browser!
  const reply = await call(socket, 'GET', back.pathname + back.search, undefined, { ...IP, cookie })
  return { reply, back, cookie }
}
const lookup = (socket: string, cookie: string) => call(socket, 'POST', '/internal/session', { cookie })
const userCount = (file: string) => Number((new DatabaseSync(file).prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n)

describe('enterprise SSO sign-in', () => {
  it('returns_to_the_originating_page_and_rejects_foreign_or_encoded_targets', async () => {
    const { idp, config } = await start()
    const first = await ssoLogin(config.publicSocket, idp)
    const userId = JSON.parse((await lookup(config.sessionSocket, sessionCookie(first.reply)!)).body).userId as string
    // The originating page (here a settings deep link) is restored; hostile or foreign targets fall back to the user's route.
    expect(String((await ssoLogin(config.publicSocket, idp, { returnTo: `/u/${userId}/?panel=team.admin#audit` })).reply.headers.location)).toBe(`/u/${userId}/?panel=team.admin#audit`)
    for (const hostile of ['//evil.example/', '/u/someone-else/', `/u/${userId}/%2e%2e/x`, '/\\evil.example', 'https://evil.example/']) {
      expect(String((await ssoLogin(config.publicSocket, idp, { returnTo: hostile })).reply.headers.location), hostile).toBe(`/u/${userId}/`)
    }
  })

  it('first_login_creates_a_verified_account_and_later_logins_reuse_it', async () => {
    const { idp, config } = await start()
    const { reply } = await ssoLogin(config.publicSocket, idp)
    expect(reply.status).toBe(302)
    const cookie = sessionCookie(reply)!
    const session = await lookup(config.sessionSocket, cookie)
    expect(session.status).toBe(200)
    const userId = JSON.parse(session.body).userId as string
    // Straight back into Harness, not via the account page.
    expect(String(reply.headers.location)).toBe(`/u/${userId}/`)

    idp.user = { ...idp.user, email: 'alice.renamed@corp.example', name: 'Alice R' }
    const second = await ssoLogin(config.publicSocket, idp, { returnTo: '/account/' })
    expect(String(second.reply.headers.location)).toBe('/account/')
    expect(JSON.parse((await lookup(config.sessionSocket, sessionCookie(second.reply)!)).body).userId).toBe(userId)
    expect(userCount(config.databaseFile)).toBe(1)
    const profile = await call(config.publicSocket, 'GET', '/account/api/me/profile', undefined, { cookie: sessionCookie(second.reply)! })
    expect(JSON.parse(profile.body)).toMatchObject({ name: 'Alice R', managedBy: 'sso', email: 'alice@corp.example' })
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      expect(db.sso.findSubject('oidc', 'emp-001')).toBe(userId)
      expect(db.sso.origin(userId)).toBe('sso')
      expect(db.sso.listAudit(0).filter(row => row.event === 'sso-sign-in' && row.outcome === 'ok')).toHaveLength(2)
    } finally { db.close() }
  })

  it('group_allow_list_gates_creation_and_every_later_login', async () => {
    const { idp, config } = await start()
    idp.user = { sub: 'emp-002', email: 'bob@corp.example', groups: ['sales'] }
    const denied = await ssoLogin(config.publicSocket, idp)
    expect(denied.reply.status).toBe(302)
    expect(String(denied.reply.headers.location)).toBe('/account/login?sso_error=group')
    expect(sessionCookie(denied.reply)).toBeUndefined()
    expect(userCount(config.databaseFile)).toBe(0)
    idp.user = { sub: 'emp-002', email: 'bob@corp.example', groups: ['/corp/research'] }
    expect(sessionCookie((await ssoLogin(config.publicSocket, idp)).reply)).toBeDefined()
    idp.user = { sub: 'emp-002', email: 'bob@corp.example', groups: [] }
    expect(String((await ssoLogin(config.publicSocket, idp)).reply.headers.location)).toBe('/account/login?sso_error=group')
  })

  it('department_claim_can_satisfy_the_allow_list', async () => {
    const { idp, config } = await start({ DSH_OIDC_GROUP_CLAIMS: 'groups,department', DSH_SSO_ALLOWED_GROUPS: 'R&D' })
    idp.user = { sub: 'emp-003', email: 'carol@corp.example', groups: [], department: 'R&D' }
    expect(sessionCookie((await ssoLogin(config.publicSocket, idp)).reply)).toBeDefined()
  })

  it('email_already_held_by_another_account_is_refused_not_merged', async () => {
    const { idp, config, box } = await start({ DSH_CAPTCHA_PROVIDER: 'none' })
    const db = await openIdentityDatabase(config.databaseFile)
    const { code } = db.mintInvite(3_600_000)
    db.close()
    const signup = await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'C', email: 'alice@corp.example', password: 'correct horse battery', callbackURL: '/account/verified' },
      { ...IP, 'x-invite-code': code })
    expect(signup.status).toBe(200)
    const verify = linkIn(box.sent[0]!)
    expect((await call(config.publicSocket, 'GET', verify.pathname + verify.search)).status).toBeLessThan(400)
    const { reply } = await ssoLogin(config.publicSocket, idp)
    expect(String(reply.headers.location)).toBe('/account/login?sso_error=email-in-use')
    expect(sessionCookie(reply)).toBeUndefined()
    const after = await openIdentityDatabase(config.databaseFile)
    try {
      expect(after.sso.findSubject('oidc', 'emp-001')).toBeUndefined()
      const id = (after.db.prepare('SELECT id FROM user WHERE email = ?').get('alice@corp.example') as { id: string }).id
      expect(after.sso.origin(id)).toBe('invite')
    } finally { after.close() }
    // The invited contractor still signs in with a password; SSO mode does not lock them out.
    expect((await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'alice@corp.example', password: 'correct horse battery' }, IP)).status).toBe(200)
  })

  it('state_is_single_use_and_bound_to_the_starting_browser', async () => {
    const { idp, config } = await start()
    const crossed = await ssoLogin(config.publicSocket, idp, { swapBrowser: true })
    expect(String(crossed.reply.headers.location)).toBe('/account/login?sso_error=state')
    expect(sessionCookie(crossed.reply)).toBeUndefined()
    const ok = await ssoLogin(config.publicSocket, idp)
    expect(sessionCookie(ok.reply)).toBeDefined()
    const replay = await call(config.publicSocket, 'GET', ok.back.pathname + ok.back.search, undefined, { ...IP, cookie: ok.cookie })
    expect(String(replay.headers.location)).toBe('/account/login?sso_error=state')
    const noCookie = await call(config.publicSocket, 'GET', '/api/auth/sso/callback?code=x&state=y', undefined, IP)
    expect(String(noCookie.headers.location)).toBe('/account/login?sso_error=state')
    const idpError = await call(config.publicSocket, 'GET', '/api/auth/sso/callback?error=access_denied&state=y', undefined, { ...IP, cookie: ok.cookie })
    expect(String(idpError.headers.location)).toBe('/account/login?sso_error=idp')
  })

  it('idp_outage_answers_503_and_creates_nothing', async () => {
    const { idp, config } = await start()
    idp.tokenStatus = 503
    const { reply } = await ssoLogin(config.publicSocket, idp)
    expect(reply.status).toBe(503)
    expect(sessionCookie(reply)).toBeUndefined()
    expect(userCount(config.databaseFile)).toBe(0)
  })

  it('password_paths_are_closed_to_sso_accounts_and_public_signup', async () => {
    const { idp, config, box } = await start()
    await ssoLogin(config.publicSocket, idp)
    const signin = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'alice@corp.example', password: 'whatever long password' }, IP)
    expect(signin.status).toBe(403)
    expect(JSON.parse(signin.body).code).toBe('sso-only')
    const signup = await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'M', email: 'm@corp.example', password: 'correct horse battery', callbackURL: '/account/verified' },
      { ...IP, 'x-captcha-response': 'pass-captcha' })
    expect(signup.status).toBe(403)
    expect(JSON.parse(signup.body).code).toBe('sso-only')
    const reset = await call(config.publicSocket, 'POST', '/api/auth/request-password-reset', { email: 'alice@corp.example', redirectTo: '/account/reset' }, { ...IP, 'x-captcha-response': 'pass-captcha' })
    expect(reset.status).toBe(200)
    expect(box.sent).toHaveLength(0)
  })

  it('sign_out_revokes_only_the_harness_session', async () => {
    const { idp, config } = await start()
    const first = sessionCookie((await ssoLogin(config.publicSocket, idp)).reply)!
    const second = sessionCookie((await ssoLogin(config.publicSocket, idp)).reply)!
    const out = await call(config.publicSocket, 'POST', '/api/auth/sign-out', {}, { ...IP, cookie: first })
    expect(out.status).toBe(200)
    expect(out.headers.location).toBeUndefined()
    expect(out.body).not.toContain(idp.issuer)
    expect((await lookup(config.sessionSocket, first)).status).toBe(401)
    expect((await lookup(config.sessionSocket, second)).status).toBe(200)
  })

  it('sso_routes_do_not_exist_when_sso_is_off', async () => {
    const { config } = await setup(), service = await startIdentity(config, { mail: mailbox().mail }); open.push(service)
    expect((await call(config.publicSocket, 'GET', '/api/auth/sso/start', undefined, IP)).status).toBe(404)
    expect((await call(config.publicSocket, 'GET', '/api/auth/sso/callback?code=x&state=y', undefined, IP)).status).toBe(404)
  })
})
