/** 1D.4: agent idle gate + jittered poll loop (P0.7). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplyDeps, PluginManagerLike, SyncPlan, SyncPlanEntry } from '../src/apply.ts'
import { applySyncEntry } from '../src/apply.ts'
import { appendOp, readOps } from '../src/oplog.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetModules()
})

function fixture(): { home: string; profileDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-idle-'))
  roots.push(home)
  const profileDir = join(home, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh', dependencies: {} }, null, 2)}\n`,
  )
  return { home, profileDir }
}

const SHA_OK = 'ab'.repeat(64)

function installEntry(over: Partial<SyncPlanEntry> = {}): SyncPlanEntry {
  return {
    name: '@corp-dsh/demo',
    version: '1.2.0',
    fromVersion: null,
    sha512: SHA_OK,
    action: 'install',
    allowedBuilds: [],
    ...over,
  }
}

describe('isAgentIdle', () => {
  it('is_true_when_all_agents_idle_or_none', async () => {
    const { isAgentIdle } = await import('../src/idle.ts')
    expect(isAgentIdle({})).toBe(true)
    expect(isAgentIdle({ agents: { list: () => [] } })).toBe(true)
    expect(isAgentIdle({
      agents: { list: () => [{ status: 'idle' }, { status: 'idle' }] },
    })).toBe(true)
  })

  it('is_false_when_any_agent_running', async () => {
    const { isAgentIdle } = await import('../src/idle.ts')
    expect(isAgentIdle({
      agents: { list: () => [{ status: 'idle' }, { status: 'running' }] },
    })).toBe(false)
    expect(isAgentIdle({
      agents: { list: () => [{ status: 'running' }] },
    })).toBe(false)
  })

  it('does_not_consult_idleWatchdog', async () => {
    const { isAgentIdle } = await import('../src/idle.ts')
    // A context that only looks like an LLM idleWatchdog must not affect the gate.
    const ctx = {
      agents: { list: () => [{ status: 'running' as const }] },
      idleWatchdog: { idle: true },
    }
    expect(isAgentIdle(ctx)).toBe(false)
  })
})

describe('nextPollDelayMs', () => {
  it('applies_jitter_around_five_minute_base', async () => {
    const { nextPollDelayMs, DEFAULT_POLL_INTERVAL_MS } = await import('../src/idle.ts')
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5 * 60 * 1000)
    const low = nextPollDelayMs({ random: () => 0 })
    const mid = nextPollDelayMs({ random: () => 0.5 })
    const high = nextPollDelayMs({ random: () => 1 - Number.EPSILON })
    expect(mid).toBe(DEFAULT_POLL_INTERVAL_MS)
    expect(low).toBeLessThan(DEFAULT_POLL_INTERVAL_MS)
    expect(high).toBeGreaterThan(DEFAULT_POLL_INTERVAL_MS)
    // Default ±10%
    expect(low).toBeGreaterThanOrEqual(DEFAULT_POLL_INTERVAL_MS * 0.9 - 1)
    expect(high).toBeLessThanOrEqual(DEFAULT_POLL_INTERVAL_MS * 1.1 + 1)
  })
})

describe('startSyncLoop', () => {
  function mockManager(overrides: Partial<PluginManagerLike> = {}): PluginManagerLike {
    return {
      installBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
      setBundleEnabled: vi.fn(async () => ({ application: 'applied', changed: true })),
      removeBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
      ...overrides,
    }
  }

  function writeLock(profileDir: string, name: string, version: string): void {
    const integrity = `sha512-${Buffer.from(SHA_OK, 'hex').toString('base64')}`
    const key = name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`
    writeFileSync(
      join(profileDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n  ${key}:\n    resolution: {integrity: ${integrity}}\n`,
    )
  }

  it('applies_while_idle_and_skips_mutate_when_not_idle', async () => {
    const { startSyncLoop } = await import('../src/idle.ts')
    const { home, profileDir } = fixture()
    writeLock(profileDir, '@corp-dsh/demo', '1.2.0')
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writeFileSync(
          join(profileDir, 'package.json'),
          `${JSON.stringify({ name: 'dsh', dependencies: { '@corp-dsh/demo': '1.2.0' } }, null, 2)}\n`,
        )
        return { application: 'applied', changed: true }
      }),
    })
    let idle = true
    const fetchPlan = vi.fn(async (): Promise<SyncPlan> => ({ entries: [installEntry()] }))
    const timers: { id: number; ms: number; fn: () => void }[] = []
    let nextId = 1
    const handle = startSyncLoop({
      home,
      profileDir,
      syncUrl: 'http://127.0.0.1:31000/sync',
      registry: 'http://127.0.0.1:31000/npm/',
      manager,
      withFileLock: async (_f, op) => op(),
      fetchPlan,
      isIdle: () => idle,
      clock: {
        now: () => 1000,
        setTimeout: (fn, ms) => {
          const id = nextId++
          timers.push({ id, ms, fn: fn as () => void })
          return id
        },
        clearTimeout: (id) => {
          const i = timers.findIndex((t) => t.id === id)
          if (i >= 0) timers.splice(i, 1)
        },
        random: () => 0.5,
      },
      runImmediate: false,
    })

    const idleResult = await handle.tick()
    expect(idleResult.idle).toBe(true)
    expect(idleResult.applied).toBe(true)
    expect(idleResult.results.some((r) => r.outcome === 'done')).toBe(true)
    expect(manager.installBundle).toHaveBeenCalled()

    // Reset for non-idle: fresh home so install is still needed
    const again = fixture()
    writeLock(again.profileDir, '@corp-dsh/demo', '1.2.0')
    const manager2 = mockManager()
    idle = false
    const handle2 = startSyncLoop({
      home: again.home,
      profileDir: again.profileDir,
      syncUrl: 'http://127.0.0.1:31000/sync',
      registry: 'http://127.0.0.1:31000/npm/',
      manager: manager2,
      withFileLock: async (_f, op) => op(),
      fetchPlan,
      isIdle: () => idle,
      clock: {
        now: () => 2000,
        setTimeout: (fn, ms) => {
          const id = nextId++
          timers.push({ id, ms, fn: fn as () => void })
          return id
        },
        clearTimeout: () => undefined,
        random: () => 0.5,
      },
      runImmediate: false,
    })
    const busy = await handle2.tick()
    expect(busy.idle).toBe(false)
    expect(busy.applied).toBe(false)
    expect(busy.skippedReason).toBe('not-idle')
    expect(manager2.installBundle).not.toHaveBeenCalled()
    handle.stop()
    handle2.stop()
  })

  it('schedules_jittered_poll_and_changed_only_advances_next_check', async () => {
    const { startSyncLoop, DEFAULT_POLL_INTERVAL_MS } = await import('../src/idle.ts')
    const { home, profileDir } = fixture()
    const fetchPlan = vi.fn(async (): Promise<SyncPlan> => ({ entries: [] }))
    const timers: { id: number; ms: number; fn: () => void }[] = []
    let nextId = 1
    const handle = startSyncLoop({
      home,
      profileDir,
      syncUrl: 'http://127.0.0.1:31000/sync',
      registry: 'http://127.0.0.1:31000/npm/',
      manager: mockManager(),
      withFileLock: async (_f, op) => op(),
      fetchPlan,
      isIdle: () => true,
      clock: {
        now: () => 0,
        setTimeout: (fn, ms) => {
          const id = nextId++
          timers.push({ id, ms, fn: fn as () => void })
          return id
        },
        clearTimeout: (id) => {
          const i = timers.findIndex((t) => t.id === id)
          if (i >= 0) timers.splice(i, 1)
        },
        random: () => 0.5,
      },
      runImmediate: false,
    })

    // With runImmediate false, only the jittered follow-up is scheduled (random 0.5 → base).
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(DEFAULT_POLL_INTERVAL_MS)
    expect(fetchPlan).not.toHaveBeenCalled()

    const before = timers[0]!
    handle.scheduleEarlyCheck()
    // Previous timer cleared; a sooner (0-delay) re-check is queued — not a user-removal signal.
    expect(timers.some((t) => t.id === before.id)).toBe(false)
    expect(timers.some((t) => t.ms === 0)).toBe(true)
    expect(fetchPlan).not.toHaveBeenCalled()
    handle.stop()
  })

  it('stamps_reset_or_reenable_clears_from_plan', async () => {
    const { startSyncLoop, stampLocalClear } = await import('../src/idle.ts')
    const { home, profileDir } = fixture()
    await appendOp(home, { type: 'user-removed', name: '@corp-dsh/demo', at: 1 })
    await stampLocalClear(home, '@corp-dsh/other', 're-enable', 2)
    expect(await readOps(home)).toContainEqual(expect.objectContaining({
      type: 're-enable',
      name: '@corp-dsh/other',
      at: 2,
    }))

    const fetchPlan = vi.fn(async (): Promise<SyncPlan> => ({
      entries: [],
      clears: [{ name: '@corp-dsh/demo', kind: 'reset' }],
    }))
    const handle = startSyncLoop({
      home,
      profileDir,
      syncUrl: 'http://127.0.0.1:31000/sync',
      registry: 'http://127.0.0.1:31000/npm/',
      manager: mockManager(),
      withFileLock: async (_f, op) => op(),
      fetchPlan,
      isIdle: () => true,
      clock: {
        now: () => 50,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        random: () => 0.5,
      },
      runImmediate: false,
    })
    await handle.tick()
    expect(await readOps(home)).toContainEqual(expect.objectContaining({
      type: 'reset',
      name: '@corp-dsh/demo',
      at: 50,
    }))
    handle.stop()
  })
})

describe('abandon does not poison failed via report', () => {
  it('abandon_writes_non_failed_oplog_and_buildSyncReport_keeps_abandoned', async () => {
    const { home, profileDir } = fixture()
    const manager: PluginManagerLike = {
      installBundle: vi.fn(async () => ({
        application: 'failed',
        changed: false,
        error: { code: 'already-installed' },
      })),
      setBundleEnabled: vi.fn(async () => ({ application: 'applied', changed: true })),
      removeBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
    }
    const deps: ApplyDeps = {
      home,
      profileDir,
      manager,
      registry: 'http://127.0.0.1:31000/npm/',
      withFileLock: async (_f, op) => op(),
      now: () => 10,
    }
    const result = await applySyncEntry(installEntry(), deps)
    expect(result.outcome).toBe('abandoned')
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'failed' && o.reason === 'already-installed')).toBe(false)
    expect(ops.some((o) => o.type === 'abandoned' || (o.type !== 'failed' && o.reason === 'already-installed'))).toBe(true)

    const { buildSyncReport } = await import('../src/idle.ts')
    const report = buildSyncReport({
      installed: [],
      ops,
      results: [result],
    })
    expect(report.results[0]?.outcome).toBe('abandoned')
    expect(report.opLog.some((e) => e.type === 'failed')).toBe(false)
  })
})

describe('cordis apply wires loop with injected deps', () => {
  it('starts_loop_and_changed_only_schedules_early_check', async () => {
    const { apply, name } = await import('../src/index.ts')
    expect(name).toBe('public-harness-plugin-sync')
    const { home, profileDir } = fixture()
    const fetchPlan = vi.fn(async (): Promise<SyncPlan> => ({ entries: [] }))
    const early: string[] = []
    const effects: Array<() => void> = []
    const listeners = new Map<string, Array<() => void>>()
    const ctx = {
      effect: (fn: () => () => void) => {
        effects.push(fn())
      },
      on: (event: string, handler: () => void) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      },
    }
    apply(ctx as never, {
      createLoopDeps: () => ({
        home,
        profileDir,
        syncUrl: 'http://127.0.0.1:31000/sync',
        registry: 'http://127.0.0.1:31000/npm/',
        manager: {
          installBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
          setBundleEnabled: vi.fn(async () => ({ application: 'applied', changed: true })),
          removeBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
        },
        withFileLock: async (_f, op) => op(),
        fetchPlan,
        isIdle: () => true,
        clock: {
          now: () => 0,
          setTimeout: (fn: () => void) => {
            // capture early-check zero delays
            return 1
          },
          clearTimeout: () => undefined,
          random: () => 0.5,
        },
        runImmediate: false,
        onScheduleEarlyCheck: () => {
          early.push('changed')
        },
      }),
    })
    expect(effects.length).toBe(1)
    const changed = listeners.get('plugin-manager/changed')
    expect(changed?.length).toBe(1)
    changed![0]!()
    expect(early).toEqual(['changed'])
    effects[0]!()
  })
})
