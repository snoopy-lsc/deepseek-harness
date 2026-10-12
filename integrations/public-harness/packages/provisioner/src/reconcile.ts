/** Suspension, idle stop, restart recovery, and recovery-period-gated deletion. */
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { type ActivityTracker, type InstanceEndpoint, type InstanceRuntime, type UserId } from '@public-harness/contracts'
import { isDerivedAccountName, type AccountDirectory } from './accounts.ts'
import type { ProvisionerConfig } from './config.ts'
import { removeStorage } from './storage.ts'
import type { UserStateV2 } from './state.ts'
import type { UserProvisioner } from './users.ts'

/** Deletion was requested too early or without the second confirmation. */
export class DeletionNotAllowedError extends Error {
  override readonly name = 'DeletionNotAllowedError'
  constructor(readonly reason: 'not-requested' | 'not-confirmed' | 'recovery-period') { super(`deletion not allowed: ${reason}`) }
}

/** Shared mutable view of which users are currently routable. */
export interface LifecycleContext {
  readonly users: UserProvisioner
  readonly runtime: InstanceRuntime
  readonly tracker: ActivityTracker
  readonly config: ProvisionerConfig
  readonly directory: Pick<AccountDirectory, 'remove'>
  readonly endpoints: Map<UserId, InstanceEndpoint>
  readonly clock?: () => number
  /** How long a successful runtime check is trusted before the next provider query (default 5 s). */
  readonly livenessTtlMs?: number
}

/** Outcome of one reconcile pass; contains only counts and record file names. */
export interface ReconcileReport { readonly restored: number; readonly stopped: number; readonly purged: number
  readonly staleSockets: number; readonly invalid: string[]; readonly failures: number }

/** Operations whose names match the plan; each is idempotent. */
export interface Lifecycle {
  reconcile(): Promise<ReconcileReport>
  suspend(userId: UserId): Promise<void>
  reactivate(userId: UserId): Promise<void>
  requestDeletion(userId: UserId): Promise<void>
  confirmDeletion(userId: UserId): Promise<void>
  deleteUser(userId: UserId): Promise<void>
  idleStop(): Promise<UserId[]>
  /**
   * If the user is routable but its process is gone or stopped (killed out of band, for example when the gVisor pids
   * limit is exhausted), release its socket, forwarder, and quota listener and mark it stopped. Returns true when it did.
   * Successful checks are cached for `livenessTtlMs`; an inspect that cannot tell leaves everything unchanged.
   */
  reapIfDead(userId: UserId): Promise<boolean>
}

/** Build lifecycle operations over the shared context. */
export function createLifecycle(ctx: LifecycleContext): Lifecycle {
  const now = ctx.clock ?? Date.now
  const { users, runtime, config } = ctx

  /** Stop the instance and revoke its routing socket; stored data is untouched. */
  async function halt(state: UserStateV2): Promise<void> {
    ctx.endpoints.delete(state.userId)
    ctx.tracker.forget(state.userId)
    if (state.uid !== undefined && state.gid !== undefined) {
      try {
        if (state.instance !== null) await runtime.stop(users.instanceOf(state))
        else await runtime.releaseAllocation(users.allocationOf(state))
      } catch (error) { await users.quarantine(state.userId); throw error }
    }
    state.instance = null; delete state.pending
    state.acquired = state.acquired.filter(resource => resource === 'account' || resource === 'storage')
    await users.store.put(state)
  }

  async function mutate(userId: UserId, change: (state: UserStateV2) => Promise<void> | void): Promise<void> {
    await users.withUser(userId, async () => {
      const state = await users.store.get(userId)
      if (state === undefined) throw new Error('unknown user')
      await change(state)
      state.updatedAt = now()
      await users.store.put(state)
    })
  }

  const eligible = (state: UserStateV2): boolean => state.lifecycle === 'pending-deletion'
    && state.deletionConfirmedAt !== undefined && state.deletionRequestedAt !== undefined
    && now() - state.deletionRequestedAt >= config.deletionRecoveryMs

  async function purge(state: UserStateV2): Promise<void> {
    await halt(state)
    await removeStorage(config.paths, users.recordOfLayout(state))
    if (state.steps.account) await ctx.directory.remove(state.account)
    await users.store.delete(state.userId)
  }

  const ttl = ctx.livenessTtlMs ?? 5000
  const lastChecked = new Map<UserId, number>()
  const runtimeStopped = async (state: UserStateV2): Promise<boolean> =>
    state.instance !== null
    && await runtime.state(users.instanceOf(state)).catch(() => 'unknown' as const) === 'stopped'

  /** Caller holds the user's lock. */
  async function releaseDead(state: UserStateV2): Promise<boolean> {
    if (!ctx.endpoints.has(state.userId) || !await runtimeStopped(state)) return false
    await halt(state)
    await users.markStopped(state.userId)
    return true
  }

  const lifecycle: Lifecycle = {
    async reapIfDead(userId) {
      if (!ctx.endpoints.has(userId)) return false
      const at = now()
      const previous = lastChecked.get(userId)
      if (previous !== undefined && at - previous < ttl) return false
      lastChecked.set(userId, at)
      const probe = await users.get(userId)
      if (probe === undefined || !await runtimeStopped(probe)) return false
      // Decide again under the lock: the instance may have been stopped and restarted since the first look.
      return users.withUser(userId, async () => {
        const state = await users.store.get(userId)
        return state !== undefined && await releaseDead(state)
      })
    },
    async suspend(userId) {
      await mutate(userId, async state => {
        await halt(state)
        state.lifecycle = 'suspended'; state.suspendedAt = now()
      })
    },
    async reactivate(userId) {
      await mutate(userId, state => {
        if (state.lifecycle !== 'suspended' && state.lifecycle !== 'pending-deletion') return
        state.lifecycle = state.steps.account && state.steps.storage && state.steps.workspace ? 'stopped' : 'provisioning'
        delete state.suspendedAt; delete state.deletionRequestedAt; delete state.deletionConfirmedAt
      })
    },
    async requestDeletion(userId) {
      await mutate(userId, async state => {
        if (state.lifecycle === 'pending-deletion') return
        await halt(state)
        state.lifecycle = 'pending-deletion'; state.deletionRequestedAt = now(); delete state.deletionConfirmedAt
      })
    },
    async confirmDeletion(userId) {
      await mutate(userId, state => {
        if (state.lifecycle !== 'pending-deletion') throw new DeletionNotAllowedError('not-requested')
        state.deletionConfirmedAt = now()
      })
    },
    async deleteUser(userId) {
      await users.withUser(userId, async () => {
        const state = await users.store.get(userId)
        if (state === undefined) return
        if (state.lifecycle !== 'pending-deletion') throw new DeletionNotAllowedError('not-requested')
        if (state.deletionConfirmedAt === undefined) throw new DeletionNotAllowedError('not-confirmed')
        if (!eligible(state)) throw new DeletionNotAllowedError('recovery-period')
        await purge(state)
      })
    },
    async idleStop() {
      const running = [...ctx.endpoints.keys()]
      const stopped: UserId[] = []
      for (const userId of ctx.tracker.idle(running, config.idleStopMs)) {
        await users.withUser(userId, async () => {
          const state = await users.store.get(userId)
          if (state === undefined) return
          await halt(state)
          await users.markStopped(userId)
          stopped.push(userId)
        })
      }
      return stopped
    },
    async reconcile() {
      const { records, invalid } = await users.store.list()
      const report = { restored: 0, stopped: 0, purged: 0, staleSockets: 0, failures: 0, invalid }
      for (const record of records) {
        try {
          await users.withUser(record.userId, async () => {
            const state = await users.store.get(record.userId)
            if (state === undefined) return
            if (state.lifecycle === 'quarantined') { await halt(state); await users.markStopped(state.userId); report.stopped += 1; return }
            if ((state.lifecycle === 'provisioning' || state.lifecycle === 'stopped')
              && (state.pending !== undefined || state.instance !== null)) {
              await halt(state); await users.markStopped(state.userId); report.stopped += 1; return
            }
            if (eligible(state)) { await purge(state); report.purged += 1; return }
            if (state.lifecycle === 'suspended' || state.lifecycle === 'pending-deletion') { await halt(state); report.stopped += 1; return }
            if (state.lifecycle === 'starting' || state.lifecycle === 'running') {
              // A provisioner restart or host reboot lost the routing socket and rotation timer: restart cleanly on demand.
              if (ctx.endpoints.has(state.userId)) {
                // Routable in memory is not enough: the instance may have been killed since the last pass.
                if (await releaseDead(state)) { report.stopped += 1; return }
                ctx.tracker.touch(state.userId); report.restored += 1; return
              }
              await halt(state)
              await users.markStopped(state.userId)
              report.stopped += 1
            }
          })
        } catch (error) { report.failures += 1 /* Failed cleanup remains quarantined and non-routable. */ }
      }
      report.staleSockets = await sweepSockets(config.paths.socketDir, new Set(
        [...ctx.endpoints.values()].flatMap(endpoint => endpoint.kind === 'unix' ? [endpoint.path] : [])))
      return report
    },
  }
  return lifecycle
}

/** Remove router-facing sockets that no live instance owns; other file types are never touched. */
export async function sweepSockets(socketDir: string, keep: ReadonlySet<string>): Promise<number> {
  let removed = 0
  for (const name of await readdir(socketDir).catch(() => [] as string[])) {
    if (!name.endsWith('.sock') || !isDerivedAccountName(name.slice(0, -5))) continue
    const path = join(socketDir, name)
    if (keep.has(path)) continue
    const entry = await lstat(path).catch(() => undefined)
    if (entry?.isSocket()) { await unlink(path); removed += 1 }
  }
  return removed
}
