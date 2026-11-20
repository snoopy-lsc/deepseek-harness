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

  it.each([
    ['another loopback host', 'http://127.0.0.2:4123/?token=x'],
    ['a host name', 'http://localhost:4123/?token=x'],
    ['another port', 'http://127.0.0.1:4124/?token=x'],
    ['https', 'https://127.0.0.1:4123/?token=x'],
    ['a sub-path', 'http://127.0.0.1:4123/ui/?token=x'],
    ['an extra query parameter', 'http://127.0.0.1:4123/?token=x&next=/'],
    ['a hash', 'http://127.0.0.1:4123/?token=x#frag'],
    ['a repeated token', 'http://127.0.0.1:4123/?token=x&token=y'],
    ['an empty token', 'http://127.0.0.1:4123/?token='],
  ])('refuses an authenticated URL with %s', (_case, url) => {
    expect(() => createReadyMessage({ authenticatedUrl: () => url }, 4123)).toThrow('invalid authenticated Web URL')
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

    /** Boot over IPC only: process.send is a spy and READY_FILE_ENV is unset. */
    async function bootIpc(port: number | undefined) {
      delete process.env[READY_FILE_ENV]
      const send = process.send
      const sendSpy = vi.fn()
      process.send = sendSpy as typeof process.send
      const authenticatedUrl = vi.fn((base: string) => `${base}/?token=private-token`)
      const ctx = { effect: () => {}, loader: { await: () => Promise.resolve() }, connection: { authenticatedUrl }, webServer: { port } }
      try {
        apply(ctx as unknown as Context)
        await new Promise(resolve => setTimeout(resolve, 10))
      } finally {
        process.send = send
      }
      return { sendSpy, authenticatedUrl }
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

    it.each([undefined, 0])('publishes no IPC startup credential while the Web port is %s', async port => {
      const { sendSpy, authenticatedUrl } = await bootIpc(port)
      expect(sendSpy).not.toHaveBeenCalled()
      expect(authenticatedUrl).not.toHaveBeenCalled()
    })

    it('publishes the credential over IPC once the Web port is bound', async () => {
      const { sendSpy, authenticatedUrl } = await bootIpc(4123)
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy).toHaveBeenCalledWith({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
      expect(authenticatedUrl).toHaveBeenCalledOnce()
    })

    it('publishes the credential from the Web entry URLs when Connection has no authenticatedUrl', async () => {
      delete process.env[READY_FILE_ENV]
      const send = process.send
      const sendSpy = vi.fn()
      process.send = sendSpy as typeof process.send
      const emit = vi.fn((_this: unknown, name: string, base: string, entries: { label: string; url: string; open?: boolean }[]) => {
        if (name === 'webserver/entry-url') entries.push({ label: 'dsh web', url: `${base}/?token=private-token`, open: true })
      })
      const ctx = { effect: () => {}, loader: { await: () => Promise.resolve() }, connection: {}, webServer: { port: 4123 }, emit }
      try {
        apply(ctx as unknown as Context)
        await new Promise(resolve => setTimeout(resolve, 10))
      } finally {
        process.send = send
      }
      expect(emit).toHaveBeenCalledWith(ctx.webServer, 'webserver/entry-url', 'http://127.0.0.1:4123', expect.any(Array))
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy).toHaveBeenCalledWith({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    })

    it('publishes no credential when no Web entry URL opens the app', async () => {
      delete process.env[READY_FILE_ENV]
      const send = process.send
      const sendSpy = vi.fn()
      process.send = sendSpy as typeof process.send
      const ctx = { effect: () => {}, loader: { await: () => Promise.resolve() }, connection: {}, webServer: { port: 4123 }, emit: vi.fn() }
      try {
        apply(ctx as unknown as Context)
        await new Promise(resolve => setTimeout(resolve, 10))
      } finally {
        process.send = send
      }
      expect(sendSpy).not.toHaveBeenCalled()
    })

    /** An entry URL contributed to `webserver/entry-url`. */
    type Entry = { label: string; url: string; open?: boolean }

    /** Boot against a Context without `connection.authenticatedUrl` whose auth contributes `entries(base)`; IPC unless `readyFile`. */
    async function bootEntries(entries: (base: string) => Entry[], readyFile?: string) {
      const send = process.send
      const sendSpy = vi.fn()
      if (readyFile === undefined) {
        delete process.env[READY_FILE_ENV]
        process.send = sendSpy as typeof process.send
      } else {
        vi.stubEnv(READY_FILE_ENV, readyFile)
        process.send = undefined
      }
      const emit = vi.fn((_this: unknown, name: string, base: string, list: Entry[]) => {
        if (name === 'webserver/entry-url') list.push(...entries(base))
      })
      const ctx = { effect: () => {}, loader: { await: () => Promise.resolve() }, connection: {}, webServer: { port: 4123 }, emit }
      try {
        apply(ctx as unknown as Context)
        await new Promise(resolve => setTimeout(resolve, 10))
      } finally {
        process.send = send
      }
      return sendSpy
    }

    it('skips Web entry URLs that do not open the app', async () => {
      const sendSpy = await bootEntries(base => [
        { label: 'docs', url: `${base}/?token=not-open`, open: false },
        { label: 'dsh web', url: `${base}/?token=private-token`, open: true },
      ])
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy).toHaveBeenCalledWith({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    })

    it.each([[false], [undefined]])('publishes no credential when the only Web entry URL has open %s', async open => {
      const sendSpy = await bootEntries(base => [{ label: 'dsh web', url: `${base}/?token=private-token`, open }])
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('uses the first Web entry URL that opens the app', async () => {
      const sendSpy = await bootEntries(base => [
        { label: 'dsh web', url: `${base}/?token=first`, open: true },
        { label: 'other', url: `${base}/?token=second`, open: true },
      ])
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy).toHaveBeenCalledWith({ kind: 'public-harness/web-ready', port: 4123, token: 'first' })
    })

    it('publishes no credential when the opening Web entry URL leaves the loopback app', async () => {
      const sendSpy = await bootEntries(base => [
        { label: 'tunnel', url: 'https://share.example/?token=private-token', open: true },
        { label: 'dsh web', url: `${base}/?token=private-token`, open: true },
      ])
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32')('publishes the Web entry URL credential to the readiness file without IPC', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-ready-'))
      dirs.push(dir)
      const path = join(dir, 'ready.json')
      const sendSpy = await bootEntries(base => [{ label: 'dsh web', url: `${base}/?token=private-token`, open: true }], path)
      expect(sendSpy).not.toHaveBeenCalled()
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ kind: 'public-harness/web-ready', port: 4123, token: 'private-token' })
    })
  })
})
