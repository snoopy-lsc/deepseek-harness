import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, createActivityTracker, parseUserId } from '@public-harness/contracts'
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
  it.each([['Alice', 'alice'], ['CON'], ['aux'], ['LPT1']])('rejects nonportable user paths %s', async (...users) => {
    const settings = await config()
    expect(() => createDevInstanceManager({ ...settings, users: users.map(parseUserId) })).toThrow('user')
  })
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

  it('gives each user a real private Git workspace that survives restarts', async () => {
    const manager = createDevInstanceManager(await config())
    const alice = parseUserId('alice')
    try {
      await manager.ensure(alice)
      const workspace = join(manager.storageRoot, 'users', 'alice', 'workspace')
      const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
      expect(git('rev-parse', '--is-inside-work-tree')).toBe('true')
      expect(git('log', '--format=%s')).toBe('Initialize private workspace')
      await manager.stop(alice)
      await manager.ensure(alice)
      expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    } finally { await manager.close() }
  })

  it('admits at most the configured number of active users and frees a slot on stop', async () => {
    const manager = createDevInstanceManager({ ...(await config()), maxActive: 1 })
    const [alice, bob] = [parseUserId('alice'), parseUserId('bob')]
    try {
      const results = await Promise.allSettled([manager.ensure(alice), manager.ensure(bob)])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(CapacityError)
      expect(manager.active()).toEqual([alice])
      await manager.ensure(alice)
      await manager.stop(alice)
      await manager.ensure(bob)
      expect(manager.active()).toEqual([bob])
    } finally { await manager.close() }
  })

  it('suspends and reactivates accounts and rejects non-positive caps', async () => {
    const base = await config()
    expect(() => createDevInstanceManager({ ...base, maxActive: 0 })).toThrow(/cap/)
    const manager = createDevInstanceManager(base)
    const alice = parseUserId('alice')
    try {
      await manager.ensure(alice)
      await manager.suspend(alice)
      expect(manager.active()).toEqual([])
      expect(manager.isActive(alice)).toBe(false)
      expect(manager.isActive(parseUserId('charlie'))).toBe(false)
      await expect(manager.ensure(alice)).rejects.toBeInstanceOf(AccountSuspendedError)
      manager.reactivate(alice)
      expect(manager.isActive(alice)).toBe(true)
      await manager.ensure(alice)
    } finally { await manager.close() }
  })

  it('stops only the instances that were idle and wakes them on the next request', async () => {
    let now = 1_000_000
    const manager = createDevInstanceManager(await config(), createActivityTracker(() => now))
    const [alice, bob] = [parseUserId('alice'), parseUserId('bob')]
    try {
      await manager.ensure(alice)
      now += 200_000
      await manager.ensure(bob)
      now += 50_000
      expect(await manager.stopIdle(120_000)).toEqual([alice])
      expect(manager.active()).toEqual([bob])
      await manager.ensure(alice)
      expect(manager.active().sort()).toEqual([alice, bob])
    } finally { await manager.close() }
  })

  it('resolves a per-user Web patch', async () => {
    const base = await config()
    const seen: string[] = []
    const manager = createDevInstanceManager({ ...base, webPatch: userId => { seen.push(userId); return join(base.storageRoot, `${userId}.patch.yml`) } })
    try { await manager.ensure(parseUserId('bob')); expect(seen).toEqual(['bob']) } finally { await manager.close() }
  })
})
