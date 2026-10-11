import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUserId, type InstanceEndpoint } from '../../contracts/src/index.ts'
import { createOwnerRouter } from '../src/routes.ts'
import { createDevelopmentIdentity } from '../src/dev-identity.ts'
import { randomBytes } from 'node:crypto'
import { startRouterServer } from '../src/server.ts'

const servers: Server[] = []
const upgraded: Duplex[] = []
afterEach(async () => {
  for (const socket of upgraded.splice(0)) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})
async function backend(name: string): Promise<InstanceEndpoint> {
  const server = createServer((request, response) => {
    if (request.url === '/') { response.writeHead(401).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name, path: request.url, host: request.headers.host, origin: request.headers.origin,
      leakedIdentity: request.headers['x-authentik-uid'] ?? null,
    }))
  })
  server.on('upgrade', (request, socket) => {
    upgraded.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', data => socket.write(`${name}:${request.url}:${data.toString()}`))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { kind: 'tcp', host: '127.0.0.1', port: (server.address() as AddressInfo).port }
}

function router(endpoints: Record<string, InstanceEndpoint>, maxSocketLifetimeMs = 1000) {
  const ensure = vi.fn(async (userId: string) => endpoints[userId]!)
  return startRouterServer({ retryAfterSeconds: 2, host: '127.0.0.1', maxSocketLifetimeMs,
    identity: { async verify(headers) {
      const match = /^dev=(alice|bob)$/.exec(headers.cookie ?? '')
      if (!match) throw new Error('unauthenticated')
      return parseUserId(match[1]!)
    } },
    ownerRouter: createOwnerRouter({ instanceManager: { ensure, async launchGrant() { return '' }, async stop() {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 1000 }),
    launch: { async open(userId) { return { location: `/u/${userId}/`, setCookie: 'dsh-auth=x; Path=/u/alice/; HttpOnly' } } },
  })
}

function rawUpgrade(port: number, path: string, cookie?: string, payload?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1')
    let result = ''
    socket.once('error', reject)
    socket.on('data', chunk => {
      result += chunk.toString()
      if (result.includes('\r\n\r\n') && payload === undefined) { resolve(result); socket.destroy() }
      else if (result.includes('\r\n\r\n') && payload !== undefined && !result.includes(payload)) socket.write(payload)
      else if (payload !== undefined && result.includes(`alice:/ws:${payload}`)) { resolve(result); socket.destroy() }
    })
    socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`))
  })
}

describe('owner-only HTTP and upgrade forwarding', () => {
  it('forwards only to the signed-in owner and strips the mount prefix', async () => {
    const alice = await backend('alice')
    const bob = await backend('bob')
    const entry = await router({ alice, bob })
    try {
      const base = `http://127.0.0.1:${entry.port}`
      const response = await fetch(`${base}/u/alice/api/list?limit=2`, { headers: {
        cookie: 'dev=alice', origin: base, 'x-authentik-uid': 'forged',
      } })
      expect(await response.json()).toEqual({ name: 'alice', path: '/api/list?limit=2',
        host: `127.0.0.1:${entry.port}`, origin: base, leakedIdentity: null })
      expect((await fetch(`${base}/u/bob/api/list`, { headers: { cookie: 'dev=alice' } })).status).toBe(404)
      expect((await fetch(`${base}/u/alice/api/list`)).status).toBe(401)
      const login = await fetch(`${base}/u/alice/`, { headers: { cookie: 'dev=alice' }, redirect: 'manual' })
      expect(login.status).toBe(303)
      expect(login.headers.get('location')).toBe('/u/alice/')
      expect(login.headers.get('set-cookie')).toContain('Path=/u/alice/')
    } finally { await entry.close() }
  })

  it('checks identity and ownership before every WebSocket upgrade', async () => {
    const alice = await backend('alice')
    const bob = await backend('bob')
    const entry = await router({ alice, bob })
    try {
      expect(await rawUpgrade(entry.port, '/u/alice/ws')).toMatch(/^HTTP\/1.1 401/)
      expect(await rawUpgrade(entry.port, '/u/bob/ws', 'dev=alice')).toMatch(/^HTTP\/1.1 404/)
      expect(await rawUpgrade(entry.port, '/u/alice/ws', 'dev=alice')).toMatch(/^HTTP\/1.1 101/)
      expect(await rawUpgrade(entry.port, '/u/alice/ws', 'dev=alice', 'ping')).toContain('alice:/ws:ping')
    } finally { await entry.close() }
  })

  it('refuses a public development bind', async () => {
    await expect(startRouterServer({ retryAfterSeconds: 2, host: '0.0.0.0', maxSocketLifetimeMs: 1000,
      identity: { async verify() { return parseUserId('alice') } },
      ownerRouter: { async route() { return { kind: 'starting' as const } } },
      launch: { async open() { return { location: '/', setCookie: '' } } },
    })).rejects.toThrow(/loopback/i)
  })

  it('closes an upgraded socket at its configured lifetime', async () => {
    const alice = await backend('alice')
    const entry = await router({ alice }, 30)
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(entry.port, '127.0.0.1')
        let upgraded = false
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade stayed open')) }, 1000)
        socket.once('error', reject)
        socket.once('connect', () => socket.write(`GET /u/alice/ws HTTP/1.1\r\nHost: 127.0.0.1:${entry.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: dev=alice\r\n\r\n`))
        socket.on('data', bytes => { if (bytes.toString().includes('101 Switching Protocols')) upgraded = true })
        socket.once('close', () => {
          clearTimeout(timer)
          if (upgraded) resolve()
          else reject(new Error('upgrade closed before acceptance'))
        })
      })
    } finally { await entry.close() }
  })

  it('selects only fixed local test users on the loopback entry', async () => {
    const alice = await backend('alice')
    const identity = createDevelopmentIdentity({ mode: 'team-dev', host: '127.0.0.1',
      secret: randomBytes(32), testUsers: ['alice'], lifetimeMs: 60_000 })
    const entry = await startRouterServer({ retryAfterSeconds: 2, host: '127.0.0.1', maxSocketLifetimeMs: 1000,
      identity, developmentSelector: { users: [parseUserId('alice')], issue: identity.issue },
      ownerRouter: createOwnerRouter({ instanceManager: { ensure: async () => alice,
        async launchGrant() { return '' }, async stop() {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 1000 }),
      launch: { async open() { return { location: '/u/alice/', setCookie: 'dsh-auth=x; Path=/u/alice/' } } } })
    try {
      const base = `http://127.0.0.1:${entry.port}`
      expect((await fetch(`${base}/dev`)).status).toBe(200)
      const selected = await fetch(`${base}/dev/select/alice`, { redirect: 'manual' })
      expect(selected.status).toBe(303)
      expect(selected.headers.get('set-cookie')).toMatch(/team_dev=.*; Path=\/; HttpOnly; SameSite=Strict/)
      expect((await fetch(`${base}/dev/select/bob`, { redirect: 'manual' })).status).toBe(404)
    } finally { await entry.close() }
  })
})
