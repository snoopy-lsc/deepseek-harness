/** SAML sign-in through the public listener against the local mock IdP: cross-site post bounce, binding, groups, replay, IdP-initiated refusal and metadata. */
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { call, mailbox, sessionCookie, setup, type Reply } from './helpers.ts'
import { MOCK_IDP_ENTITY_ID, MOCK_SP_ENTITY_ID, startMockSaml, type MockSaml } from './mock-saml.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const IP = { 'x-forwarded-for': '203.0.113.7' }
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

async function start() {
  const mock = await startMockSaml(); open.push(mock)
  const { config } = await setup({}, { DSH_SSO_PROVIDER: 'saml', DSH_SAML_SP_ENTITY_ID: MOCK_SP_ENTITY_ID, DSH_SAML_IDP_ENTITY_ID: MOCK_IDP_ENTITY_ID,
    DSH_SAML_IDP_SSO_URL: mock.ssoUrl, DSH_SAML_IDP_CERT_FILE: mock.keys.certFile, DSH_SSO_ALLOWED_GROUPS: 'engineering' })
  const service = await startIdentity(config, { mail: mailbox().mail }); open.push(service)
  return { mock, config }
}
const cookieOf = (reply: Reply) => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]!).find(cookie => cookie.startsWith('dsh-sso='))!
const encode = (form: { SAMLResponse: string; RelayState: string }) => new URLSearchParams({ SAMLResponse: form.SAMLResponse, RelayState: form.RelayState }).toString()

/** Start, let the IdP answer, deliver its cross-site post, then the same-origin re-post the bounce page makes. */
async function samlLogin(socket: string, origin: string, mock: MockSaml, edit = (form: { SAMLResponse: string; RelayState: string }) => form) {
  const begin = await call(socket, 'GET', '/api/auth/sso/start', undefined, IP)
  expect(begin.status).toBe(302)
  const form = edit(await mock.login(String(begin.headers.location)))
  const bounce = await call(socket, 'POST', '/api/auth/sso/acs', encode(form), { ...IP, ...FORM, origin: 'null' })
  expect(bounce.status).toBe(200)
  expect(bounce.headers['content-security-policy']).toMatch(/form-action 'self'/)
  expect(sessionCookie(bounce)).toBeUndefined()
  return { begin, reply: await call(socket, 'POST', '/api/auth/sso/acs', encode(form), { ...IP, ...FORM, origin, cookie: cookieOf(begin) }), form }
}

describe('SAML sign-in', () => {
  it('post_binding_creates_one_account_bound_to_the_entity_scoped_name_id', async () => {
    const { mock, config } = await start()
    const { reply } = await samlLogin(config.publicSocket, config.publicOrigin, mock)
    expect(reply.status).toBe(302)
    expect(String(reply.headers.location)).toMatch(/^\/account\/\?return=/)
    const userId = JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(reply)! })).body).userId as string
    const again = await samlLogin(config.publicSocket, config.publicOrigin, mock)
    expect(JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(again.reply)! })).body).userId).toBe(userId)
    const db = await openIdentityDatabase(config.databaseFile)
    try { expect(db.sso.findSubject('saml', `${MOCK_IDP_ENTITY_ID}|u-7f3a9c`)).toBe(userId) } finally { db.close() }
  })

  it('replay_missing_cookie_and_idp_initiated_posts_are_refused', async () => {
    const { mock, config } = await start()
    const { begin, form } = await samlLogin(config.publicSocket, config.publicOrigin, mock)
    // The same response again: the state was consumed, and the assertion ID is recorded.
    const replay = await call(config.publicSocket, 'POST', '/api/auth/sso/acs', encode(form), { ...IP, ...FORM, origin: config.publicOrigin, cookie: cookieOf(begin) })
    expect(String(replay.headers.location)).toBe('/account/login?sso_error=state')
    const other = await samlLogin(config.publicSocket, config.publicOrigin, mock, f => f)
    expect(other.reply.status).toBe(302)
    // A fresh attempt posted without this browser's cookie (login CSRF) is refused.
    const begin2 = await call(config.publicSocket, 'GET', '/api/auth/sso/start', undefined, IP)
    const form2 = await mock.login(String(begin2.headers.location))
    const noCookie = await call(config.publicSocket, 'POST', '/api/auth/sso/acs', encode(form2), { ...IP, ...FORM, origin: config.publicOrigin })
    expect(String(noCookie.headers.location)).toBe('/account/login?sso_error=state')
    // IdP-initiated: no RelayState, nothing to bind to.
    const unsolicited = await call(config.publicSocket, 'POST', '/api/auth/sso/acs', encode({ SAMLResponse: mock.respond({ id: '_unsolicited', acs: `${config.publicOrigin}/api/auth/sso/acs` }, { inResponseTo: null }), RelayState: '' }),
      { ...IP, ...FORM, origin: config.publicOrigin, cookie: cookieOf(begin2) })
    expect(String(unsolicited.headers.location)).toBe('/account/login?sso_error=state')
    const bad = await call(config.publicSocket, 'POST', '/api/auth/sso/acs', 'SAMLResponse=%3Cx%3E&RelayState=a', { ...IP, ...FORM, origin: 'null' })
    expect(bad.status).toBe(400)
    // The bounce page's own re-post must arrive same-origin; a cross-origin one is refused rather than bounced in a loop.
    expect((await call(config.publicSocket, 'POST', '/api/auth/sso/acs?bounced=1', encode(form2), { ...IP, ...FORM, origin: 'null' })).status).toBe(403)
  })

  it('groups_outside_the_allow_list_get_no_account', async () => {
    const { mock, config } = await start()
    mock.user.attributes.groups = ['sales']
    const { reply } = await samlLogin(config.publicSocket, config.publicOrigin, mock)
    expect(String(reply.headers.location)).toBe('/account/login?sso_error=group')
  })

  it('sp_metadata_is_published', async () => {
    const { config } = await start()
    const reply = await call(config.publicSocket, 'GET', '/api/auth/sso/metadata', undefined, IP)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toMatch(/samlmetadata\+xml/)
    expect(reply.body).toContain(`Location="${config.publicOrigin}/api/auth/sso/acs"`)
  })
})
