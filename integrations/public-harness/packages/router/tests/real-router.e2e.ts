import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createDevInstanceManager } from '../../dev-runtime/src/index.ts'
import { createDevelopmentIdentity } from '../src/dev-identity.ts'
import { createOwnerRouter } from '../src/routes.ts'
import { createBrowserLaunch } from '../src/launch.ts'
import { startRouterServer } from '../src/server.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const tokenPlugin = pathToFileURL(join(repoRoot, 'integrations/public-harness/packages/web-token/lib/index.js')).href

function upgrade(port: number, path: string, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setTimeout(10_000, () => socket.destroy(new Error('upgrade timed out')))
    socket.once('error', reject)
    socket.once('connect', () => socket.write([
      `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade',
      'Upgrade: websocket', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13', `Cookie: ${cookie}`, '', '',
    ].join('\r\n')))
    socket.on('data', bytes => {
      response += bytes.toString()
      if (response.includes('\r\n\r\n')) { resolve(response); socket.destroy() }
    })
  })
}

describe('two real Harness Web processes behind one local router', () => {
  it('keeps browser, Session, and upgrade paths with their signed-in user', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-real-router-'))
    const webPatch = join(storageRoot, 'web.patch.yml')
    await writeFile(webPatch, `${JSON.stringify([
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, publicUrl: null, surfaceContext: true, trustedHosts: [] } },
      { insert: [{ id: 'public-harness-web-token', name: tokenPlugin }] },
    ])}\n`)
    const alice = parseUserId('alice')
    const bob = parseUserId('bob')
    const manager = createDevInstanceManager({ mode: 'development', host: '127.0.0.1', storageRoot,
      users: [alice, bob], command: process.execPath, args: [join(repoRoot, 'apps/cli/lib/bin.js')],
      webPatch, startupTimeoutMs: 90_000, stopTimeoutMs: 15_000 })
    const identity = createDevelopmentIdentity({ mode: 'team-dev', host: '127.0.0.1',
      secret: randomBytes(32), testUsers: [alice, bob], lifetimeMs: 60_000 })
    const entry = await startRouterServer({ host: '127.0.0.1', maxSocketLifetimeMs: 60_000, identity,
      ownerRouter: createOwnerRouter({ instanceManager: manager, isActive: async () => true,
        hasCapacity: async () => true, maxWaitMs: 90_000 }),
      launch: createBrowserLaunch({ instanceManager: manager, maxExchangeMs: 10_000 }) })
    try {
      const base = `http://127.0.0.1:${entry.port}`
      const login = async (userId: string): Promise<string> => {
        const dev = identity.issue(userId)
        const response = await fetch(`${base}/u/${userId}/`, { headers: { cookie: dev }, redirect: 'manual' })
        expect(response.status).toBe(303)
        expect(response.headers.get('location')).toBe(`/u/${userId}/`)
        const harness = response.headers.get('set-cookie')?.split(';')[0]
        expect(harness).toBeTruthy()
        const page = await fetch(`${base}/u/${userId}/`, { headers: { cookie: `${dev}; ${harness}` } })
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('<base href="./">')
        return `${dev}; ${harness}`
      }
      const aliceCookie = await login('alice')
      const bobCookie = await login('bob')
      expect((await fetch(`${base}/u/bob/`, { headers: { cookie: aliceCookie } })).status).toBe(404)
      expect(await upgrade(entry.port, '/u/alice/api/remote.mux', aliceCookie)).toMatch(/^HTTP\/1.1 101/)
      expect(await upgrade(entry.port, '/u/bob/api/remote.mux', aliceCookie)).toMatch(/^HTTP\/1.1 404/)
      const rpc = async (userId: string, cookie: string, method: string, args: object) => {
        const response = await fetch(`${base}/u/${userId}/api/${method}`, { method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
        expect(response.status).toBe(200)
        return await response.json() as { result: { ok: boolean; value?: unknown } }
      }
      const sessionId = randomUUID()
      expect((await rpc('alice', aliceCookie, 'session/create', { request: {
        sessionId, cwd: join(storageRoot, 'users', 'alice', 'workspace'),
      } })).result).toMatchObject({ ok: true, value: { sessionId } })
      expect(JSON.stringify((await rpc('bob', bobCookie, 'session/list', { _request: {} })).result.value)).not.toContain(sessionId)
      expect((await fetch(`${base}/u/alice/api/session.list`, { headers: { cookie: bobCookie } })).status).toBe(404)
    } finally {
      await entry.close()
      await manager.close()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
