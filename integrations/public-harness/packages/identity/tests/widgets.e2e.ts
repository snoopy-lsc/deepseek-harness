/** Real-browser check of the per-provider widget glue: the page loads the SDK under its CSP, the SDK callback becomes the
 * request header, and invite mode sends the invite code. SDKs are local stubs served through request interception; no
 * provider is contacted and no credential is involved. Runs only when PUBLIC_HARNESS_E2E_BROWSER names a Chrome executable. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { CaptchaWidget } from '../src/captcha.ts'
import { contentSecurityPolicy, renderPage, type PageCaptcha } from '../src/pages.ts'

const executable = process.env.PUBLIC_HARNESS_E2E_BROWSER
const SITE = 'http://127.0.0.1:18444'
const SDK = 'http://127.0.0.1:18445'
const STUBS: Record<string, string> = {
  tencent: 'window.TencentCaptcha=function(appId,cb){this.show=function(){cb({ret:0,ticket:"ticket-"+appId,randstr:"rs1"})}}',
  aliyun: 'window.initAliyunCaptcha=function(o){document.querySelector(o.button).addEventListener("click",function(){o.success("param-"+o.SceneId+"-"+window.AliyunCaptchaConfig.prefix+"-"+window.AliyunCaptchaConfig.region)})}',
  turnstile: 'window.turnstile={render:function(el,o){o.callback("ts-"+o.sitekey)},reset:function(){}}',
}
const widget = (provider: CaptchaWidget['provider'], params: Record<string, string>): CaptchaWidget => ({ provider, script: `${SDK}/${provider}.js`, params,
  csp: { script: [SDK], frame: [], connect: [], img: [], style: [], inlineStyle: provider !== 'turnstile' } })

async function open(browser: Browser, captcha: PageCaptcha): Promise<{ page: Page; sent: Array<Record<string, string>>; violations: string[] }> {
  const page = await browser.newPage(), sent: Array<Record<string, string>> = [], violations: string[] = []
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()) })
  await page.route(`${SITE}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/auth/')) { sent.push(route.request().headers()); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); return }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': contentSecurityPolicy('n0nce', captcha) },
      body: renderPage('en', 'register', 'n0nce', '', captcha) })
  })
  await page.route(`${SDK}/**`, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUBS[new URL(route.request().url()).pathname.slice(1, -3)]! }))
  await page.goto(`${SITE}/account/register`)
  await page.fill('input[name=name]', 'Alice'); await page.fill('input[name=email]', 'alice@example.test'); await page.fill('input[name=password]', 'correct horse battery')
  return { page, sent, violations }
}

describe.skipIf(executable === undefined)('captcha widgets in a real browser', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false }) })
  afterAll(async () => { await browser.close() })

  it('tencent_ticket_and_randstr_reach_the_server', async () => {
    const { page, sent, violations } = await open(browser, widget('tencent', { appId: '199999164' }))
    await page.click('button[type=submit]')
    await page.waitForFunction(() => /human verification/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(sent).toHaveLength(0)
    await page.click('[data-captcha-button]')
    await page.waitForFunction(() => /complete/.test(document.querySelector('[data-captcha-state]')?.textContent ?? ''))
    await page.click('button[type=submit]')
    await page.waitForFunction(() => /Check your email/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(JSON.parse(sent[0]!['x-captcha-response']!)).toEqual({ ticket: 'ticket-199999164', randstr: 'rs1' })
    expect(violations).toEqual([])
  })

  it('aliyun_verify_param_reaches_the_server', async () => {
    const { page, sent, violations } = await open(browser, widget('aliyun', { sceneId: 'scene1', prefix: 'pfx', region: 'cn' }))
    await page.click('[data-captcha-button]')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => /Check your email/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(sent[0]!['x-captcha-response']).toBe('param-scene1-pfx-cn')
    expect(violations).toEqual([])
  })

  it('turnstile_token_reaches_the_server', async () => {
    const { page, sent } = await open(browser, widget('turnstile', { siteKey: 'site1' }))
    await page.click('button[type=submit]')
    await page.waitForFunction(() => /Check your email/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(sent[0]!['x-captcha-response']).toBe('ts-site1')
  })

  it('invite_code_reaches_the_server', async () => {
    const { page, sent } = await open(browser, { provider: 'none' })
    await page.fill('input[name=invite]', 'dshinv-abcdefghijklmnopqrstuvwxyz')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => /Check your email/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(sent[0]!['x-invite-code']).toBe('dshinv-abcdefghijklmnopqrstuvwxyz')
    expect(sent[0]!['x-captcha-response']).toBeUndefined()
  })
})
