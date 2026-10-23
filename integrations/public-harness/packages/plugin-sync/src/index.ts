/**
 * In-instance default sync plugin (`public-harness-plugin-sync`).
 * Apply core lives here (1D.3); idle gate is 1D.4; snapshots/recovery 1D.5.
 */
import type { Context } from '@deepseek-ai/cordis'

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
  type SyncPlanEntry,
} from './apply.ts'

/** Cordis plugin id inserted by the market `--patch`. */
export const name = 'public-harness-plugin-sync'

export interface PluginSyncConfig {
  readonly syncUrl?: string
}

/**
 * Cordis entry. Poll/idle wiring lands in 1D.4; this task only registers the name
 * so later insert has a stable module.
 */
export function apply(_ctx: Context, _config: PluginSyncConfig = {}): void {
  // Idle-gated poll loop + plugin-manager injection: 1D.4.
}
