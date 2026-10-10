/** Local-only instance-manager provider for macOS and Windows development. */
import type { InstanceManager, UserId } from '@public-harness/contracts'
import type { DevRuntimeConfig } from './config.ts'
import { validateDevRuntimeConfig } from './config.ts'
import { startWebProcess, type RunningWeb } from './processes.ts'

export type { DevRuntimeConfig } from './config.ts'

export interface DevInstanceManager extends InstanceManager {
  readonly storageRoot: string
  close(): Promise<void>
}

/** Create one manager whose configured identities may start real Web profiles. */
export function createDevInstanceManager(config: DevRuntimeConfig): DevInstanceManager {
  validateDevRuntimeConfig(config)
  const users = new Set(config.users)
  const processes = new Map<UserId, Promise<RunningWeb>>()
  let closed = false
  const get = (userId: UserId): Promise<RunningWeb> => {
    if (closed) throw new Error('development instance manager is closed')
    if (!users.has(userId)) throw new Error('unknown development test user')
    let process = processes.get(userId)
    if (process === undefined) {
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
    return process
  }
  const stop = async (userId: UserId): Promise<void> => {
    if (!users.has(userId)) throw new Error('unknown development test user')
    const process = processes.get(userId)
    if (process === undefined) return
    const running = await process
    await running.stop()
    if (processes.get(userId) === process) processes.delete(userId)
  }
  return {
    storageRoot: config.storageRoot,
    async ensure(userId) { return (await get(userId)).endpoint },
    async launchGrant(userId) { return (await get(userId)).grant },
    stop,
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
