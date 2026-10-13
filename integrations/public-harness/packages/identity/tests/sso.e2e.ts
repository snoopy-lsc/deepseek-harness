/** Real-browser enterprise sign-in against the local mock IdP: login page → IdP redirect → callback → account page, plus a refused group.
 * Runs only when PUBLIC_HARNESS_E2E_BROWSER names a Chrome executable; the IdP is a 127.0.0.1 mock with throwaway keys. */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { startIdentity } from '../src/index.ts'
import { call, mailbox, setup } from './helpers.ts'
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, startMockIdp, type MockIdp } from './mock-oidc.ts'
import { MOCK_DT_CLIENT_ID, MOCK_DT_CORP_ID, MOCK_DT_SECRET, startMockDingtalk } from './mock-dingtalk.ts'
import { MOCK_AGENT_ID, MOCK_CORP_ID, MOCK_WECOM_SECRET, startMockWecom } from './mock-wecom.ts'

const executable = process.env.PUBLIC_HARNESS_E2E_BROWSER
// Its own port, so this file can run in parallel with registration.e2e.ts, which owns 18443.
const ORIGIN = 'http://127.0.0.1:18444'
const cleanups: Array<() => Promise<void>> = []

/** Stand-in for the HTTPS proxy: every path goes to the identity socket. */
async function front(identitySocket: string, origin = ORIGIN): Promise<Server> {
  const server = createServer((req, res) => {
    const upstream = httpRequest({ socketPath: identitySocket, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1' }, agent: false },
      reply => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res) })
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  await new Promise<void>(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve))
  return server
}

describe.skipIf(executable === undefined)('enterprise SSO in a real browser', () => {
  let browser: Browser, idp: MockIdp, sessionSocket = ''
  beforeAll(async () => {
    idp = await startMockIdp({ sub: 'emp-100', email: 'dana@corp.example', name: 'Dana', groups: ['engineering'] }); cleanups.push(() => idp.close())
    const { config } = await setup({ publicOrigin: ORIGIN }, { DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: idp.issuer, DSH_OIDC_CLIENT_ID: MOCK_CLIENT_ID, DSH_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      DSH_SSO_ALLOWED_GROUPS: 'engineering' })
    sessionSocket = config.sessionSocket
    const identity = await startIdentity(config, { mail: mailbox().mail }); cleanups.push(() => identity.close())
    const proxy = await front(config.publicSocket); cleanups.push(async () => { proxy.closeAllConnections(); proxy.close() })
    // Box-only test harness: the sandbox is the product's concern on the dedicated host, not this flow's.
    browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false })
    cleanups.push(() => browser.close())
  })
  afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  it('company_login_lands_on_the_account_page', async () => {
    const context = await browser.newContext(), page = await context.newPage()
    await page.goto(`${ORIGIN}/account/login?lang=en`)
    expect(await page.locator('form[data-action=login]').count()).toBe(0)
    await page.click('[data-sso-start]')
    await page.waitForURL(/\/account\/\?return=%2Fu%2F/)
    await page.waitForFunction(() => document.querySelector('[data-session] p')?.textContent === 'dana@corp.example')
    const cookie = (await context.cookies(ORIGIN)).find(entry => entry.name === 'dsh-account.session_token')!
    expect(cookie.httpOnly).toBe(true)
    expect((await call(sessionSocket, 'POST', '/internal/session', { cookie: `${cookie.name}=${cookie.value}` })).status).toBe(200)
    // Sign-out ends the Harness session only; the browser stays on Harness and never visits the IdP.
    await page.click('[data-action=logout]')
    await page.waitForFunction(() => /signed out/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(page.url().startsWith(ORIGIN)).toBe(true)
    expect((await call(sessionSocket, 'POST', '/internal/session', { cookie: `${cookie.name}=${cookie.value}` })).status).toBe(401)
    await context.close()
  })

  it('user_outside_allowed_groups_sees_a_localized_refusal', async () => {
    idp.user = { sub: 'emp-200', email: 'erin@corp.example', groups: ['sales'] }
    // The callback redirect carries no `lang`, so the refusal follows the browser's Accept-Language.
    const context = await browser.newContext({ locale: 'zh-CN' }), page = await context.newPage()
    await page.goto(`${ORIGIN}/account/login`)
    await page.click('[data-sso-start]')
    await page.waitForURL(/\/account\/login\?sso_error=group/)
    await page.waitForFunction(() => /群组/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect((await context.cookies(ORIGIN)).some(entry => entry.name === 'dsh-account.session_token')).toBe(false)
    await context.close()
  })
})

describe.skipIf(executable === undefined)('WeCom QR login in a real browser', () => {
  const WECOM_ORIGIN = 'http://127.0.0.1:18445'
  const local: Array<() => Promise<void>> = []
  let browser: Browser
  beforeAll(async () => {
    const mock = await startMockWecom(); local.push(() => mock.close())
    const { config } = await setup({ publicOrigin: WECOM_ORIGIN }, { DSH_SSO_PROVIDER: 'wecom', DSH_WECOM_CORP_ID: MOCK_CORP_ID, DSH_WECOM_AGENT_ID: MOCK_AGENT_ID,
      DSH_WECOM_SECRET: MOCK_WECOM_SECRET, DSH_WECOM_API_BASE: mock.base, DSH_WECOM_LOGIN_URL: mock.loginUrl, DSH_SSO_ALLOWED_GROUPS: '2' })
    const identity = await startIdentity(config, { mail: mailbox().mail }); local.push(() => identity.close())
    const proxy = await front(config.publicSocket, WECOM_ORIGIN); local.push(async () => { proxy.closeAllConnections(); proxy.close() })
    browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false })
    local.push(() => browser.close())
  })
  afterAll(async () => { for (const cleanup of local.splice(0).reverse()) await cleanup() })

  it('scan_lands_on_the_account_page', async () => {
    // The mock login page stands in for the QR scan and redirects straight back with a code.
    const context = await browser.newContext({ locale: 'zh-CN' }), page = await context.newPage()
    await page.goto(`${WECOM_ORIGIN}/account/login`)
    await page.click('[data-sso-start]')
    await page.waitForURL(/\/account\/\?return=%2Fu%2F/)
    await page.waitForFunction(() => /@sso\.invalid$/.test(document.querySelector('[data-session] p')?.textContent ?? ''))
    expect((await context.cookies(WECOM_ORIGIN)).some(entry => entry.name === 'dsh-account.session_token')).toBe(true)
    await context.close()
  })
})

describe.skipIf(executable === undefined)('DingTalk login in a real browser', () => {
  const DT_ORIGIN = 'http://127.0.0.1:18446'
  const local: Array<() => Promise<void>> = []
  let browser: Browser
  beforeAll(async () => {
    const mock = await startMockDingtalk(); local.push(() => mock.close())
    const { config } = await setup({ publicOrigin: DT_ORIGIN }, { DSH_SSO_PROVIDER: 'dingtalk', DSH_DINGTALK_CLIENT_ID: MOCK_DT_CLIENT_ID, DSH_DINGTALK_CLIENT_SECRET: MOCK_DT_SECRET,
      DSH_DINGTALK_CORP_ID: MOCK_DT_CORP_ID, DSH_DINGTALK_API_BASE: mock.base, DSH_DINGTALK_OAPI_BASE: mock.base, DSH_DINGTALK_LOGIN_URL: mock.loginUrl, DSH_SSO_ALLOWED_GROUPS: '2' })
    const identity = await startIdentity(config, { mail: mailbox().mail }); local.push(() => identity.close())
    const proxy = await front(config.publicSocket, DT_ORIGIN); local.push(async () => { proxy.closeAllConnections(); proxy.close() })
    browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false })
    local.push(() => browser.close())
  })
  afterAll(async () => { for (const cleanup of local.splice(0).reverse()) await cleanup() })

  it('scan_lands_on_the_account_page', async () => {
    // The mock authorize page stands in for the QR scan and consent, and redirects straight back with an authCode.
    const context = await browser.newContext({ locale: 'zh-CN' }), page = await context.newPage()
    await page.goto(`${DT_ORIGIN}/account/login`)
    await page.click('[data-sso-start]')
    await page.waitForURL(/\/account\/\?return=%2Fu%2F/)
    await page.waitForFunction(() => /^dingtalk-[0-9a-f]{32}@sso\.invalid$/.test(document.querySelector('[data-session] p')?.textContent ?? ''))
    expect((await context.cookies(DT_ORIGIN)).some(entry => entry.name === 'dsh-account.session_token')).toBe(true)
    await context.close()
  })
})
