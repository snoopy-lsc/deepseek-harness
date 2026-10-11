/** Idempotent, restartable Linux user provisioning and its lifecycle state machine. */
import { AccountSuspendedError, CapacityError, ensureGitWorkspace, isolatedGitEnvironment, parseUserId,
  type GitRunner, type UserId } from '@public-harness/contracts'
import { deriveNames, ensureAccount, type AccountDirectory } from './accounts.ts'
import type { ProvisionerConfig } from './config.ts'
import { ensureStorage, layoutFor, type Ownership, type StorageLayout } from './storage.ts'
import { hostOwnership } from './storage.ts'
import type { Lifecycle, StateStore, UserState } from './state.ts'
import { KeyedLock, runChecked, type CommandRunner } from './system.ts'

/** What a caller learns about a provisioned user; every path is derived server-side. */
export interface UserRecord {
  readonly userId: UserId
  readonly account: string
  readonly container: string
  readonly uid: number
  readonly gid: number
  readonly lifecycle: Lifecycle
  readonly layout: StorageLayout
}

/** Collaborators; all host effects go through these. */
export interface UserProvisionerDeps {
  readonly config: ProvisionerConfig
  readonly store: StateStore
  readonly directory: AccountDirectory
  readonly runner: CommandRunner
  readonly ownership?: Ownership
  readonly clock?: () => number
  /** Override how Git runs inside a workspace (tests); production runs it as the service account. */
  readonly gitFor?: (account: string) => GitRunner
}

/** Lifecycle operations on stored user records. */
export interface UserProvisioner {
  ensureUser(userId: UserId): Promise<UserRecord>
  /** Record that the user's runtime stopped; stored data and the account remain. */
  stopUser(userId: UserId): Promise<void>
  beginStart(userId: UserId): Promise<UserRecord>
  markRunning(userId: UserId): Promise<void>
  markStopped(userId: UserId): Promise<void>
  get(userId: UserId): Promise<UserState | undefined>
  activeCount(): Promise<number>
  /** Serialize work for one user; used by the runtime service and lifecycle operations. */
  withUser<T>(userId: UserId, task: () => Promise<T>): Promise<T>
  readonly store: StateStore
  recordOf(state: UserState): UserRecord
  /** Layout for a stored state, available even before a uid is assigned. */
  recordOfLayout(state: UserState): StorageLayout
}

const ACTIVE: readonly Lifecycle[] = ['starting', 'running']

/** Build the provisioner. */
export function createUserProvisioner(deps: UserProvisionerDeps): UserProvisioner {
  const { config, store, directory, runner } = deps
  const now = deps.clock ?? Date.now
  const ownership = deps.ownership ?? hostOwnership
  const userLocks = new KeyedLock()
  const globalLock = new KeyedLock()
  const gitFor = deps.gitFor ?? ((account: string): GitRunner => (args, cwd) => runChecked(runner, config.tools.runuser,
    ['-u', account, '--', config.tools.env, '-i', ...Object.entries(isolatedGitEnvironment()).filter(([key]) => key !== 'HOME' && key !== 'PATH')
      .map(([key, value]) => `${key}=${value}`), 'PATH=/usr/bin:/bin', config.tools.git, ...args], { cwd }))

  const recordOf = (state: UserState): UserRecord => {
    if (state.uid === undefined || state.gid === undefined) throw new Error('user is not provisioned')
    const names = deriveNames(state.userId)
    return { userId: state.userId, account: state.account, container: names.container, uid: state.uid, gid: state.gid,
      lifecycle: state.lifecycle, layout: layoutFor(config.paths, state.account) }
  }
  const save = async (state: UserState): Promise<void> => { state.updatedAt = now(); await store.put(state) }
  const activeCount = async (): Promise<number> =>
    (await store.list()).records.filter(record => ACTIVE.includes(record.lifecycle)).length
  const requireState = async (userId: UserId): Promise<UserState> => {
    const state = await store.get(userId)
    if (state === undefined) throw new Error('unknown user')
    return state
  }
  const refuseInactive = (state: UserState): void => {
    if (state.lifecycle === 'suspended' || state.lifecycle === 'pending-deletion') throw new AccountSuspendedError()
  }

  async function provision(userId: UserId): Promise<UserState> {
    const account = deriveNames(userId).account
    let state = await store.get(userId)
    if (state === undefined) {
      await globalLock.run('capacity', async () => { if (await activeCount() >= config.maxActiveInstances) throw new CapacityError() })
      state = { version: 1, userId, account, lifecycle: 'provisioning', createdAt: now(), updatedAt: now(),
        steps: { account: false, storage: false, workspace: false } }
      await save(state)
    }
    refuseInactive(state)
    const layout = layoutFor(config.paths, account)
    let step = 'account'
    try {
      if (!state.steps.account || state.uid === undefined || state.gid === undefined) {
        const identity = await ensureAccount(directory, account, layout.podman, config.tools.nologin)
        state.uid = identity.uid; state.gid = identity.gid; state.steps.account = true
        await save(state)
      }
      step = 'storage'
      if (!state.steps.storage) {
        await ensureStorage(config.paths, layout, { uid: state.uid, gid: state.gid }, ownership)
        state.steps.storage = true
        await save(state)
      }
      step = 'workspace'
      if (!state.steps.workspace) {
        await ensureGitWorkspace(layout.workspace, gitFor(account))
        state.steps.workspace = true
        await save(state)
      }
    } catch (error) {
      // The record stays in `provisioning`: not routable, and the next call resumes at the failed step.
      state.lastError = `${step}-failed`
      state.lifecycle = 'provisioning'
      await save(state).catch(() => {})
      throw error
    }
    delete state.lastError
    if (state.lifecycle === 'provisioning') state.lifecycle = 'stopped'
    await save(state)
    return state
  }

  return {
    store, recordOf, activeCount,
    recordOfLayout: state => layoutFor(config.paths, state.account),
    withUser: (userId, task) => userLocks.run(deriveNames(userId).account, task),
    ensureUser: userId => userLocks.run(deriveNames(parseUserId(userId)).account, async () => recordOf(await provision(userId))),
    async stopUser(userId) {
      await userLocks.run(deriveNames(userId).account, async () => {
        const state = await store.get(userId)
        if (state === undefined) return
        if (ACTIVE.includes(state.lifecycle)) { state.lifecycle = 'stopped'; await save(state) }
      })
    },
    async beginStart(userId) {
      return globalLock.run('capacity', async () => {
        const state = await requireState(userId)
        refuseInactive(state)
        if (state.lifecycle === 'provisioning') throw new Error('user is not fully provisioned')
        if (!ACTIVE.includes(state.lifecycle)) {
          if (await activeCount() >= config.maxActiveInstances) throw new CapacityError()
          state.lifecycle = 'starting'
          await save(state)
        }
        return recordOf(state)
      })
    },
    async markRunning(userId) {
      const state = await requireState(userId)
      refuseInactive(state)
      state.lifecycle = 'running'; state.lastActiveAt = now()
      await save(state)
    },
    async markStopped(userId) {
      const state = await store.get(userId)
      if (state !== undefined && ACTIVE.includes(state.lifecycle)) { state.lifecycle = 'stopped'; await save(state) }
    },
    get: userId => store.get(userId),
  }
}
