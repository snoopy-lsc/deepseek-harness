/** Real-browser account flow: register → verify (test mailbox) → login → enter Harness → logout blocks HTTP and WS.
 * Runs only when PUBLIC_HARNESS_E2E_BROWSER names a Chrome executable; no model or API key is involved. */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { createNativeIdentity, NATIVE_SESSION_COOKIES } from '../../router/src/native-identity.ts'
import { createOwnerRouter } from '../../router/src/routes.ts'
import { startRouterServer } from '../../router/src/server.ts'
import { startIdentity } from '../src/index.ts'
import { linkIn, mailbox, ORIGIN, setup } from './helpers.ts'

const executable = process.env.PUBLIC_HARNESS_E2E_BROWSER
const cleanups: Array<() => Promise<void>> = []

/** Stand-in for the HTTPS proxy: account paths to the identity socket, everything else to the router. */
async function front(identitySocket: string, routerPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    const account = req.url?.startsWith('/account/') || req.url?.startsWith('/api/auth/')
    const upstream = httpRequest({ ...account ? { socketPath: identitySocket } : { host: '127.0.0.1', port: routerPort }, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1' }, agent: false }, reply => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res) })
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const upstream = connect(routerPort, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\r\n')}\r\n\r\n`)
      upstream.write(head); upstream.pipe(socket); socket.pipe(upstream)
    })
    upstream.once('error', () => socket.destroy()); socket.once('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => server.listen(Number(new URL(ORIGIN).port), '127.0.0.1', resolve))
  return server
}

describe.skipIf(executable === undefined)('account flow in a real browser', () => {
  let browser: Browser
  const box = mailbox()
  let routerPort = 0
  beforeAll(async () => {
    const { config } = await setup()
    const identity = await startIdentity(config, { mail: box.mail }); cleanups.push(() => identity.close())
    const instance = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>harness ok</h1>') })
    instance.on('upgrade', (_req, socket: Socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n') })
    await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { instance.closeAllConnections(); instance.close() })
    const endpoint = { kind: 'tcp' as const, host: '127.0.0.1' as const, port: (instance.address() as { port: number }).port }
    const router = await startRouterServer({ host: '127.0.0.1', retryAfterSeconds: 2, maxSocketLifetimeMs: 60_000, sessionRecheckMs: 100,
      identity: createNativeIdentity({ socketPath: config.sessionSocket, timeoutMs: 1000, maxResponseBytes: 4096, isActive: async () => true }),
      stripCookies: [...NATIVE_SESSION_COOKIES],
      ownerRouter: createOwnerRouter({ instanceManager: { ensure: async () => endpoint, launchGrant: async () => '', stop: async () => {} },
        isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 1000 }),
      launch: { open: async () => ({ location: '/', setCookie: 'c=1' }) } })
    cleanups.push(() => router.close())
    routerPort = router.port
    const proxy = await front(config.publicSocket, routerPort); cleanups.push(async () => { proxy.closeAllConnections(); proxy.close() })
    // Box-only test harness: the sandbox is the product's concern on the dedicated host, not this flow's.
    browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false })
    cleanups.push(() => browser.close())
  })
  afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  it('register_verify_login_logout', async () => {
    const page = await browser.newPage()
    await page.goto(`${ORIGIN}/account/register?captcha=pass-captcha&lang=zh`)
    await page.fill('input[name=name]', 'Alice')
    await page.fill('input[name=email]', 'alice@example.test')
    await page.fill('input[name=password]', 'correct horse battery')
    await page.click('button')
    await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent?.includes('验证'))
    // Signing in before verification is refused and shows an error.
    await page.goto(`${ORIGIN}/account/login`)
    await page.fill('input[name=email]', 'alice@example.test'); await page.fill('input[name=password]', 'correct horse battery'); await page.click('button')
    await page.waitForFunction(() => /failed|失败/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    const verify = linkIn(box.sent[0]!)
    await page.goto(`${ORIGIN}${verify.pathname}${verify.search}`)
    expect(page.url()).toContain('/account/verified')
    await page.goto(`${ORIGIN}/account/login?lang=en`)
    await page.fill('input[name=email]', 'alice@example.test'); await page.fill('input[name=password]', 'correct horse battery'); await page.click('button')
    await page.waitForURL(/\/account\/\?return=/)
    const harness = page.locator('a', { hasText: 'Open my Harness' })
    await harness.waitFor()
    await harness.click()
    await page.waitForSelector('text=harness ok')
    const userPath = new URL(page.url()).pathname
    expect(userPath).toMatch(/^\/u\/[A-Za-z0-9_-]+\/$/)
    // Open a WebSocket through the router, then sign out: the next request is denied and the open channel closes.
    await page.evaluate(path => { (window as unknown as { ws: WebSocket }).ws = new WebSocket(`ws://127.0.0.1:18443${path}ws`) }, userPath)
    await page.goto(`${ORIGIN}/account/`)
    await page.locator('button[data-action=logout]').click()
    await page.waitForFunction(() => /signed out/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    expect(await page.evaluate(path => fetch(`${path}x`, { credentials: 'same-origin' }).then(r => r.status), userPath)).toBe(401)
    const ws = await page.evaluate(path => new Promise<string>(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:18443${path}ws`)
      socket.onopen = () => resolve('open'); socket.onerror = () => resolve('denied'); socket.onclose = () => resolve('denied')
    }), userPath)
    expect(ws).toBe('denied')
  })

  it('password reset and loading/error states', async () => {
    const page = await browser.newPage()
    await page.goto(`${ORIGIN}/account/reset?captcha=pass-captcha`)
    await page.fill('input[name=email]', 'alice@example.test'); await page.click('button')
    await page.waitForFunction(() => /reset link/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    const link = linkIn(box.sent.at(-1)!)
    await page.goto(`${ORIGIN}${link.pathname}${link.search}`)
    expect(page.url()).toContain('/account/reset?token=')
    await page.fill('form[data-action=reset] input[name=newPassword]', 'another long password')
    await page.click('form[data-action=reset] button')
    await page.waitForFunction(() => /Password changed/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
    await page.click('form[data-action=reset] button')
    await page.waitForFunction(() => /failed/.test(document.querySelector('[role=alert]')?.textContent ?? ''))
  })
})
