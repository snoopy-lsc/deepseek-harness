import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { writeTeamDevProfile } from '../../../deploy/profile.ts'

describe('team-dev dsh profile', () => {
  it('starts the local selector and routes two real Web users', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-team-dev-'))
    const settings = {
      users: ['alice', 'bob'], startupTimeoutMs: 90_000, stopTimeoutMs: 15_000,
      routeWaitMs: 90_000, retryAfterSeconds: 2, launchExchangeMs: 10_000,
      socketLifetimeMs: 60_000, cookieLifetimeMs: 60_000,
      storageLock: { staleMs: 120_000, updateMs: 10_000 },
      quota: { modelId: 'team-dev-mock', contextWindow: 4096, maxTokens: 1024,
        personalDailyTokens: 100_000, siteDailyTokens: 200_000,
        personalConcurrency: 2, siteConcurrency: 8, busyTimeoutMs: 5000,
        maxBodyBytes: 1_048_576, maxImagesPerRequest: 4, maxInlineImageBytes: 262_144,
        maxEventBytes: 65_536, maxFileBodyBytes: 1_048_576,
        credentialLifetimeMs: 600_000, credentialRotateMs: 480_000 },
    }
    const profile = await writeTeamDevProfile(home, settings)
    const child = spawn(process.execPath, [profile.cli, '--profile', 'team-dev'], {
      env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`team-dev startup timed out: ${stderr}`)), 30_000)
        let output = ''
        child.stdout?.on('data', chunk => {
          output += String(chunk)
          const match = /team-dev: http:\/\/127\.0\.0\.1:(\d+)\/dev/.exec(output)
          if (match) { clearTimeout(timer); resolve(Number(match[1])) }
        })
        child.once('close', () => { clearTimeout(timer); reject(new Error(`team-dev exited: ${stderr}`)) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
      })
      const base = `http://127.0.0.1:${port}`
      const selector = await fetch(`${base}/dev`)
      expect(selector.status).toBe(200)
      expect(await selector.text()).toContain('/dev/select/alice')
      expect(await writeTeamDevProfile(home, settings)).toEqual(profile)
      let aliceToken = ''
      for (const userId of ['alice', 'bob']) {
        const selected = await fetch(`${base}/dev/select/${userId}`, { redirect: 'manual' })
        expect(selected.status).toBe(303)
        const cookie = selected.headers.get('set-cookie')?.split(';')[0]
        expect(cookie).toBeTruthy()
        const first = await fetch(`${base}/u/${userId}/`, { headers: { cookie: cookie! }, redirect: 'manual' })
        expect(first.status).toBe(303)
        const harness = first.headers.get('set-cookie')?.split(';')[0]
        const page = await fetch(`${base}/u/${userId}/`, { headers: { cookie: `${cookie}; ${harness}` } })
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('<base href="./">')
        const providers = await fetch(`${base}/u/${userId}/api/llm/listProviders`, {
          method: 'POST', headers: { cookie: `${cookie}; ${harness}`, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
            method: 'llm/listProviders', payload: { args: {} } }),
        })
        expect(providers.status).toBe(200)
        expect(JSON.stringify(await providers.json())).toContain('platform')
        const cookieHeader = `${cookie}; ${harness}`
        const rpc = async (method: string, args: object) => {
          const response = await fetch(`${base}/u/${userId}/api/${method}`, {
            method: 'POST', headers: { cookie: cookieHeader, 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
          })
          expect(response.status).toBe(200)
          return await response.json() as { result: { ok: boolean; value?: unknown; error?: unknown } }
        }
        const sessionId = randomUUID()
        const cwd = join(home, 'users', 'users', userId, 'workspace')
        expect((await rpc('session/create', { request: { sessionId, cwd } })).result.ok).toBe(true)
        const id = randomUUID()
        expect((await rpc('terminal/create', { agentId: sessionId, request: { id, cols: 80, rows: 24 } })).result)
          .toMatchObject({ ok: true, value: { state: 'running', cwd } })
        const socket = new WebSocket(`ws://127.0.0.1:${port}/u/${userId}/api/remote.mux`, {
          headers: { cookie: cookieHeader },
        })
        const attachmentId = randomUUID()
        const frames: Array<{ type: string; value?: { type?: string; data?: string }; error?: object }> = []
        socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())) })
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve)
            socket.once('error', reject)
          })
          socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint: 'terminal/follow',
            payload: { args: { agentId: sessionId, id, attachmentId } } }))
          await expect.poll(() => frames.map(frame => frame.value?.type ?? frame.error), { timeout: 10_000 }).toContain('snapshot')
          expect((await rpc('terminal/write', { agentId: sessionId, id, attachmentId,
            data: `node -e "console.log('team'+'-exec-success')"\r` })).result.ok).toBe(true)
          await expect.poll(() => frames.map(frame => frame.value?.data ?? '').join(''), { timeout: 10_000 })
            .toContain('team-exec-success')
        } finally { socket.terminate() }
        const userHome = join(home, 'users', 'users', userId, 'home')
        const patch = JSON.parse(await readFile(join(userHome, 'team-dev-web.patch.yml'), 'utf8')) as
          Array<{ insert?: Array<{ config?: { proxyBaseUrl?: string } }> }>
        const proxyBaseUrl = patch.at(-1)?.insert?.[0]?.config?.proxyBaseUrl
        const credential = JSON.parse(await readFile(join(userHome, 'quota-credential.json'), 'utf8')) as { token: string }
        if (userId === 'alice') aliceToken = credential.token
        else {
          const stolen = await fetch(`${proxyBaseUrl}/messages`, { method: 'POST', headers: {
            authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json',
          }, body: JSON.stringify({ model: 'team-dev-mock', max_tokens: 5,
            messages: [{ role: 'user', content: 'hello' }], stream: true }) })
          expect(stolen.status).toBe(401)
        }
        const model = await fetch(`${proxyBaseUrl}/messages`, { method: 'POST', headers: {
          authorization: `Bearer ${credential.token}`, 'content-type': 'application/json',
        }, body: JSON.stringify({ model: 'team-dev-mock', max_tokens: 5,
          messages: [{ role: 'user', content: 'hello' }], stream: true }) })
        expect(model.status).toBe(200)
        expect(await model.text()).toContain('Local mock model response.')
        const other = userId === 'alice' ? 'bob' : 'alice'
        expect((await fetch(`${base}/u/${other}/`, { headers: { cookie: `${cookie}; ${harness}` } })).status).toBe(404)
      }
    } finally {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 20_000)
      try { await closed } finally { clearTimeout(force) }
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
