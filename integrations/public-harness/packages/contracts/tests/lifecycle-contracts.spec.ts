import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountSuspendedError, CapacityError, createActivityTracker, ensureGitWorkspace, fromWireError,
  isolatedGitEnvironment, parseUserId, startIdleReaper, toWireError, validateIdleMs } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('typed wire errors', () => {
  it('round trips only the fixed refusals and hides everything else', () => {
    expect(toWireError(new CapacityError())).toBe('capacity')
    expect(toWireError(new AccountSuspendedError())).toBe('suspended')
    expect(toWireError(new Error('/home/secret/path failed'))).toBe('request failed')
    expect(fromWireError('capacity')).toBeInstanceOf(CapacityError)
    expect(fromWireError('suspended')).toBeInstanceOf(AccountSuspendedError)
    expect(fromWireError('request failed').message).toBe('request failed')
  })
})

describe('private Git workspace', () => {
  it('creates a real repository with one initial commit and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-'))
    dirs.push(dir)
    await ensureGitWorkspace(dir)
    await ensureGitWorkspace(dir)
    const env = isolatedGitEnvironment()
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, env }).toString().trim()).toBe('1')
    expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, env }).toString().trim()).toBe('main')
    expect(execFileSync('git', ['config', '--local', 'user.email'], { cwd: dir, env }).toString().trim()).toBe('user@harness.invalid')
    await writeFile(join(dir, 'a.txt'), 'x')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, env })
    execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: dir, env })
    await ensureGitWorkspace(dir)
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, env }).toString().trim()).toBe('2')
  })

  it('refuses a .git that is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-'))
    dirs.push(dir)
    await writeFile(join(dir, '.git'), 'gitdir: /etc')
    await expect(ensureGitWorkspace(dir)).rejects.toThrow(/real directory/)
    await mkdir(join(dir, 'nested'))
  })

  it('does not read host Git configuration', () => {
    const env = isolatedGitEnvironment()
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_GLOBAL).toMatch(/null|NUL/i)
  })
})

describe('idle tracking', () => {
  it('selects only running users that were quiet for the whole timeout', () => {
    let now = 1_000_000
    const tracker = createActivityTracker(() => now)
    const alice = parseUserId('alice'), bob = parseUserId('bob'), carol = parseUserId('carol')
    tracker.touch(alice); now += 100_000; tracker.touch(bob); now += 30_000
    expect(tracker.idle([alice, bob, carol], 120_000)).toEqual([alice, carol])
    tracker.forget(alice)
    expect(tracker.lastSeen(alice)).toBeUndefined()
  })

  it('rejects idle timeouts shorter than a WebSocket lifetime', () => {
    expect(() => validateIdleMs(60_000)).toThrow(/at least/)
    expect(() => validateIdleMs(120_000)).not.toThrow()
  })

  it('reaper stops idle users, reports failures, and keeps going', async () => {
    vi.useFakeTimers()
    let now = 0
    const tracker = createActivityTracker(() => now)
    const a = parseUserId('a'), b = parseUserId('b')
    const stopped: string[] = []
    const errors: unknown[] = []
    const dispose = startIdleReaper({ tracker, running: () => [a, b], idleMs: 120_000, intervalMs: 10_000,
      stop: async userId => { if (userId === a) throw new Error('boom'); stopped.push(userId) },
      onError: error => errors.push(error) })
    now = 200_000
    await vi.advanceTimersByTimeAsync(10_000)
    dispose()
    expect(stopped).toEqual(['b'])
    expect(errors).toHaveLength(1)
  })
})
