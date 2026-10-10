import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createDevInstanceManager } from '../src/index.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const tokenPlugin = pathToFileURL(join(repoRoot, 'integrations/public-harness/packages/web-token/lib/index.js')).href

describe('real development Web profiles', () => {
  it('keeps separate Web cookies and a saved Session after restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-dev-real-web-'))
    const webPatch = join(storageRoot, 'web.patch.yml')
    await writeFile(webPatch, `${JSON.stringify([
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, publicUrl: null, surfaceContext: true, trustedHosts: [] } },
      { insert: [{ id: 'public-harness-web-token', name: tokenPlugin }] },
    ])}\n`)
    const manager = createDevInstanceManager({
      mode: 'development', host: '127.0.0.1', storageRoot,
      users: [parseUserId('alice'), parseUserId('bob')],
      command: process.execPath,
      args: [join(repoRoot, 'apps/cli/lib/bin.js')],
      webPatch, startupTimeoutMs: 90_000, stopTimeoutMs: 15_000,
    })
    try {
      const alice = await manager.ensure(parseUserId('alice'))
      const bob = await manager.ensure(parseUserId('bob'))
      if (alice.kind !== 'tcp' || bob.kind !== 'tcp') throw new Error('development endpoint must be TCP')
      const aliceUrl = `http://127.0.0.1:${alice.port}/`
      const bobUrl = `http://127.0.0.1:${bob.port}/`
      const aliceLogin = await fetch(`${aliceUrl}?token=${encodeURIComponent(await manager.launchGrant(parseUserId('alice')))}`, { redirect: 'manual' })
      const bobLogin = await fetch(`${bobUrl}?token=${encodeURIComponent(await manager.launchGrant(parseUserId('bob')))}`, { redirect: 'manual' })
      expect(aliceLogin.status).toBe(303)
      expect(bobLogin.status).toBe(303)
      const aliceCookie = aliceLogin.headers.get('set-cookie')?.split(';')[0]
      const bobCookie = bobLogin.headers.get('set-cookie')?.split(';')[0]
      expect(aliceCookie).toBeTruthy()
      expect(bobCookie).toBeTruthy()
      expect((await fetch(aliceUrl, { headers: { cookie: aliceCookie! } })).status).toBe(200)
      expect((await fetch(bobUrl, { headers: { cookie: bobCookie! } })).status).toBe(200)
      expect((await fetch(bobUrl, { headers: { cookie: aliceCookie! } })).status).toBe(401)
      const rpc = async (url: string, cookie: string, method: string, args: object): Promise<{ result: { ok: boolean; value?: unknown; error?: unknown } }> => {
        const response = await fetch(`${url}api/${method}`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
        })
        expect(response.status).toBe(200)
        return await response.json() as { result: { ok: boolean; value?: unknown; error?: unknown } }
      }
      const sessionId = randomUUID()
      const created = await rpc(aliceUrl, aliceCookie!, 'session/create', {
        request: { sessionId, cwd: join(storageRoot, 'users', 'alice', 'workspace') },
      })
      expect(created.result).toMatchObject({ ok: true, value: { sessionId } })
      const shells = await rpc(aliceUrl, aliceCookie!, 'terminal/shells', { agentId: sessionId })
      if (!shells.result.ok) throw new Error(JSON.stringify(shells.result.error))
      expect(shells.result).toMatchObject({ ok: true })
      expect(Array.isArray(shells.result.value)).toBe(true)
      expect((shells.result.value as unknown[]).length).toBeGreaterThan(0)
      const terminal = await rpc(aliceUrl, aliceCookie!, 'terminal/create', {
        agentId: sessionId, request: { id: randomUUID(), cols: 80, rows: 24 },
      })
      expect(terminal.result).toMatchObject({ ok: true, value: {
        state: 'running', cwd: join(storageRoot, 'users', 'alice', 'workspace'),
      } })
      const bobSessions = await rpc(bobUrl, bobCookie!, 'session/list', { _request: {} })
      expect(bobSessions.result.ok).toBe(true)
      expect(JSON.stringify(bobSessions.result.value)).not.toContain(sessionId)
      await manager.stop(parseUserId('alice'))
      const restarted = await manager.ensure(parseUserId('alice'))
      if (restarted.kind !== 'tcp') throw new Error('development endpoint must be TCP')
      const restartedUrl = `http://127.0.0.1:${restarted.port}/`
      const relogin = await fetch(`${restartedUrl}?token=${encodeURIComponent(await manager.launchGrant(parseUserId('alice')))}`, { redirect: 'manual' })
      const restartedCookie = relogin.headers.get('set-cookie')?.split(';')[0]
      expect(restartedCookie).toBeTruthy()
      const retained = await rpc(restartedUrl, restartedCookie!, 'session/list', { _request: {} })
      expect(retained.result.ok).toBe(true)
      expect(JSON.stringify(retained.result.value)).toContain(sessionId)
    } finally {
      await manager.close()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
})
