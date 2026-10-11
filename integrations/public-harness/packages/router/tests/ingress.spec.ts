import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountSuspendedError, CapacityError, parseUserId, type InstanceEndpoint } from '@public-harness/contracts'
import { createAdmission } from '../src/admission.ts'
import { startRouterHealthServer } from '../src/health.ts'
import { stripCookies } from '../src/proxy.ts'
import { createOwnerRouter } from '../src/routes.ts'
import { startRouterServer, type RouterServerConfig } from '../src/server.ts'

const alice = parseUserId('alice')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function backend(): Promise<{ endpoint: InstanceEndpoint; hits: Array<{ headers: Record<string, unknown>; bytes: number }> }> {
  const hits: Array<{ headers: Record<string, unknown>; bytes: number }> = []
  const server: Server = createServer((request, response) => {
    let bytes = 0
    request.on('data', chunk => { bytes += chunk.length })
    request.on('end', () => { hits.push({ headers: request.headers, bytes }); response.writeHead(200).end('ok') })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { endpoint: { kind: 'tcp', host: '127.0.0.1', port: (server.address() as AddressInfo).port }, hits }
}

function config(endpoint: InstanceEndpoint, extra: Partial<RouterServerConfig> = {}, secureSpy = vi.fn()): RouterServerConfig {
  return { host: '127.0.0.1', retryAfterSeconds: 2, maxSocketLifetimeMs: 1000,
    identity: { verify: async headers => { if (headers.cookie?.includes('team_dev=') || headers.cookie?.includes('s=1')) return alice; throw new Error('no') } },
    ownerRouter: createOwnerRouter({ instanceManager: { ensure: async () => endpoint, launchGrant: async () => '', stop: async () => {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 1000 }),
    launch: { open: async (...args) => { secureSpy(...args); return { location: '/u/alice/', setCookie: 'c=1' } } }, ...extra }
}

function send(options: { port?: number; socketPath?: string; path: string; method?: string; headers?: Record<string, string>; body?: Buffer | string; chunked?: boolean }):
Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...options.socketPath ? { socketPath: options.socketPath } : { host: '127.0.0.1', port: options.port },
      path: options.path, method: options.method ?? 'GET', headers: options.headers, agent: false }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk }).on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve({ status: 413, body: '' }); else reject(error) })
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('request limits and header hygiene', () => {
  it('rejects an oversized declared body with 413 before the instance sees anything', async () => {
    const { endpoint, hits } = await backend()
    const entry = await startRouterServer(config(endpoint, { maxRequestBodyBytes: 100 }))
    cleanups.push(() => entry.close())
    const result = await send({ port: entry.port, path: '/u/alice/upload', method: 'POST', headers: { cookie: 'team_dev=x.y', 'content-length': '101' }, body: Buffer.alloc(101) })
    expect(result.status).toBe(413)
    expect(hits).toHaveLength(0)
  })

  it('cuts off an oversized chunked body with 413 and accepts one within the limit', async () => {
    const { endpoint, hits } = await backend()
    const entry = await startRouterServer(config(endpoint, { maxRequestBodyBytes: 100 }))
    cleanups.push(() => entry.close())
    const headers = { cookie: 'team_dev=x.y', 'transfer-encoding': 'chunked' }
    expect((await send({ port: entry.port, path: '/u/alice/up', method: 'POST', headers, body: Buffer.alloc(500) })).status).toBe(413)
    expect((await send({ port: entry.port, path: '/u/alice/up', method: 'POST', headers, body: Buffer.alloc(50) })).status).toBe(200)
    expect(hits.filter(hit => hit.bytes === 50)).toHaveLength(1)
  })

  it('has a finite default and rejects non-positive limits', async () => {
    const { endpoint } = await backend()
    await expect(startRouterServer(config(endpoint, { maxRequestBodyBytes: 0 }))).rejects.toThrow(/positive/)
    await expect(startRouterServer(config(endpoint, { maxHeaderBytes: -1 }))).rejects.toThrow(/positive/)
    const { DEFAULT_MAX_BODY_BYTES } = await import('../src/proxy.ts')
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_MAX_BODY_BYTES)).toBe(true)
  })

  it('answers an oversized header block without reaching the instance', async () => {
    const { endpoint, hits } = await backend()
    const entry = await startRouterServer(config(endpoint, { maxHeaderBytes: 1024 }))
    cleanups.push(() => entry.close())
    const result = await send({ port: entry.port, path: '/u/alice/', headers: { cookie: `team_dev=x.y; pad=${'a'.repeat(4000)}` } })
    expect(result.status).toBe(431)
    expect(hits).toHaveLength(0)
  })

  it('removes the router identity cookie and forwarded-chain headers but keeps application cookies', async () => {
    const { endpoint, hits } = await backend()
    const entry = await startRouterServer(config(endpoint))
    cleanups.push(() => entry.close())
    await send({ port: entry.port, path: '/u/alice/x', headers: { cookie: 'a=1; team_dev=x.y; b=2', 'x-forwarded-for': '1.2.3.4',
      forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4', 'x-authentik-uid': 'bob', origin: 'https://h.test' } })
    expect(hits[0]!.headers.cookie).toBe('a=1; b=2')
    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-authentik-uid']) expect(hits[0]!.headers[name]).toBeUndefined()
    expect(hits[0]!.headers.origin).toBe('https://h.test')
  })

  it('strips named cookies precisely', () => {
    expect(stripCookies('team_dev=1', ['team_dev'])).toBeUndefined()
    expect(stripCookies('xteam_dev=1; team_dev=2', ['team_dev'])).toBe('xteam_dev=1')
  })
})

describe.skipIf(process.platform === 'win32')('production Unix-socket ingress', () => {
  async function socketDir(mode = 0o750): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-router-'))
    await chmod(dir, mode)
    return dir
  }
  const gid = process.getgid!()

  it('listens only on a 0660 Unix socket, and requires the public Host', async () => {
    const { endpoint } = await backend()
    const dir = await socketDir()
    const path = join(dir, 'router.sock')
    const secureSpy = vi.fn()
    const unauthenticated = { verify: async () => { throw new Error('no') } }
    const entry = await startRouterServer(config(endpoint, { host: undefined, listen: { kind: 'unix', path, gid }, secureCookies: true,
      publicAuthority: 'harness.example.test', identity: { verify: async headers => { if (headers.cookie === 's=1') return alice; return unauthenticated.verify() } },
      ownerRouter: { route: async () => ({ kind: 'ready', endpoint, upstreamPath: '/' }) } }, secureSpy))
    cleanups.push(() => entry.close())
    expect(entry.port).toBe(0)
    expect((await stat(path)).mode & 0o777).toBe(0o660)
    const ok = await send({ socketPath: path, path: '/u/alice/', headers: { host: 'harness.example.test', cookie: 's=1' } })
    expect(ok.status).toBe(200)
    expect((await send({ socketPath: path, path: '/u/alice/', headers: { host: 'evil.example', cookie: 's=1' } })).status).toBe(421)
    expect((await send({ socketPath: path, path: '/u/alice/', headers: { host: 'harness.example.test' } })).status).toBe(401)
    await entry.close()
    await expect(stat(path)).rejects.toThrow()
  })

  it('passes secure=true to the cookie exchange when the instance asks for a launch', async () => {
    const dir = await socketDir()
    const path = join(dir, 'router.sock')
    const rejecting = createServer((_request, response) => { response.writeHead(401).end() })
    await new Promise<void>(resolve => rejecting.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { rejecting.closeAllConnections(); await new Promise<void>(resolve => rejecting.close(() => resolve())) })
    const endpoint: InstanceEndpoint = { kind: 'tcp', host: '127.0.0.1', port: (rejecting.address() as AddressInfo).port }
    const secureSpy = vi.fn()
    const entry = await startRouterServer(config(endpoint, { host: undefined, listen: { kind: 'unix', path, gid }, secureCookies: true,
      publicAuthority: 'harness.example.test', identity: { verify: async () => alice },
      ownerRouter: { route: async () => ({ kind: 'ready', endpoint, upstreamPath: '/' }) } }, secureSpy))
    cleanups.push(() => entry.close())
    const response = await send({ socketPath: path, path: '/u/alice/', headers: { host: 'harness.example.test' } })
    expect(response.status).toBe(303)
    expect(secureSpy).toHaveBeenCalledWith(alice, endpoint, 'harness.example.test', true)
  })

  it.each([
    ['a TCP host', { host: '127.0.0.1' }, /TCP host/],
    ['the development selector', { developmentSelector: { users: [alice], issue: () => 'team_dev=a.b' } }, /development selector/],
    ['insecure cookies', { secureCookies: false }, /Secure/],
    ['a missing public authority', { publicAuthority: undefined }, /public authority/],
    ['a malformed public authority', { publicAuthority: 'a b/c' }, /public authority/],
  ])('refuses %s', async (_name, extra, message) => {
    const { endpoint } = await backend()
    const dir = await socketDir()
    const base = config(endpoint, { host: undefined, listen: { kind: 'unix', path: join(dir, 'r.sock'), gid }, secureCookies: true, publicAuthority: 'harness.example.test' })
    await expect(startRouterServer({ ...base, ...extra } as RouterServerConfig)).rejects.toThrow(message)
  })

  it('refuses a socket directory other accounts can enter, and a non-socket path', async () => {
    const { endpoint } = await backend()
    const open = await socketDir(0o755)
    const base = (path: string) => config(endpoint, { host: undefined, listen: { kind: 'unix', path, gid }, secureCookies: true, publicAuthority: 'h.test' })
    await expect(startRouterServer(base(join(open, 'r.sock')))).rejects.toThrow(/private directory/)
    const dir = await socketDir()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'r.sock'), 'x')
    await expect(startRouterServer(base(join(dir, 'r.sock')))).rejects.toThrow(/non-socket/)
  })

  it('never listens on a wildcard TCP address in development either', async () => {
    const { endpoint } = await backend()
    await expect(startRouterServer(config(endpoint, { host: '0.0.0.0' }))).rejects.toThrow(/loopback/)
    await expect(startRouterServer(config(endpoint, { host: '::' }))).rejects.toThrow(/loopback/)
  })

  it('serves aggregate health on a private socket and nothing else', async () => {
    const dir = await socketDir(0o700)
    const path = join(dir, 'health.sock')
    const health = await startRouterHealthServer(path, async () => ({ ok: true, activeInstances: 2, maxActiveInstances: 10 }))
    cleanups.push(() => health.close())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse((await send({ socketPath: path, path: '/health' })).body)).toEqual({ ok: true, activeInstances: 2, maxActiveInstances: 10 })
    expect((await send({ socketPath: path, path: '/users' })).status).toBe(404)
    const failing = await startRouterHealthServer(join(dir, 'h2.sock'), async () => { throw new Error('db at /secret') })
    cleanups.push(() => failing.close())
    const result = await send({ socketPath: join(dir, 'h2.sock'), path: '/health' })
    expect(result.status).toBe(503)
    expect(result.body).not.toContain('secret')
  })
})

describe('admission and typed refusals', () => {
  it('admits current holders and free slots only', async () => {
    const active = new Set([parseUserId('a'), parseUserId('b')])
    const admission = createAdmission({ maxActive: 2, active: () => active })
    expect(await admission.hasCapacity(parseUserId('a'))).toBe(true)
    expect(await admission.hasCapacity(parseUserId('c'))).toBe(false)
    active.delete(parseUserId('b'))
    expect(await admission.hasCapacity(parseUserId('c'))).toBe(true)
    expect(() => createAdmission({ maxActive: 0, active: () => [] })).toThrow(/positive/)
  })

  it('maps provisioner refusals to capacity and account responses', async () => {
    const router = (error: Error) => createOwnerRouter({ instanceManager: { ensure: async () => { throw error }, launchGrant: async () => '', stop: async () => {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 100 })
    expect(await router(new CapacityError()).route('/u/alice/', alice)).toEqual({ kind: 'rejected', status: 503, reason: 'capacity' })
    expect(await router(new AccountSuspendedError()).route('/u/alice/', alice)).toEqual({ kind: 'rejected', status: 403, reason: 'account' })
    expect(await router(new Error('boom')).route('/u/alice/', alice)).toEqual({ kind: 'rejected', status: 503, reason: 'service' })
  })
})
