/** Cordis application plugin for the local-only multi-user development profile. */
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MIN_IDLE_MS, parseUserId, startIdleReaper, validateIdleMs, type UserId } from '@public-harness/contracts'
import { createDevInstanceManager, validateDevUsers } from '@public-harness/dev-runtime'
import { createDevelopmentIdentity } from '@public-harness/router/dev-identity'
import { createAdmission } from '@public-harness/router/admission'
import { createOwnerRouter } from '@public-harness/router/routes'
import { createBrowserLaunch } from '@public-harness/router/launch'
import { startRouterServer } from '@public-harness/router/server'
import { startTeamDevQuota, validateStorageLockConfig, type TeamDevQuotaConfig, type StorageLockConfig } from './quota.ts'

/** Paths and limits for a development server with fixed local test users. */
export interface TeamDevConfig {
  readonly host: string
  readonly storageRoot: string
  readonly webPatch: string
  readonly command: string
  readonly args: string[]
  readonly users: string[]
  /** Most users that may hold a running instance at once; further first requests get the capacity page. */
  readonly maxActiveInstances: number
  /** A running instance with no routed request for this long is stopped and wakes on the next request. */
  readonly idleStopMs: number
  readonly startupTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly routeWaitMs: number
  readonly retryAfterSeconds: number
  readonly launchExchangeMs: number
  readonly socketLifetimeMs: number
  readonly cookieLifetimeMs: number
  readonly quota: TeamDevQuotaConfig
  readonly storageLock: StorageLockConfig
}

/** Parse required profile settings before any listener or child starts. */
export const Config: z<TeamDevConfig> = z.object({
  host: z.string().required(), storageRoot: z.string().required(), webPatch: z.string().required(),
  command: z.string().required(), args: z.array(z.string()).required(), users: z.array(z.string()).required(),
  maxActiveInstances: z.number().step(1).min(1).required(),
  idleStopMs: z.number().step(1).min(MIN_IDLE_MS).required(),
  startupTimeoutMs: z.number().step(1).min(1).required(),
  stopTimeoutMs: z.number().step(1).min(1).required(),
  retryAfterSeconds: z.number().step(1).min(1).required(),
  routeWaitMs: z.number().step(1).min(1).required(),
  launchExchangeMs: z.number().step(1).min(1).required(),
  socketLifetimeMs: z.number().step(1).min(1).required(),
  cookieLifetimeMs: z.number().step(1).min(1).required(),
  quota: z.object({
    modelId: z.string().required(), contextWindow: z.number().step(1).min(1).required(),
    maxTokens: z.number().step(1).min(1).required(),
    personalDailyTokens: z.number().step(1).min(1).required(),
    siteDailyTokens: z.number().step(1).min(1).required(),
    personalConcurrency: z.number().step(1).min(1).required(),
    siteConcurrency: z.number().step(1).min(1).required(),
    busyTimeoutMs: z.number().step(1).min(1).required(),
    maxBodyBytes: z.number().step(1).min(1).required(),
    maxImagesPerRequest: z.number().step(1).min(1).required(),
    maxInlineImageBytes: z.number().step(1).min(1).required(),
    maxEventBytes: z.number().step(1).min(1).required(),
    maxFileBodyBytes: z.number().step(1).min(1).required(),
    credentialLifetimeMs: z.number().step(1).min(1).required(),
    credentialRotateMs: z.number().step(1).min(1).required(),
    upstream: z.object({ root: z.string(), keyEnv: z.string() }),
  }).required(),
  storageLock: z.object({ staleMs: z.number().step(1).min(5000).required(),
    updateMs: z.number().step(1).min(1000).required() }).required(),
})

/** Enforce loopback, private paths, fixed users, and positive bounded waits. */
export function validateTeamDevConfig(config: TeamDevConfig): UserId[] {
  if (config.host !== '127.0.0.1') throw new Error('team-dev requires loopback')
  for (const path of [config.storageRoot, config.webPatch, config.command]) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('team-dev paths must be absolute')
  }
  if (config.args.length === 0) throw new Error('team-dev dsh command arguments are required')
  const users = config.users.map(parseUserId)
  validateDevUsers(users)
  validateStorageLockConfig(config.storageLock)
  if (!Number.isSafeInteger(config.maxActiveInstances) || config.maxActiveInstances <= 0
    || config.maxActiveInstances > users.length) throw new Error('active-instance cap must be between one and the number of users')
  validateIdleMs(config.idleStopMs)
  for (const [name, value] of Object.entries(config).filter(([name]) => name.endsWith('Ms'))) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be positive`)
  }
  if (config.socketLifetimeMs > 60_000) throw new Error('socket lifetime exceeds 60 seconds')
  if (config.cookieLifetimeMs > 3_600_000) throw new Error('test cookie lifetime exceeds one hour')
  const bound = config.quota.contextWindow + config.quota.maxTokens
  if (!Number.isSafeInteger(bound) || bound > config.quota.personalDailyTokens
    || bound > config.quota.siteDailyTokens) throw new Error('quota budget must admit one model request')
  if (config.quota.credentialLifetimeMs > 900_000
    || config.quota.credentialRotateMs >= config.quota.credentialLifetimeMs) {
    throw new Error('quota credential rotation must precede fifteen-minute expiry')
  }
  return users
}

/** Stable plugin name. */
export const name = 'public-harness-team-dev'

/** Start the local browser entry and the lazy per-user Harness supervisor. */
export async function apply(ctx: Context, config: TeamDevConfig): Promise<void> {
  const users = validateTeamDevConfig(config)
  const quota = await startTeamDevQuota({ storageRoot: config.storageRoot,
    baseWebPatch: config.webPatch, users, config: config.quota, storageLock: config.storageLock })
  const runtime = createDevInstanceManager({
    mode: 'development', host: '127.0.0.1', storageRoot: config.storageRoot,
    webPatch: userId => quota.patches.get(userId)!, command: config.command,
    args: [...config.args], users, maxActive: config.maxActiveInstances,
    startupTimeoutMs: config.startupTimeoutMs, stopTimeoutMs: config.stopTimeoutMs,
  })
  const manager = {
    ensure: (userId: UserId) => runtime.ensure(userId),
    launchGrant: (userId: UserId) => runtime.launchGrant(userId),
    stop: (userId: UserId) => runtime.stop(userId),
    close: async () => {
      const outcomes = await Promise.allSettled([runtime.close()])
      await quota.close()
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'failed to stop development users')
    },
  }
  const admission = createAdmission({ maxActive: config.maxActiveInstances, active: () => runtime.active() })
  const stopReaper = startIdleReaper({ tracker: runtime.tracker, running: () => runtime.active(), stop: userId => runtime.stop(userId),
    idleMs: config.idleStopMs, intervalMs: Math.min(60_000, Math.max(1000, Math.floor(config.idleStopMs / 4))),
    onError: () => { process.stderr.write('team-dev: idle stop failed\n') } })
  const identity = createDevelopmentIdentity({ mode: 'team-dev', host: '127.0.0.1',
    secret: randomBytes(32), testUsers: users, lifetimeMs: config.cookieLifetimeMs })
  let entry: Awaited<ReturnType<typeof startRouterServer>>
  try {
    entry = await startRouterServer({ retryAfterSeconds: config.retryAfterSeconds, host: config.host, identity,
      ownerRouter: createOwnerRouter({ instanceManager: manager,
        isActive: async userId => runtime.isActive(userId), hasCapacity: userId => admission.hasCapacity(userId),
        maxWaitMs: config.routeWaitMs }),
      launch: createBrowserLaunch({ instanceManager: manager, maxExchangeMs: config.launchExchangeMs }),
      maxSocketLifetimeMs: config.socketLifetimeMs,
      developmentSelector: { users, issue: userId => identity.issue(userId) } })
  } catch (error) { stopReaper(); await manager.close(); throw error }
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { stopReaper(); await entry.close(); await manager.close() }, 'public-harness.team-dev')
  process.stdout.write(`team-dev: http://127.0.0.1:${entry.port}/dev\n`)
}
