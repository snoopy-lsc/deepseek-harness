import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTeamDevProfile } from '../../../deploy/profile.ts'

describe('team-dev dsh profile', () => {
  it('starts the local selector and routes two real Web users', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-team-dev-'))
    const profile = await writeTeamDevProfile(home, {
      users: ['alice', 'bob'], startupTimeoutMs: 90_000, stopTimeoutMs: 15_000,
      routeWaitMs: 90_000, launchExchangeMs: 10_000,
      socketLifetimeMs: 60_000, cookieLifetimeMs: 60_000,
    })
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
        const other = userId === 'alice' ? 'bob' : 'alice'
        expect((await fetch(`${base}/u/${other}/`, { headers: { cookie: `${cookie}; ${harness}` } })).status).toBe(404)
      }
    } finally {
      child.kill('SIGTERM')
      await closed
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
