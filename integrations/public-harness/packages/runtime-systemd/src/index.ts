/** Native systemd provider for the shared runtime capability; registration and live resources have disposable ownership. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { InstanceRuntime, RuntimeInstance } from '@public-harness/contracts'
import { createFileStateStore, type StateStore } from '@public-harness/provisioner/state'
import { createCommandRunner } from '@public-harness/provisioner/system'
import { parseSystemdConfig, type SystemdConfig } from './config.ts'
import { createSystemdRuntime, type SystemdRuntimeDeps } from './runtime.ts'
import { validateNativeAssets } from './storage.ts'

/** Common provisioner settings plus the native companion file, and the explicit collaborators. */
export interface SystemdProviderOptions extends Omit<SystemdRuntimeDeps, 'config' | 'runner' | 'claimedPorts' | 'acquired' | 'active' | 'socketGid'> {
  readonly common: unknown
  readonly native: unknown
  readonly runner?: SystemdRuntimeDeps['runner']
  readonly store?: StateStore
}
/** Adapter with an awaited shutdown for its owning Cordis effect. */
export interface SystemdInstanceRuntime extends InstanceRuntime {
  readonly config: SystemdConfig
  close(): Promise<void>
}

/** Create the adapter without registering it or touching the host; an invalid configuration rejects before side effects. */
export function createSystemdInstanceRuntime(options: SystemdProviderOptions): SystemdInstanceRuntime {
  const config = parseSystemdConfig({ common: options.common, native: options.native })
  const common = options.common as { socketGid: number }
  const store = options.store ?? createFileStateStore(config.paths.stateDir)
  const records = async () => {
    const { records, invalid } = await store.list()
    if (invalid.length) throw new Error('invalid state records prevent safe native allocation')
    return records.filter(state => state.runtime.kind === 'systemd')
  }
  const core = createSystemdRuntime({ ...options, config, runner: options.runner ?? createCommandRunner(), socketGid: common.socketGid,
    claimedPorts: async () => (await records()).flatMap(state => !state.acquired.includes('network') ? []
      : state.instance !== null ? [state.instance.webPort] : state.pending?.webPort === undefined ? [] : [state.pending.webPort]),
    active: async () => (await records()).flatMap(state => state.instance !== null && state.acquired.includes('network') ? [state.instance] : []),
    acquired: async (userId, instanceId, resource, ports) => {
      const state = await store.get(userId)
      if (state === undefined || state.runtime.kind !== 'systemd'
        || (state.pending?.instanceId ?? state.instance?.instanceId) !== instanceId) throw new Error('allocation does not match durable launch')
      if (!state.acquired.includes(resource)) state.acquired.push(resource)
      if (state.pending !== undefined && ports !== undefined) state.pending = { ...state.pending, ...ports }
      await store.put(state)
    } })
  const native = (instance: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>) => {
    if (instance.runtime.kind !== 'systemd') throw new Error('instance backend does not match native provider')
    return instance
  }
  return {
    kind: 'systemd', config,
    allocate: request => core.allocate(native(request)),
    prepare: instance => core.prepare(native(instance) as RuntimeInstance),
    initializeWorkspace: instance => core.initializeWorkspace(native(instance) as RuntimeInstance),
    start: instance => core.start(native(instance) as RuntimeInstance),
    launchGrant: instance => core.launchGrant(native(instance)),
    stop: instance => core.stop(native(instance)),
    releaseAllocation: request => core.releaseAllocation(native(request)),
    state: instance => core.state(native(instance)),
    close: () => core.close(),
  }
}

/** Stable provider plugin name. */
export const name = 'public-harness-systemd-runtime'
/** Validate root-owned assets, then register exactly one runtime and await its cleanup on disposal.
 * @param ctx Owning Cordis plugin context.
 * @param options Native selection and explicit collaborators.
 */
export async function apply(ctx: Context, options: SystemdProviderOptions): Promise<void> {
  const runtime = createSystemdInstanceRuntime(options)
  await validateNativeAssets(runtime.config)
  const owner = ctx as Context & Pick<Fiber, 'effect'>
  owner.effect(() => ctx.reflect.provide('instanceRuntime', runtime), 'public-harness.instanceRuntime')
  owner.effect(() => async () => { await runtime.close() }, 'public-harness.systemdRuntime.close')
}
