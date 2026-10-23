/**
 * Agent idle gate (P0.7) + jittered poll loop for default sync apply.
 * Uses agent `status: 'idle'` only — never LLM `idleWatchdog`.
 */
import {
  applySyncEntry,
  pollSyncPlan,
  type ApplyDeps,
  type ApplyResult,
  type FileLockFn,
  type PluginManagerLike,
  type SyncPlan,
} from './apply.ts'
import {
  appendOp,
  detectUserRemovals,
  readOps,
  type SyncOp,
} from './oplog.ts'

export type AgentStatusLike = 'idle' | 'running'

export interface AgentLike {
  readonly status: AgentStatusLike
}

export interface AgentsServiceLike {
  list(): readonly AgentLike[]
}

/** Minimal context shape for the idle probe (cordis ctx.agents). */
export interface IdleProbeContext {
  readonly agents?: AgentsServiceLike
}

/**
 * True when every live agent is idle, or none are registered.
 * Does **not** consult LLM stream `idleWatchdog`.
 */
export function isAgentIdle(ctx: IdleProbeContext): boolean {
  const list = ctx.agents?.list()
  if (list === undefined || list.length === 0) return true
  return list.every((agent) => agent.status === 'idle')
}

/** Design ~5 minute live push window. */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000

/** Default ±10% jitter on the poll interval. */
export const DEFAULT_JITTER_RATIO = 0.1

export function nextPollDelayMs(options: {
  readonly baseIntervalMs?: number
  readonly jitterRatio?: number
  /** Uniform [0, 1). */
  readonly random?: () => number
} = {}): number {
  const base = options.baseIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const ratio = options.jitterRatio ?? DEFAULT_JITTER_RATIO
  const r = options.random?.() ?? Math.random()
  const clamped = Math.min(1, Math.max(0, r))
  const jitter = base * ratio * (2 * clamped - 1)
  return Math.max(0, Math.round(base + jitter))
}

export type LocalClearKind = 'reset' | 're-enable'

/** Stamp a local clear marker so install is not blocked after admin reset / My plugins re-enable. */
export async function stampLocalClear(
  home: string,
  name: string,
  kind: LocalClearKind,
  at: number = Date.now(),
): Promise<void> {
  await appendOp(home, { type: kind, name, at })
}

export interface SyncReportInstalled {
  readonly name: string
  readonly version: string
}

export interface SyncReportOpLog {
  readonly type: string
  readonly name: string
  readonly version?: string
  readonly reason?: string
}

export interface SyncReportResult {
  readonly name: string
  readonly action?: string
  readonly outcome: string
  readonly reason?: string
}

/** Body for `POST /sync/report`. */
export interface BuiltSyncReport {
  readonly installed: readonly SyncReportInstalled[]
  readonly opLog: readonly SyncReportOpLog[]
  readonly results: readonly SyncReportResult[]
}

/**
 * Build a report payload. Abandoned ops/results stay non-failed so
 * `applySyncReport` does not poison default-state `failed`.
 */
export function buildSyncReport(input: {
  readonly installed: readonly SyncReportInstalled[]
  readonly ops: readonly SyncOp[]
  readonly results: readonly ApplyResult[]
  readonly sinceAt?: number
}): BuiltSyncReport {
  const since = input.sinceAt ?? 0
  const opLog: SyncReportOpLog[] = []
  for (const op of input.ops) {
    if (op.at < since) continue
    // Never send abandon as type failed (1D.3 Important #1).
    if (op.type === 'failed' && (op.reason === 'already-installed' || op.reason === 'not-removable')) {
      opLog.push({
        type: 'abandoned',
        name: op.name,
        ...(op.version !== undefined ? { version: op.version } : {}),
        reason: op.reason,
      })
      continue
    }
    opLog.push({
      type: op.type,
      name: op.name,
      ...(op.version !== undefined ? { version: op.version } : {}),
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
    })
  }
  return {
    installed: [...input.installed],
    opLog,
    results: input.results.map((r) => ({
      name: r.name,
      action: r.action,
      outcome: r.outcome,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    })),
  }
}

export interface SyncLoopClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  random(): number
}

export interface SyncLoopDeps {
  readonly home: string
  readonly profileDir: string
  readonly syncUrl: string
  readonly registry: string
  readonly manager: PluginManagerLike
  readonly withFileLock: FileLockFn
  readonly fetchPlan: (url: string) => Promise<SyncPlan>
  readonly isIdle: () => boolean
  readonly report?: (body: BuiltSyncReport) => Promise<void>
  /** List installed bundles for the report (optional). */
  readonly listInstalled?: () => Promise<readonly SyncReportInstalled[]> | readonly SyncReportInstalled[]
  readonly clock?: Partial<SyncLoopClock>
  readonly pollIntervalMs?: number
  readonly jitterRatio?: number
  /** When true (default), run one tick at start. */
  readonly runImmediate?: boolean
  /** Test hook: observe scheduleEarlyCheck without relying on timer races. */
  readonly onScheduleEarlyCheck?: () => void
}

export interface SyncTickResult {
  readonly idle: boolean
  readonly applied: boolean
  readonly results: readonly ApplyResult[]
  readonly skippedReason?: 'not-idle'
  readonly report?: BuiltSyncReport
}

export interface SyncLoopHandle {
  stop(): void
  /**
   * `plugin-manager/changed` → earlier re-check only.
   * Never used as the user-removal source (op log is).
   */
  scheduleEarlyCheck(): void
  tick(): Promise<SyncTickResult>
}

function resolveClock(partial?: Partial<SyncLoopClock>): SyncLoopClock {
  return {
    now: partial?.now ?? (() => Date.now()),
    setTimeout: partial?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: partial?.clearTimeout ?? ((id) => clearTimeout(id as NodeJS.Timeout)),
    random: partial?.random ?? (() => Math.random()),
  }
}

async function stampPlanClears(home: string, plan: SyncPlan, at: number): Promise<void> {
  const clears = plan.clears
  if (clears === undefined) return
  for (const clear of clears) {
    if (clear.kind !== 'reset' && clear.kind !== 're-enable') continue
    await stampLocalClear(home, clear.name, clear.kind, at)
  }
}

/**
 * One poll cycle: detect user-removals, stamp clears, apply only while idle.
 * When not idle, leave defaults pending (skip mutate) and still schedule the next poll.
 */
export async function runSyncTick(deps: SyncLoopDeps): Promise<SyncTickResult> {
  const clock = resolveClock(deps.clock)
  const at = clock.now()
  await detectUserRemovals({ home: deps.home, profileDir: deps.profileDir, now: at })

  const plan = await pollSyncPlan(deps.syncUrl, { fetchPlan: deps.fetchPlan })
  await stampPlanClears(deps.home, plan, at)

  if (!deps.isIdle()) {
    return { idle: false, applied: false, results: [], skippedReason: 'not-idle' }
  }

  const applyDeps: ApplyDeps = {
    home: deps.home,
    profileDir: deps.profileDir,
    manager: deps.manager,
    registry: deps.registry,
    withFileLock: deps.withFileLock,
    now: () => clock.now(),
  }
  const results: ApplyResult[] = []
  for (const entry of plan.entries) {
    results.push(await applySyncEntry(entry, applyDeps))
  }

  const ops = await readOps(deps.home)
  const installed = deps.listInstalled === undefined
    ? []
    : [...(await deps.listInstalled())]
  const report = buildSyncReport({ installed, ops, results })
  if (deps.report !== undefined) {
    await deps.report(report)
  }
  return { idle: true, applied: true, results, report }
}

/**
 * Start the idle-gated poll loop. Schedules an immediate tick (unless
 * `runImmediate: false`) and then every ~5 minutes with jitter.
 */
export function startSyncLoop(deps: SyncLoopDeps): SyncLoopHandle {
  const clock = resolveClock(deps.clock)
  let stopped = false
  let timer: unknown
  let running: Promise<void> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
  }

  const schedule = (ms: number): void => {
    if (stopped) return
    clearTimer()
    timer = clock.setTimeout(() => {
      timer = undefined
      void enqueue()
    }, ms)
  }

  const enqueue = async (): Promise<void> => {
    if (stopped) return
    if (running !== undefined) {
      await running
      return
    }
    running = (async () => {
      try {
        await runSyncTick(deps)
      } finally {
        running = undefined
        if (!stopped) {
          schedule(nextPollDelayMs({
            baseIntervalMs: deps.pollIntervalMs,
            jitterRatio: deps.jitterRatio,
            random: () => clock.random(),
          }))
        }
      }
    })()
    await running
  }

  const handle: SyncLoopHandle = {
    stop() {
      stopped = true
      clearTimer()
    },
    scheduleEarlyCheck() {
      deps.onScheduleEarlyCheck?.()
      if (stopped) return
      // Advance next re-check only — do not treat changed as user-removal.
      schedule(0)
    },
    tick: () => runSyncTick(deps),
  }

  if (deps.runImmediate !== false) {
    void enqueue()
  } else {
    schedule(nextPollDelayMs({
      baseIntervalMs: deps.pollIntervalMs,
      jitterRatio: deps.jitterRatio,
      random: () => clock.random(),
    }))
  }

  return handle
}
