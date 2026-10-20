/** Local-only instance-manager provider for macOS and Windows development. */
import { AccountSuspendedError, CapacityError, createActivityTracker, type ActivityTracker, type InstanceManager, type UserId } from '@public-harness/contracts'
import type { DevRuntimeConfig } from './config.ts'
import { validateDevRuntimeConfig, validateDevUsers } from './config.ts'
import { startWebProcess, type RunningWeb } from './processes.ts'

export type { DevRuntimeConfig } from './config.ts'
export { validateDevUsers } from './config.ts'

export interface DevInstanceManager extends InstanceManager {
  readonly storageRoot: string
  /** Admit an authenticated local identity before its first workspace request. */
  register(userId: UserId): void
  /** Last-routed-request times; the idle reaper reads this. */
  readonly tracker: ActivityTracker
  /** Users with a starting or running Web child, which is what the admission cap counts. */
  active(): UserId[]
  /** Whether the account may be routed: configured and not suspended. */
  isActive(userId: UserId): boolean
  /** Stop the instance and refuse further starts until `reactivate`. */
  suspend(userId: UserId): Promise<void>
  reactivate(userId: UserId): void
  /** Stop every running instance with no routed request in the last `idleMs`; returns who was stopped. */
  stopIdle(idleMs: number): Promise<UserId[]>
  close(): Promise<void>
}

/** Create one manager whose configured identities may start real Web profiles. */
export function createDevInstanceManager(config: DevRuntimeConfig, tracker: ActivityTracker = createActivityTracker()): DevInstanceManager {
  validateDevRuntimeConfig(config)
  const users = new Set(config.users)
  const maxActive = config.maxActive ?? users.size
  const suspended = new Set<UserId>()
  const processes = new Map<UserId, Promise<RunningWeb>>()
  let closed = false
  const known = (userId: UserId): void => { if (!users.has(userId)) throw new Error('unknown development test user') }
  // The map is only mutated synchronously, so check-and-insert here is atomic: concurrent first requests cannot exceed the cap.
  const get = (userId: UserId): Promise<RunningWeb> => {
    if (closed) throw new Error('development instance manager is closed')
    known(userId)
    if (suspended.has(userId)) throw new AccountSuspendedError()
    let process = processes.get(userId)
    if (process === undefined) {
      if (processes.size >= maxActive) throw new CapacityError()
      process = startWebProcess(config, userId)
      processes.set(userId, process)
      void process.then(running => {
        void running.closed.then(() => {
          if (processes.get(userId) === process) processes.delete(userId)
        })
      }, () => {
        if (processes.get(userId) === process) processes.delete(userId)
      })
    }
    tracker.touch(userId)
    return process
  }
  const stop = async (userId: UserId): Promise<void> => {
    known(userId)
    const process = processes.get(userId)
    if (process === undefined) return
    const running = await process.catch(() => undefined)
    if (running === undefined) return
    await running.stop()
    if (processes.get(userId) === process) processes.delete(userId)
  }
  return {
    storageRoot: config.storageRoot,
    register(userId) {
      if (closed) throw new Error('development instance manager is closed')
      if (users.has(userId)) return
      validateDevUsers([...users, userId])
      users.add(userId)
    },
    tracker,
    async ensure(userId) { return (await get(userId)).endpoint },
    async launchGrant(userId) { return (await get(userId)).grant },
    stop,
    active: () => [...processes.keys()],
    isActive: userId => users.has(userId) && !suspended.has(userId),
    async suspend(userId) { known(userId); suspended.add(userId); await stop(userId) },
    reactivate(userId) { known(userId); suspended.delete(userId) },
    async stopIdle(idleMs) {
      const idle = tracker.idle(processes.keys(), idleMs)
      await Promise.all(idle.map(stop))
      return idle
    },
    async close() {
      closed = true
      const tasks = [...processes.values()].map(async process => (await process).stop())
      const outcomes = await Promise.allSettled(tasks)
      processes.clear()
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'failed to stop Web children')
    },
  }
}
