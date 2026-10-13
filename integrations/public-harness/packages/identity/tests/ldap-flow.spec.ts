/** LDAP sign-in through the public listener against the local directory: JIT and binding, generic refusals, lockout, groups, 503 and the login page. */
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { call, mailbox, sessionCookie, setup } from './helpers.ts'
import { MOCK_LDAP_BASE, MOCK_LDAP_BIND_DN, MOCK_LDAP_BIND_PASSWORD, MOCK_USER_PASSWORD, startMockLdap } from './mock-ldap.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const IP = { 'x-forwarded-for': '203.0.113.7' }

async function start(extra: Record<string, string> = {}) {
  const mock = await startMockLdap(); open.push(mock)
  const { config } = await setup({}, { DSH_SSO_PROVIDER: 'ldap', DSH_LDAP_URL: mock.url, DSH_LDAP_CA_FILE: mock.pki.caFile, DSH_LDAP_BIND_DN: MOCK_LDAP_BIND_DN,
    DSH_LDAP_BIND_PASSWORD: MOCK_LDAP_BIND_PASSWORD, DSH_LDAP_BASE_DN: MOCK_LDAP_BASE, DSH_LDAP_USER_FILTER: '(objectClass=user)', DSH_LDAP_TIMEOUT_MS: '1000',
    DSH_SSO_ALLOWED_GROUPS: `CN=Engineering, OU=Groups, ${MOCK_LDAP_BASE}`, ...extra })
  const service = await startIdentity(config, { mail: mailbox().mail }); open.push(service)
  return { mock, config }
}
const signIn = (socket: string, username: string, password = MOCK_USER_PASSWORD, ip = IP) => call(socket, 'POST', '/api/auth/sso/ldap/sign-in', { username, password }, ip)

describe('LDAP sign-in', () => {
  it('password_sign_in_creates_one_account_bound_to_the_object_guid', async () => {
    const { config, mock } = await start()
    const first = await signIn(config.publicSocket, 'alice')
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body).redirect).toMatch(/^\/account\/\?return=%2Fu%2F/)
    const userId = JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(first)! })).body).userId as string
    const second = await signIn(config.publicSocket, 'ALICE')
    expect(JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(second)! })).body).userId).toBe(userId)
    const db = await openIdentityDatabase(config.databaseFile)
    try { expect(db.sso.findSubject('ldap', `${new URL(mock.url).host}|00112233-4455-6677-8899-aabbccddeeff`)).toBe(userId) } finally { db.close() }
  })

  it('refusals_are_identical_and_lock_out_per_user_and_ip', async () => {
    const { config } = await start()
    const replies = [await signIn(config.publicSocket, 'alice', 'wrong'), await signIn(config.publicSocket, 'nobody'), await signIn(config.publicSocket, 'carol', 'wrong'),
      await signIn(config.publicSocket, 'alice', '')]
    for (const reply of replies) { expect(reply.status).toBe(401); expect(JSON.parse(reply.body).code).toBe('credentials'); expect(sessionCookie(reply)).toBeUndefined() }
    // Three more wrong passwords for alice from this IP reach the per-(user, IP) limit; the right password is then refused too, but not from another IP.
    for (let i = 0; i < 3; i++) await signIn(config.publicSocket, 'alice', 'wrong')
    expect((await signIn(config.publicSocket, 'alice')).status).toBe(429)
    expect((await signIn(config.publicSocket, 'alice', MOCK_USER_PASSWORD, { 'x-forwarded-for': '203.0.113.8' })).status).toBe(200)
  })

  it('groups_disabled_accounts_and_outages', async () => {
    const { config, mock } = await start()
    const bob = await signIn(config.publicSocket, 'bob')
    expect(bob.status).toBe(403)
    expect(JSON.parse(bob.body).code).toBe('group')
    // Disabled after the right password: still the generic answer.
    expect(JSON.parse((await signIn(config.publicSocket, 'carol')).body).code).toBe('credentials')
    mock.delayMs = 1500
    expect((await signIn(config.publicSocket, 'alice')).status).toBe(503)
  })

  it('nested_groups_admit_through_the_chain_and_the_page_shows_the_form', async () => {
    const { config } = await start({ DSH_LDAP_GROUP_MODE: 'nested' })
    expect((await signIn(config.publicSocket, 'bob')).status).toBe(200)
    const page = await call(config.publicSocket, 'GET', '/account/login', undefined, IP)
    expect(page.body).toContain('data-action="ldap"')
    expect(page.body).not.toContain('href="/api/auth/sso/start"')
  })
})
