import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startProvisionerServer } from '@public-harness/provisioner/protocol'
import { readConfigFile } from '../src/config-file.ts'
import { parseProvisionerProfileConfig } from '../src/provisioner-service.ts'
import { parseQuotaProfileConfig } from '../src/quota-service.ts'
import { buildTeamRouterServerConfig, parseTeamRouterConfig, startTeamRouter, type TeamRouterConfig } from '../src/team-router.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const now = 1_760_000_000
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

const jwt = (claims: Record<string, unknown> = {}): string => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'current' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: 'https://login.example.test/', aud: 'public-harness', sub: 'alice', exp: now + 60, iat: now, ...claims })).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`
}

function routerConfig(dir: string, overrides: Partial<TeamRouterConfig> = {}): TeamRouterConfig {
  return { publicAuthority: 'harness.example.test', routerSocket: join(dir, 'router.sock'), routerSocketGid: process.getgid!(),
    healthSocket: join(dir, 'private', 'health.sock'), provisionerSocket: join(dir, 'private', 'prov.sock'),
    identity: { issuer: 'https://login.example.test/', audience: 'public-harness', publicKeyFiles: { current: join(dir, 'authentik.pem') } },
    routeWaitMs: 2000, retryAfterSeconds: 2, launchExchangeMs: 2000, socketLifetimeMs: 60_000, maxRequestBodyBytes: 1_000_000, maxHeaderBytes: 16_384, ...overrides }
}

function send(socketPath: string, headers: Record<string, string>, path = '/u/alice/x'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequest({ socketPath, path, headers, agent: false }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk }).on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject).end()
  })
}

describe.skipIf(process.platform === 'win32')('production router composition', () => {
  async function environment(status = 'running') {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-prod-'))
    await chmod(dir, 0o750)
    await mkdir(join(dir, 'private'), { mode: 0o700 })
    await writeFile(join(dir, 'authentik.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
    const seen: string[] = []
    const instance = createServer((request, response) => { seen.push(String(request.headers.host)); response.writeHead(200).end(`hello ${request.url}`) })
    await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
    closers.push(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())) })
    const port = (instance.address() as AddressInfo).port
    const state = { status }
    const provisioner = await startProvisionerServer(join(dir, 'private', 'prov.sock'), async request => {
      if (request.op === 'ensure') return { kind: 'tcp', host: '127.0.0.1', port }
      if (request.op === 'status') return state.status
      return request.op === 'launch-grant' ? 'grant' : null
    })
    closers.push(() => provisioner.close())
    const router = await startTeamRouter(routerConfig(dir), { clock: () => new Date(now * 1000) })
    closers.push(() => router.close())
    return { dir, seen, state }
  }

  it('authenticates only the signed authentik identity and routes to the provisioned instance', async () => {
    const { dir, seen } = await environment()
    const socket = join(dir, 'router.sock')
    const good = { host: 'harness.example.test', 'x-authentik-jwt': jwt(), 'x-authentik-uid': 'alice' }
    const ok = await send(socket, good)
    expect(ok).toEqual({ status: 200, body: 'hello /x' })
    expect(seen).toEqual(['harness.example.test'])
    // Forged, mismatched, cross-user, dev-cookie, and wrong-host inputs all fail closed.
    expect((await send(socket, { host: 'harness.example.test', 'x-authentik-uid': 'alice' })).status).toBe(401)
    expect((await send(socket, { ...good, 'x-authentik-uid': 'bob' })).status).toBe(401)
    expect((await send(socket, { ...good, cookie: 'team_dev=alice.deadbeef' }, '/dev/select/alice')).status).toBe(404)
    expect((await send(socket, { host: 'harness.example.test', cookie: 'team_dev=alice.deadbeef' })).status).toBe(401)
    expect((await send(socket, good, '/u/bob/x')).status).toBe(404)
    expect((await send(socket, { ...good, host: 'evil.example' })).status).toBe(421)
    expect((await send(socket, { ...good, 'x-authentik-jwt': jwt({ exp: now - 1 }) })).status).toBe(401)
    expect((await send(socket, { ...good, 'x-authentik-jwt': jwt({ aud: 'other' }) })).status).toBe(401)
  })

  it('denies a deactivated account on the next request and answers the health socket without identities', async () => {
    const { dir, state } = await environment()
    const good = { host: 'harness.example.test', 'x-authentik-jwt': jwt(), 'x-authentik-uid': 'alice' }
    expect((await send(join(dir, 'router.sock'), good)).status).toBe(200)
    state.status = 'suspended'
    expect((await send(join(dir, 'router.sock'), good)).status).toBe(401)
    const health = await send(join(dir, 'private', 'health.sock'), {}, '/health')
    expect(JSON.parse(health.body)).toEqual({ ok: true })
  })

  it('never attaches the development selector or a TCP bind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-prod-'))
    const server = await buildTeamRouterServerConfig(routerConfig(dir), { manager: { ensure: async () => { throw new Error('x') }, launchGrant: async () => '', stop: async () => {} },
      isActive: async () => true, readKey: async () => publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    expect(server.developmentSelector).toBeUndefined()
    expect(server.host).toBeUndefined()
    expect(server.secureCookies).toBe(true)
    expect(server.listen).toEqual({ kind: 'unix', path: join(dir, 'router.sock'), gid: process.getgid!() })
  })
})

describe('strict production configuration files', () => {
  const dir = '/etc/dsh-public'
  const router = { publicAuthority: 'harness.example.test', routerSocket: `${dir}/r.sock`, routerSocketGid: 990, healthSocket: `${dir}/h.sock`,
    provisionerSocket: `${dir}/p.sock`, identity: { issuer: 'https://login.example.test/', audience: 'public-harness', publicKeyFiles: { current: `${dir}/a.pem` } },
    routeWaitMs: 90000, retryAfterSeconds: 2, launchExchangeMs: 10000, socketLifetimeMs: 60000, maxRequestBodyBytes: 33554432, maxHeaderBytes: 16384 }

  it('accepts the complete router file and rejects unknown, missing, or unsafe values', () => {
    expect(parseTeamRouterConfig(router).publicAuthority).toBe('harness.example.test')
    expect(() => parseTeamRouterConfig({ ...router, devMode: true })).toThrow(/exactly/)
    const { identity: _identity, ...withoutIdentity } = router
    expect(() => parseTeamRouterConfig(withoutIdentity)).toThrow(/exactly/)
    expect(() => parseTeamRouterConfig({ ...router, socketLifetimeMs: 61_000 })).toThrow(/at most/)
    expect(() => parseTeamRouterConfig({ ...router, routerSocket: 'router.sock' })).toThrow(/absolute/)
    expect(() => parseTeamRouterConfig({ ...router, identity: { ...router.identity, issuer: 'http://login.example.test/' } })).toThrow(/HTTPS/)
    expect(() => parseTeamRouterConfig({ ...router, identity: { ...router.identity, publicKeyFiles: {} } })).toThrow()
    expect(() => parseTeamRouterConfig({ ...router, publicAuthority: 'a b' })).toThrow(/publicAuthority/)
    expect(() => parseTeamRouterConfig({ ...router, publicAuthority: 'harness.example.com:443' })).toThrow(/default port/)
    expect(parseTeamRouterConfig({ ...router, publicAuthority: 'staging.example.com:8443' }).publicAuthority).toBe('staging.example.com:8443')
  })

  it('rejects incomplete quota and provisioner profiles before anything starts', () => {
    expect(() => parseQuotaProfileConfig({ controlSocket: `${dir}/q.sock`, service: {} })).toThrow()
    expect(() => parseProvisionerProfileConfig({ controlSocket: `${dir}/p.sock` })).toThrow(/exactly/)
  })

  it.skipIf(process.platform === 'win32')('refuses writable, linked, or relative configuration files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-cfg-'))
    const file = join(base, 'c.json')
    await writeFile(file, '{"a":1}', { mode: 0o600 })
    expect(await readConfigFile(file)).toEqual({ a: 1 })
    await chmod(file, 0o666)
    await expect(readConfigFile(file)).rejects.toThrow(/writable/)
    await expect(readConfigFile('c.json')).rejects.toThrow(/absolute/)
    await chmod(file, 0o600)
    await writeFile(file, '{oops', { mode: 0o600 })
    await expect(readConfigFile(file)).rejects.toThrow(/valid JSON/)
  })
})

it('exports the built production container provider used by the generated profile', async () => {
  const provider = await import('@public-harness/production/container-runtime')
  expect(provider.name).toBe('public-harness-container-runtime')
  expect(typeof provider.apply).toBe('function')
})
