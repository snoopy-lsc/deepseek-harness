import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createDevInstanceManager } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/web-child.mjs', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function config() {
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-dev-runtime-'))
  roots.push(storageRoot)
  return {
    mode: 'development' as const,
    host: '127.0.0.1' as const,
    storageRoot,
    users: [parseUserId('alice'), parseUserId('bob')],
    command: process.execPath,
    args: [fixture],
    webPatch: join(storageRoot, 'web.patch.yml'),
    startupTimeoutMs: 10_000,
    stopTimeoutMs: 10_000,
  }
}

describe('development instance manager', () => {
  it('starts two loopback children with separate homes and workspaces', async () => {
    const manager = createDevInstanceManager(await config())
    try {
      const [alice, bob] = await Promise.all([manager.ensure(parseUserId('alice')), manager.ensure(parseUserId('bob'))])
      expect(alice.kind).toBe('tcp')
      expect(bob.kind).toBe('tcp')
      expect(alice).not.toEqual(bob)
      if (alice.kind !== 'tcp' || bob.kind !== 'tcp') throw new Error('development endpoint must be TCP')
      const aliceHome = join(manager.storageRoot, 'users', 'alice', 'home')
      const bobHome = join(manager.storageRoot, 'users', 'bob', 'home')
      expect(await readFile(join(aliceHome, 'started'), 'utf8')).toBe(await realpath(join(manager.storageRoot, 'users', 'alice', 'workspace')))
      expect(await readFile(join(bobHome, 'started'), 'utf8')).toBe(await realpath(join(manager.storageRoot, 'users', 'bob', 'workspace')))
      expect(JSON.parse(await readFile(join(aliceHome, 'system-home'), 'utf8'))).toEqual({ HOME: aliceHome, USERPROFILE: aliceHome })
      expect(JSON.parse(await readFile(join(bobHome, 'system-home'), 'utf8'))).toEqual({ HOME: bobHome, USERPROFILE: bobHome })
      expect(await fetch(`http://127.0.0.1:${alice.port}/`).then(r => r.text())).toBe(aliceHome)
      expect(await fetch(`http://127.0.0.1:${bob.port}/`).then(r => r.text())).toBe(bobHome)
    } finally {
      await manager.close()
    }
  })

  it('keeps a launch grant private and preserves data across a restart', async () => {
    const manager = createDevInstanceManager(await config())
    const alice = parseUserId('alice')
    try {
      await manager.ensure(alice)
      expect(await manager.launchGrant(alice)).toBe('fixture-private-grant')
      const home = join(manager.storageRoot, 'users', 'alice', 'home')
      await writeFile(join(home, 'session-marker'), 'saved')
      await manager.stop(alice)
      await manager.ensure(alice)
      expect(await readFile(join(home, 'session-marker'), 'utf8')).toBe('saved')
    } finally {
      await manager.close()
    }
  })

  it('rejects public binds, unknown users, and production mode before starting a child', async () => {
    const base = await config()
    expect(() => createDevInstanceManager({ ...base, host: '0.0.0.0' })).toThrow(/loopback/i)
    expect(() => createDevInstanceManager({ ...base, mode: 'production' })).toThrow(/development/i)
    const manager = createDevInstanceManager(base)
    try {
      await expect(manager.ensure(parseUserId('charlie'))).rejects.toThrow(/test user/i)
    } finally {
      await manager.close()
    }
  })
})
