/** Activity tracking and idle selection shared by development and Linux lifecycles. */
import type { UserId } from './index.ts'

/** Records the most recent request time per user. */
export interface ActivityTracker {
  touch(userId: UserId): void
  forget(userId: UserId): void
  lastSeen(userId: UserId): number | undefined
  /** Users among `running` whose last activity is older than `idleMs`; untracked users count as idle. */
  idle(running: Iterable<UserId>, idleMs: number): UserId[]
}

/** Create an in-memory tracker with an injectable millisecond clock. */
export function createActivityTracker(clock: () => number = Date.now): ActivityTracker {
  const seen = new Map<UserId, number>()
  return {
    touch(userId) { seen.set(userId, clock()) },
    forget(userId) { seen.delete(userId) },
    lastSeen: userId => seen.get(userId),
    idle(running, idleMs) {
      if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new Error('idle timeout must be positive')
      const now = clock()
      return [...running].filter(userId => { const last = seen.get(userId); return last === undefined || now - last >= idleMs })
    },
  }
}

/** Bounded minimum so an open WebSocket (at most 60 s) cannot be mistaken for idleness. */
export const MIN_IDLE_MS = 120_000

/** Validate an idle-stop timeout; zero is not allowed because idle stop is a required lifecycle rule. */
export function validateIdleMs(idleMs: number): void {
  if (!Number.isSafeInteger(idleMs) || idleMs < MIN_IDLE_MS) throw new Error(`idle timeout must be at least ${MIN_IDLE_MS} ms`)
}

/** Periodically stop idle instances; returns a disposer. Failures to stop are reported, never fatal. */
export function startIdleReaper(options: { tracker: ActivityTracker; running: () => Iterable<UserId> | Promise<Iterable<UserId>>;
  stop: (userId: UserId) => Promise<void>; idleMs: number; intervalMs: number; onError?: (error: unknown) => void }): () => void {
  validateIdleMs(options.idleMs)
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) throw new Error('reaper interval must be positive')
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      for (const userId of options.tracker.idle(await options.running(), options.idleMs)) {
        try { await options.stop(userId); options.tracker.forget(userId) } catch (error) { options.onError?.(error) }
      }
    })().catch(error => options.onError?.(error)).finally(() => { busy = false })
  }, options.intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
