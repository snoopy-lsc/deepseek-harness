/** Restartable account/storage provisioning consumes the selected runtime for allocation and confined workspace setup. */
import { randomBytes } from 'node:crypto'
import { AccountSuspendedError, CapacityError, parseInstanceId, parseUserId,
  type InstanceRuntime, type RuntimeInstance, type UserId } from '@public-harness/contracts'
import { deriveNames, ensureAccount, type AccountDirectory } from './accounts.ts'
import type { ProvisionerConfig } from './config.ts'
import { ensureStorage, layoutForRuntime, hostOwnership, type Ownership, type StorageLayout } from './storage.ts'
import type { Lifecycle, StateStore, UserStateV2 } from './state.ts'
import { KeyedLock, type CommandRunner } from './system.ts'

/** Legacy container implementation's account/storage view. */
export interface UserRecord {
  readonly userId: UserId; readonly account: string; readonly container: string; readonly uid: number; readonly gid: number
  readonly lifecycle: Lifecycle | 'quarantined'; readonly layout: StorageLayout
}
/** Injected host effects and selected runtime; no provider is constructed here. */
export interface UserProvisionerDeps {
  readonly config: ProvisionerConfig; readonly store: StateStore; readonly directory: AccountDirectory
  readonly runner: CommandRunner; readonly runtime: InstanceRuntime; readonly ownership?: Ownership; readonly clock?: () => number
}
/** Common lifecycle operations over versioned records. */
export interface UserProvisioner {
  /** Provision account/storage and reserve launch capacity before host effects.
   * @param userId Validated owner.
   * @returns Provisioned record; allocation capacity remains reserved until verified cleanup.
   */
  ensureUser(userId: UserId): Promise<UserRecord>
  /** Record verified runtime cleanup while retaining account and user data.
   * @param userId Owner whose runtime has already stopped.
   * @returns Resolves after clearing launch allocation; callers must stop resources first.
   */
  stopUser(userId: UserId): Promise<void>
  /** Enter starting under the same user lock as stop, suspension and deletion.
   * @param userId Owner; the caller must not already hold this user lock.
   * @returns Allocated record; inactive users and exhausted capacity reject.
   */
  beginStart(userId: UserId): Promise<UserRecord>
  markRunning(userId: UserId): Promise<void>
  markStopped(userId: UserId): Promise<void>
  quarantine(userId: UserId): Promise<void>
  get(userId: UserId): Promise<UserStateV2 | undefined>
  /** Count durable pending/complete allocations and starting/running/quarantined records.
   * @returns Reserved instance count, including allocations with no routable endpoint.
   */
  activeCount(): Promise<number>
  withUser<T>(userId: UserId, task: () => Promise<T>): Promise<T>
  readonly store: StateStore
  recordOf(state: UserStateV2): UserRecord
  instanceOf(state: UserStateV2): RuntimeInstance
  allocationOf(state: UserStateV2): Omit<RuntimeInstance, 'webPort' | 'quotaPort'>
  recordOfLayout(state: UserStateV2): StorageLayout
}
const ACTIVE: readonly string[] = ['starting', 'running', 'quarantined']

/** Build the common provisioner; provider selection is checked before any host mutation.
 * @param deps Validated config and explicitly selected collaborators.
 * @returns Restartable provisioning operations; mismatched durable backends refuse access.
 */
export function createUserProvisioner(deps: UserProvisionerDeps): UserProvisioner {
  const { config, store, directory, runtime } = deps
  if (runtime === undefined || runtime.kind !== config.runtime.kind) throw new Error('runtime provider does not match configured backend')
  const now = deps.clock ?? Date.now
  const ownership = deps.ownership ?? hostOwnership
  const userLocks = new KeyedLock(), globalLock = new KeyedLock()
  const match = (state: UserStateV2): void => {
    if (state.runtime.kind !== config.runtime.kind || state.runtime.kind !== runtime.kind) throw new Error('stored backend does not match runtime provider')
  }
  const recordOf = (state: UserStateV2): UserRecord => {
    match(state)
    if (state.uid === undefined || state.gid === undefined) throw new Error('user is not provisioned')
    return { userId: state.userId, account: state.account, container: deriveNames(state.userId).container, uid: state.uid, gid: state.gid,
      lifecycle: state.lifecycle, layout: layoutForRuntime(config.paths, state.account, config.runtime.kind) }
  }
  const allocationOf = (state: UserStateV2): Omit<RuntimeInstance, 'webPort' | 'quotaPort'> => {
    const record = recordOf(state), layout = record.layout
    const instanceId = state.instance?.instanceId ?? state.pending?.instanceId ?? parseInstanceId(`legacy_${state.account}`)
    return { userId: state.userId, instanceId, runtime: state.runtime, account: state.account, uid: record.uid, gid: record.gid,
      home: layout.home, workspace: layout.workspace, cache: layout.cache, tmp: layout.tmp, controlDir: layout.ctl }
  }
  const instanceOf = (state: UserStateV2): RuntimeInstance => {
    const allocated = state.instance
    if (allocated === null) throw new Error('instance allocation is incomplete')
    const expected = allocationOf(state)
    for (const key of ['home', 'workspace', 'cache', 'tmp', 'controlDir'] as const) {
      if (allocated[key] !== expected[key]) throw new Error('stored instance path does not match deployment')
    }
    return allocated
  }
  const save = async (state: UserStateV2): Promise<void> => { state.updatedAt = now(); await store.put(state) }
  const hasReservation = (state: UserStateV2): boolean => ACTIVE.includes(state.lifecycle) || state.instance !== null || state.pending !== undefined
  const activeCount = async (): Promise<number> => (await store.list()).records.filter(hasReservation).length
  const requireState = async (userId: UserId): Promise<UserStateV2> => {
    const state = await store.get(userId)
    if (state === undefined) throw new Error('unknown user')
    match(state); return state
  }
  const refuseInactive = (state: UserStateV2): void => {
    if (state.lifecycle === 'quarantined') throw new Error('instance is quarantined; reconcile cleanup before retry')
    if (state.lifecycle === 'suspended' || state.lifecycle === 'pending-deletion') throw new AccountSuspendedError()
  }
  const markStopped = async (userId: UserId): Promise<void> => {
    const state = await store.get(userId)
    if (state === undefined) return
    match(state)
    if (ACTIVE.includes(state.lifecycle)) state.lifecycle = 'stopped'
    state.instance = null; delete state.pending; delete state.lastError
    state.acquired = state.acquired.filter(resource => resource === 'account' || resource === 'storage')
    await save(state)
  }
  async function provision(userId: UserId): Promise<UserStateV2> {
    const names = deriveNames(userId)
    let state = await store.get(userId)
    if (state === undefined) {
      state = { version: 2, userId, account: names.account,
        runtime: config.runtime.kind === 'systemd' ? { kind: 'systemd', unit: names.unit } : { kind: 'podman-gvisor', container: names.container },
        instance: null, acquired: [], lifecycle: 'provisioning', createdAt: now(), updatedAt: now(),
        steps: { account: false, storage: false, workspace: false } }
    }
    match(state); refuseInactive(state)
    const reservation = state
    // Provisioning and admission take the user lock before the shared capacity lock.
    await globalLock.run('capacity', async () => {
      if (!hasReservation(reservation) && await activeCount() >= config.maxActiveInstances) throw new CapacityError()
      if (reservation.instance === null && reservation.pending === undefined) {
        reservation.pending = { instanceId: parseInstanceId(randomBytes(18).toString('base64url')) }
        await save(reservation)
      }
    })
    const layout = layoutForRuntime(config.paths, state.account, config.runtime.kind)
    let step = 'account'
    try {
      if (!state.steps.account || state.uid === undefined || state.gid === undefined) {
        const identity = await ensureAccount(directory, state.account, config.runtime.kind === 'podman-gvisor' ? layout.podman : layout.home, config.tools.nologin)
        state.uid = identity.uid; state.gid = identity.gid; state.steps.account = true
        if (!state.acquired.includes('account')) state.acquired.push('account')
        await save(state)
      }
      step = 'storage'
      if (!state.steps.storage && config.runtime.kind === 'podman-gvisor') {
        await ensureStorage(config.paths, layout, { uid: state.uid, gid: state.gid }, ownership, config.runtime.kind)
        state.steps.storage = true
        if (!state.acquired.includes('storage')) state.acquired.push('storage')
        await save(state)
      }
      if (state.instance === null) {
        step = 'allocation'
        const allocated = await runtime.allocate(allocationOf(state))
        state = await requireState(userId)
        state.instance = allocated; delete state.pending
        await save(state)
      }
      if (!state.acquired.includes('policy') || !state.steps.storage) {
        step = 'prepare'
        await runtime.prepare(instanceOf(state))
        state = await requireState(userId)
        if (config.runtime.kind === 'systemd') {
          state.steps.storage = true
          if (!state.acquired.includes('storage')) state.acquired.push('storage')
        }
        if (!state.acquired.includes('policy')) state.acquired.push('policy')
        await save(state)
      }
      step = 'workspace'
      if (!state.steps.workspace) {
        await runtime.initializeWorkspace(instanceOf(state))
        state.steps.workspace = true; await save(state)
      }
    } catch (error) {
      state = await requireState(userId)
      state.lastError = `${step}-failed`
      state.lifecycle = step === 'account' || step === 'storage' ? 'provisioning' : 'quarantined'
      await save(state)
      throw error
    }
    delete state.lastError
    if (state.lifecycle === 'provisioning') state.lifecycle = 'stopped'
    await save(state); return state
  }
  return {
    store, recordOf, instanceOf, allocationOf, activeCount, recordOfLayout: state => layoutForRuntime(config.paths, state.account, config.runtime.kind),
    withUser: (userId, task) => userLocks.run(deriveNames(userId).account, task),
    ensureUser: userId => userLocks.run(deriveNames(parseUserId(userId)).account, async () => recordOf(await provision(userId))),
    stopUser: userId => userLocks.run(deriveNames(userId).account, async () => { await markStopped(userId) }),
    async beginStart(userId) {
      return userLocks.run(deriveNames(userId).account, () => globalLock.run('capacity', async () => {
        const state = await requireState(userId); refuseInactive(state)
        if (!hasReservation(state) && await activeCount() >= config.maxActiveInstances) throw new CapacityError()
        if (state.lifecycle === 'provisioning' || !state.steps.workspace || state.instance === null) throw new Error('user is not fully provisioned')
        if (!ACTIVE.includes(state.lifecycle)) {
          state.lifecycle = 'starting'; await save(state)
        }
        return recordOf(state)
      }))
    },
    async markRunning(userId) {
      const state = await requireState(userId); refuseInactive(state)
      state.lifecycle = 'running'; state.lastActiveAt = now(); await save(state)
    },
    markStopped,
    async quarantine(userId) { const state = await requireState(userId); state.lifecycle = 'quarantined'; await save(state) },
    get: userId => store.get(userId),
  }
}
