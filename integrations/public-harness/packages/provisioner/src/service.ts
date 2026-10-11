/** Composition: the four router-facing operations plus administrative lifecycle control. */
import { AccountSuspendedError, createActivityTracker, parseUserId, type ActivityTracker, type InstanceEndpoint, type UserId } from '@public-harness/contracts'
import { createAccountDirectory, type AccountDirectory } from './accounts.ts'
import { validateProvisionerConfig, type ProvisionerConfig } from './config.ts'
import { createLifecycle, type Lifecycle } from './reconcile.ts'
import { createRuntime, type QuotaBridge, type Runtime } from './runtime.ts'
import { createFileStateStore, type StateStore } from './state.ts'
import { createCommandRunner, type CommandRunner } from './system.ts'
import type { EnforcementProbe } from './limits.ts'
import type { ProvisionerHandler } from './protocol.ts'
import { createUserProvisioner, type UserProvisioner } from './users.ts'

/** Collaborators with production defaults; tests inject fakes for every host effect. */
export interface ProvisionerServiceOptions {
  readonly config: ProvisionerConfig
  readonly quota: QuotaBridge
  readonly probe: EnforcementProbe
  readonly publicHost: string
  readonly runner?: CommandRunner
  readonly directory?: AccountDirectory
  readonly store?: StateStore
  readonly runtime?: Runtime
  readonly users?: UserProvisioner
  readonly tracker?: ActivityTracker
  readonly clock?: () => number
  /** How long a successful container check is trusted (default 5 s). */
  readonly livenessTtlMs?: number
}

/** The running service. */
export interface ProvisionerService {
  readonly handler: ProvisionerHandler
  readonly lifecycle: Lifecycle
  readonly tracker: ActivityTracker
}

/** Wire the provisioner. Configuration is validated first; nothing touches the host before that. */
export function createProvisionerService(options: ProvisionerServiceOptions): ProvisionerService {
  const config = validateProvisionerConfig(options.config)
  const runner = options.runner ?? createCommandRunner()
  const directory = options.directory ?? createAccountDirectory(runner, config.tools)
  const store = options.store ?? createFileStateStore(config.paths.stateDir)
  const tracker = options.tracker ?? createActivityTracker(options.clock)
  const users = options.users ?? createUserProvisioner({ config, store, directory, runner, clock: options.clock })
  const runtime = options.runtime ?? createRuntime({ config, runner, quota: options.quota, probe: options.probe,
    publicHost: options.publicHost, clock: options.clock })
  const endpoints = new Map<UserId, InstanceEndpoint>()
  const lifecycle = createLifecycle({ users, runtime, tracker, config, directory, endpoints, clock: options.clock, livenessTtlMs: options.livenessTtlMs })

  async function ensure(userId: UserId): Promise<InstanceEndpoint> {
    const cached = endpoints.get(userId)
    if (cached !== undefined && !await lifecycle.reapIfDead(userId)) { tracker.touch(userId); return cached }
    await users.ensureUser(userId)
    return users.withUser(userId, async () => {
      const known = endpoints.get(userId)
      if (known !== undefined) return known
      const current = await users.get(userId)
      if (current === undefined) throw new Error('unknown user')
      if (current.lifecycle === 'suspended' || current.lifecycle === 'pending-deletion') throw new AccountSuspendedError()
      const record = await users.beginStart(userId)
      try {
        const endpoint = await runtime.start(record)
        await users.markRunning(userId)
        endpoints.set(userId, endpoint)
        tracker.touch(userId)
        return endpoint
      } catch (error) {
        await users.markStopped(userId).catch(() => {})
        throw error
      }
    })
  }

  const handler: ProvisionerHandler = async request => {
    const userId = parseUserId(request.userId)
    switch (request.op) {
      case 'ensure': return ensure(userId)
      case 'launch-grant': {
        const state = await users.get(userId)
        if (state === undefined || state.lifecycle !== 'running') throw new Error('instance is not running')
        return runtime.launchGrant(users.recordOf(state))
      }
      case 'stop':
        await users.withUser(userId, async () => {
          const state = await users.get(userId)
          endpoints.delete(userId); tracker.forget(userId)
          if (state !== undefined && state.uid !== undefined) await runtime.stop(users.recordOf(state))
          // Already inside the per-user lock: `stopUser` would wait on that same lock forever.
          await users.markStopped(userId)
        })
        return null
      case 'status':
        // Never report `running` for a container that died out of band (OOM, kill): verify, clean up, then answer.
        await lifecycle.reapIfDead(userId)
        return (await users.get(userId))?.lifecycle ?? 'absent'
    }
  }
  return { handler, lifecycle, tracker }
}
