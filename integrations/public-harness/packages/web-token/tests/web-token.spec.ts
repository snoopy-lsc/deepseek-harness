import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READY_FILE_ENV, apply, createReadyMessage, writeReadyFile } from '../src/index.ts'

describe('Web launch-token publisher', () => {
  it('sends only the token and bound port through IPC', () => {
    const message = createReadyMessage({
      authenticatedUrl: base => `${base}/?token=private-token`,
    }, 4123)
    expect(message).toEqual({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    expect(JSON.stringify(message)).not.toContain('http://')
  })

  it('refuses a malformed authenticated URL', () => {
    expect(() => createReadyMessage({ authenticatedUrl: () => 'https://other.example/?token=x' }, 4123)).toThrow()
  })

  it.skipIf(process.platform === 'win32')('publishes readiness to a private 0600 file when no IPC channel exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ready-'))
    const path = join(dir, 'ready.json')
    writeReadyFile(path, { kind: 'public-harness/web-ready', port: 8080, token: 'private-token' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ kind: 'public-harness/web-ready', port: 8080, token: 'private-token' })
    expect(() => writeReadyFile('relative.json', { kind: 'public-harness/web-ready', port: 8080, token: 'x' })).toThrow(/absolute/)
  })

  it.each([undefined, 0])('refuses an unbound Web port (%s) as invalid', port => {
    expect(() => createReadyMessage({ authenticatedUrl: base => `${base}/?token=x` }, port as number)).toThrow('invalid Web port')
  })

  describe('apply', () => {
    const dirs: string[] = []
    afterEach(async () => {
      vi.unstubAllEnvs()
      await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
    })

    /** Boot the publisher against a fake Context whose webServer reports `port`, with only a readiness file channel. */
    async function boot(port: number | undefined) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-ready-'))
      dirs.push(dir)
      const path = join(dir, 'ready.json')
      vi.stubEnv(READY_FILE_ENV, path)
      const send = process.send
      process.send = undefined
      const authenticatedUrl = vi.fn((base: string) => `${base}/?token=private-token`)
      const ctx = { effect: () => {}, loader: { await: () => Promise.resolve() }, connection: { authenticatedUrl }, webServer: { port } }
      try {
        apply(ctx as unknown as Context)
        await new Promise(resolve => setTimeout(resolve, 10))
      } finally {
        process.send = send
      }
      return { path, authenticatedUrl }
    }

    it.skipIf(process.platform === 'win32').each([undefined, 0])('publishes no startup credential while the Web port is %s', async port => {
      const { path, authenticatedUrl } = await boot(port)
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(authenticatedUrl).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32')('publishes the credential once the Web port is bound', async () => {
      const { path } = await boot(4123)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    })
  })
})
