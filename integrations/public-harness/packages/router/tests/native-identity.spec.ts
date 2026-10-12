import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserId, type InstanceEndpoint, type UserId } from '@public-harness/contracts'
import { startIdentity } from '@public-harness/identity'
import { createNativeIdentity, NATIVE_SESSION_COOKIES, sessionCookies } from '../src/native-identity.ts'
import { createOwnerRouter } from '../src/routes.ts'
import { startRouterServer } from '../src/server.ts'
import { call, linkIn, mailbox, sessionCookie, setup } from '../../identity/tests/helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function backend(): Promise<{ endpoint: InstanceEndpoint; hits: string[] }> {
  const hits: string[] = []
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if (request.url?.endsWith('/stream')) { response.writeHead(200); response.write('open'); return }
    response.writeHead(200).end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { endpoint: { kind: 'tcp', host: '127.0.0.1', port: (server.address() as AddressInfo).port }, hits }
}

async function world(active: (userId: UserId) => boolean = () => true) {
  const { config } = await setup(), box = mailbox()
  let service = await startIdentity(config, { mail: box.mail })
  let stopped = false
  cleanups.push(async () => { if (!stopped) await service.close() })
  await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'A', email: 'a@example.test', password: 'correct horse battery' },
    { 'x-captcha-response': 'pass-captcha', 'x-forwarded-for': '203.0.113.9' })
  const verify = linkIn(box.sent[0]!)
  await call(config.publicSocket, 'GET', verify.pathname + verify.search)
  const login = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'a@example.test', password: 'correct horse battery' })
  const cookie = sessionCookie(login)!
  const lookup = JSON.parse((await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).body) as { userId: string }
  const userId = parseUserId(lookup.userId)
  const { endpoint, hits } = await backend()
  const identity = createNativeIdentity({ socketPath: config.sessionSocket, timeoutMs: 1000, maxResponseBytes: 4096, isActive: async id => active(id) })
  const router = await startRouterServer({ host: '127.0.0.1', retryAfterSeconds: 2, maxSocketLifetimeMs: 5000, identity, sessionRecheckMs: 50,
    stripCookies: [...NATIVE_SESSION_COOKIES],
    ownerRouter: createOwnerRouter({ instanceManager: { ensure: async () => endpoint, launchGrant: async () => '', stop: async () => {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 1000 }),
    launch: { open: async () => ({ location: `/u/${userId}/`, setCookie: 'c=1' }) } })
  cleanups.push(() => router.close())
  return { config, cookie, userId, hits, router,
    stopIdentity: async () => { stopped = true; await service.close() },
    restartIdentity: async () => { service = await startIdentity(config, { mail: box.mail }); stopped = false } }
}

function get(port: number, path: string, cookie?: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false, headers: { ...cookie === undefined ? {} : { cookie }, ...extra } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.once('error', reject); req.end()
  })
}

describe('native browser sessions at the router', () => {
  it('logout_denies_next_request', async () => {
    const w = await world()
    expect(await get(w.router.port, `/u/${w.userId}/x`, w.cookie)).toBe(200)
    expect(w.hits).toHaveLength(1)
    expect((await call(w.config.publicSocket, 'POST', '/api/auth/sign-out', {}, { cookie: w.cookie })).status).toBe(200)
    expect(await get(w.router.port, `/u/${w.userId}/x`, w.cookie)).toBe(401)
    expect(w.hits).toHaveLength(1)
  })

  it('suspension_denies_next_handshake', async () => {
    let active = true
    const w = await world(() => active)
    active = false
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(w.router.port, '127.0.0.1', () => socket.write(`GET /u/${w.userId}/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${w.cookie}\r\n\r\n`))
      let text = ''; socket.on('data', chunk => { text += chunk }); socket.once('close', () => resolve(text)); socket.once('error', reject)
    })
    expect(status).toMatch(/^HTTP\/1\.1 401/)
    expect(w.hits).toHaveLength(0)
  })

  it('open_stream_is_closed_on_recheck', async () => {
    const w = await world()
    const closed = new Promise<number>((resolve, reject) => {
      const started = Date.now()
      const req = httpRequest({ host: '127.0.0.1', port: w.router.port, path: `/u/${w.userId}/stream`, agent: false, headers: { cookie: w.cookie } }, res => {
        res.resume(); res.once('close', () => resolve(Date.now() - started)); res.once('error', () => resolve(Date.now() - started))
        void call(w.config.publicSocket, 'POST', '/api/auth/sign-out', {}, { cookie: w.cookie })
      })
      req.once('error', () => resolve(Date.now() - started)); req.end()
      setTimeout(() => reject(new Error('stream stayed open')), 3000)
    })
    expect(await closed).toBeLessThan(3000)
  })

  it('identity_outage_never_reuses_positive_result', async () => {
    const w = await world()
    expect(await get(w.router.port, `/u/${w.userId}/x`, w.cookie)).toBe(200)
    await w.stopIdentity()
    expect(await get(w.router.port, `/u/${w.userId}/x`, w.cookie)).toBe(503)
    expect(w.hits).toHaveLength(1)
  })

  it('spoofed identity headers and development cookies produce no identity', async () => {
    const w = await world()
    expect(await get(w.router.port, `/u/${w.userId}/x`, `team_dev=${w.userId}.sig`, { 'x-authentik-uid': w.userId, 'x-authentik-jwt': 'a.b.c' })).toBe(401)
    expect(sessionCookies('team_dev=a.b; other=1')).toBeUndefined()
    expect(sessionCookies('team_dev=a; dsh-account.session_token=t')).toBe('dsh-account.session_token=t')
    expect(w.hits).toHaveLength(0)
  })
})
