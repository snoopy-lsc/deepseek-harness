/** Container provider for the shared runtime capability; registration and process resources have disposable ownership. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { ensureGitWorkspace, isolatedGitEnvironment, type GitRunner, type InstanceRuntime, type RuntimeInstance } from '@public-harness/contracts'
import { resolveContainerConfig, validateProvisionerConfig, type ProvisionerConfig } from './config.ts'
import { createRuntime, type RuntimeDeps } from './runtime.ts'
import { createFileStateStore, type StateStore } from './state.ts'
import { layoutFor } from './storage.ts'
import { createCommandRunner, runChecked } from './system.ts'
import type { UserRecord } from './users.ts'

/** Explicit collaborators for the container adapter. */
export interface ContainerProviderOptions extends Omit<RuntimeDeps, 'config' | 'runner' | 'acquired' | 'claimedPorts'> {
  readonly config: ProvisionerConfig
  readonly runner?: RuntimeDeps['runner']
  readonly store?: StateStore
  readonly gitFor?: (account: string) => GitRunner
}
/** Adapter with an awaited shutdown for its owning Cordis effect. */
export interface ContainerInstanceRuntime extends InstanceRuntime {
  /** Withdraw fresh and resumed allocations owned before their host effects; observations cannot replace launch ownership.
   * @returns Resolves after verified cleanup; failed resources remain recorded.
   */
  close(): Promise<void>
}

/** Create an adapter without registering it or touching the host.
 * @param options Container selection and injected host collaborators.
 * @returns Container runtime; an absent/mismatched selection rejects before side effects.
 */
export function createContainerInstanceRuntime(options: ContainerProviderOptions): ContainerInstanceRuntime {
  const common = validateProvisionerConfig(options.config), config = resolveContainerConfig(common)
  const runner = options.runner ?? createCommandRunner(), store = options.store ?? createFileStateStore(common.paths.stateDir)
  const allocations = new Map<RuntimeInstance['userId'], Omit<RuntimeInstance, 'webPort' | 'quotaPort'>>()
  const recordOf = (instance: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>): UserRecord => {
    if (instance.runtime.kind !== 'podman-gvisor') throw new Error('instance backend does not match container provider')
    return { userId: instance.userId, account: instance.account, container: instance.runtime.container, uid: instance.uid, gid: instance.gid,
      layout: layoutFor(config.paths, instance.account), lifecycle: 'starting' }
  }
  const own = (instance: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>): UserRecord => {
    const record = recordOf(instance)
    const current = allocations.get(instance.userId)
    if (current !== undefined && current.instanceId !== instance.instanceId) throw new Error('instance does not match owned launch')
    allocations.set(instance.userId, instance)
    return record
  }
  const runtime = createRuntime({ ...options, config, runner, claimedPorts: async () => {
    const { records, invalid } = await store.list()
    if (invalid.length) throw new Error('invalid state records prevent safe port allocation')
    return records.flatMap(state => state.runtime.kind === 'podman-gvisor' && state.acquired.includes('network')
      ? state.instance !== null ? [state.instance.webPort] : state.pending?.webPort === undefined ? [] : [state.pending.webPort] : [])
  }, acquired: async (userId, instanceId, resource, ports) => {
    const state = await store.get(userId)
    if (state === undefined || state.runtime.kind !== 'podman-gvisor'
      || (state.pending?.instanceId ?? state.instance?.instanceId) !== instanceId) throw new Error('allocation does not match durable launch')
    if (!state.acquired.includes(resource)) state.acquired.push(resource)
    if (state.pending !== undefined && ports !== undefined) state.pending = { ...state.pending, ...ports }
    await store.put(state)
  } })
  const gitFor = options.gitFor ?? ((account: string): GitRunner => (args, cwd) => runChecked(runner, config.tools.runuser,
    ['-u', account, '--', config.tools.env, '-i', ...Object.entries(isolatedGitEnvironment()).filter(([key]) => key !== 'HOME' && key !== 'PATH')
      .map(([key, value]) => `${key}=${value}`), 'PATH=/usr/bin:/bin', config.tools.git, ...args], { cwd }))
  const releaseAllocation = async (request: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>): Promise<void> => {
    const state = await store.get(request.userId)
    const id = state?.pending?.instanceId ?? state?.instance?.instanceId
    if (id !== undefined && id !== request.instanceId) throw new Error('cleanup does not match durable launch')
    await runtime.stop(own(request))
    if (allocations.get(request.userId)?.instanceId === request.instanceId) allocations.delete(request.userId)
  }
  return {
    kind: 'podman-gvisor',
    async allocate(request) {
      const record = own(request)
      const ports = await runtime.allocate(record, request.instanceId)
      return { ...request, ...ports }
    },
    prepare: instance => runtime.prepare(own(instance)),
    initializeWorkspace: instance => { own(instance); return ensureGitWorkspace(instance.workspace, gitFor(instance.account)) },
    start: instance => runtime.start(own(instance), instance),
    launchGrant: instance => runtime.launchGrant(recordOf(instance)),
    stop: releaseAllocation, releaseAllocation,
    state: instance => runtime.state(recordOf(instance)),
    async close() {
      const results = await Promise.allSettled([...allocations.values()].map(releaseAllocation))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'container provider shutdown failed')
    },
  }
}
/** Stable provider plugin name. */
export const name = 'public-harness-container-runtime'
/** Register exactly one runtime and await its resource cleanup on disposal.
 * @param ctx Owning Cordis plugin context.
 * @param options Container selection and explicit collaborators.
 * @returns Registration is immediate; conflicting ownership throws.
 */
export function apply(ctx: Context, options: ContainerProviderOptions): void {
  const runtime = createContainerInstanceRuntime(options)
  const owner = ctx as Context & Pick<Fiber, 'effect'>
  owner.effect(() => ctx.reflect.provide('instanceRuntime', runtime), 'public-harness.instanceRuntime')
  owner.effect(() => async () => { await runtime.close() }, 'public-harness.containerRuntime.close')
}
