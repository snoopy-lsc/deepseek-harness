/**
 * In-instance default sync plugin (`public-harness-plugin-sync`).
 * Apply core (1D.3) + idle-gated poll loop (1D.4). Snapshots/recovery: 1D.5.
 */
import type { Context } from '@deepseek-ai/cordis'
import { startSyncLoop, type SyncLoopDeps, type SyncLoopHandle } from './idle.ts'

export {
  appendOp,
  detectUserRemovals,
  isUserRemoved,
  marketDir,
  readOps,
  snapshotsDir,
  syncLogPath,
  type SyncOp,
  type SyncOpType,
} from './oplog.ts'

export {
  applySyncEntry,
  planSha512ToIntegrity,
  pollSyncPlan,
  readLockfileIntegrity,
  type ApplyDeps,
  type ApplyOutcome,
  type ApplyResult,
  type ChangeResultLike,
  type FileLockFn,
  type PluginManagerLike,
  type SyncAction,
  type SyncPlan,
  type SyncPlanClear,
  type SyncPlanEntry,
} from './apply.ts'

export {
  buildSyncReport,
  DEFAULT_JITTER_RATIO,
  DEFAULT_POLL_INTERVAL_MS,
  isAgentIdle,
  nextPollDelayMs,
  runSyncTick,
  stampLocalClear,
  startSyncLoop,
  type AgentLike,
  type AgentStatusLike,
  type AgentsServiceLike,
  type BuiltSyncReport,
  type IdleProbeContext,
  type LocalClearKind,
  type SyncLoopClock,
  type SyncLoopDeps,
  type SyncLoopHandle,
  type SyncTickResult,
} from './idle.ts'

/** Cordis plugin id inserted by the market `--patch`. */
export const name = 'public-harness-plugin-sync'

export interface PluginSyncConfig {
  readonly syncUrl?: string
  readonly registry?: string
  readonly home?: string
  readonly profileDir?: string
  /**
   * Inject loop deps (manager, fetch, home, clock, idle probe). Required to
   * start the poll loop — keeps the plugin testable without live HMR.
   */
  readonly createLoopDeps?: (ctx: Context) => SyncLoopDeps | null | undefined
}

type EffectContext = Context & {
  effect?: (fn: () => () => void) => void
  on?: (event: string, handler: (...args: unknown[]) => void) => void
}

/**
 * Cordis entry: start the idle-gated poll loop from injected deps.
 * `plugin-manager/changed` only advances the next re-check.
 */
export function apply(ctx: Context, config: PluginSyncConfig = {}): void {
  const deps = config.createLoopDeps?.(ctx) ?? null
  if (deps == null) return

  const handle: SyncLoopHandle = startSyncLoop(deps)
  const lifecycle = ctx as EffectContext
  lifecycle.effect?.(() => () => {
    handle.stop()
  })
  lifecycle.on?.('plugin-manager/changed', () => {
    // Advance next re-check only — never the user-removal source.
    handle.scheduleEarlyCheck()
  })
}
