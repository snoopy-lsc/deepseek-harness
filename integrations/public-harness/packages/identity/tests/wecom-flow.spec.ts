/** WeCom sign-in through the public listener against the local mock: JIT with a placeholder email, binding, department allow-list, 503 and the `.invalid` guard. */
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { wecomPlaceholderEmail } from '../src/sso/wecom.ts'
import { call, mailbox, sessionCookie, setup, type Reply } from './helpers.ts'
import { MOCK_AGENT_ID, MOCK_CORP_ID, MOCK_WECOM_SECRET, startMockWecom, type MockWecom } from './mock-wecom.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const IP = { 'x-forwarded-for': '203.0.113.7' }

async function start(extra: Record<string, string> = {}) {
  const mock = await startMockWecom(); open.push(mock)
  const { config } = await setup({}, { DSH_SSO_PROVIDER: 'wecom', DSH_WECOM_CORP_ID: MOCK_CORP_ID, DSH_WECOM_AGENT_ID: MOCK_AGENT_ID, DSH_WECOM_SECRET: MOCK_WECOM_SECRET,
    DSH_WECOM_API_BASE: mock.base, DSH_WECOM_LOGIN_URL: mock.loginUrl, DSH_SSO_ALLOWED_GROUPS: '2', DSH_WECOM_TIMEOUT_MS: '1000', ...extra })
  const service = await startIdentity(config, { mail: mailbox().mail }); open.push(service)
  return { mock, config }
}
const cookieOf = (reply: Reply) => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]!).find(cookie => cookie.startsWith('dsh-sso='))!
async function scanLogin(socket: string, mock: MockWecom) {
  const begin = await call(socket, 'GET', '/api/auth/sso/start', undefined, IP)
  expect(begin.status).toBe(302)
  const back = await mock.scan(String(begin.headers.location))
  return call(socket, 'GET', back.pathname + back.search, undefined, { ...IP, cookie: cookieOf(begin) })
}

describe('WeCom sign-in', () => {
  it('scan_creates_one_verified_account_bound_to_the_corp_scoped_userid', async () => {
    const { mock, config } = await start()
    const first = await scanLogin(config.publicSocket, mock)
    expect(first.status).toBe(302)
    expect(String(first.headers.location)).toMatch(/^\/account\/\?return=/)
    const session = await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(first)! })
    expect(session.status).toBe(200)
    const userId = JSON.parse(session.body).userId as string
    const second = await scanLogin(config.publicSocket, mock)
    expect(JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(second)! })).body).userId).toBe(userId)
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      expect(db.sso.findSubject('wecom', `${MOCK_CORP_ID}:zhangsan`)).toBe(userId)
      const row = db.db.prepare('SELECT email, emailVerified, name FROM user WHERE id = ?').get(userId) as { email: string; emailVerified: number; name: string }
      expect(row).toEqual({ email: wecomPlaceholderEmail(`${MOCK_CORP_ID}:zhangsan`), emailVerified: 1, name: '张三' })
      expect(Number((db.db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n)).toBe(1)
    } finally { db.close() }
  })

  it('department_outside_the_allow_list_gets_no_account', async () => {
    const { mock, config } = await start()
    mock.members.set('Sales', { name: 'S', department: [4] }); mock.scanner = 'Sales'
    const reply = await scanLogin(config.publicSocket, mock)
    expect(String(reply.headers.location)).toBe('/account/login?sso_error=group')
    expect(sessionCookie(reply)).toBeUndefined()
  })

  it('wecom_outage_answers_503', async () => {
    const { mock, config } = await start()
    mock.httpStatus = 503
    const reply = await scanLogin(config.publicSocket, mock)
    expect(reply.status).toBe(503)
    expect(sessionCookie(reply)).toBeUndefined()
  })

  it('placeholder_addresses_cannot_be_registered_to_squat_an_employee', async () => {
    const { config } = await start({ DSH_CAPTCHA_PROVIDER: 'none' })
    const db = await openIdentityDatabase(config.databaseFile)
    const { code } = db.mintInvite(3_600_000); db.close()
    const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'X', email: wecomPlaceholderEmail(`${MOCK_CORP_ID}:zhangsan`).toUpperCase(),
      password: 'correct horse battery', callbackURL: '/account/verified' }, { ...IP, 'x-invite-code': code })
    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body).code).toBe('email')
  })
})
