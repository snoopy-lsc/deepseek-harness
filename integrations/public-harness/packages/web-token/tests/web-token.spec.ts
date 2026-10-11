import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadyMessage, writeReadyFile } from '../src/index.ts'

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
})
