/** Cordis application plugin for the local-only multi-user development profile. */
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseUserId, type UserId } from '@public-harness/contracts'
import { createDevInstanceManager, validateDevUsers } from '@public-harness/dev-runtime'
import { createDevelopmentIdentity } from '@public-harness/router/dev-identity'
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
  const managers = new Map(users.map(userId => [userId, createDevInstanceManager({
    mode: 'development', host: '127.0.0.1', storageRoot: config.storageRoot,
    webPatch: quota.patches.get(userId)!, command: config.command,
    args: [...config.args], users: [userId], startupTimeoutMs: config.startupTimeoutMs,
    stopTimeoutMs: config.stopTimeoutMs,
  })]))
  const manager = {
    ensure: (userId: UserId) => requireManager(userId).ensure(userId),
    launchGrant: (userId: UserId) => requireManager(userId).launchGrant(userId),
    stop: (userId: UserId) => requireManager(userId).stop(userId),
    close: async () => {
      const outcomes = await Promise.allSettled([...managers.values()].map(instance => instance.close()))
      await quota.close()
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'failed to stop development users')
    },
  }
  function requireManager(userId: UserId) {
    const instance = managers.get(userId)
    if (instance === undefined) throw new Error('unknown development test user')
    return instance
  }
  const identity = createDevelopmentIdentity({ mode: 'team-dev', host: '127.0.0.1',
    secret: randomBytes(32), testUsers: users, lifetimeMs: config.cookieLifetimeMs })
  let entry: Awaited<ReturnType<typeof startRouterServer>>
  try {
    entry = await startRouterServer({ retryAfterSeconds: config.retryAfterSeconds, host: config.host, identity,
      ownerRouter: createOwnerRouter({ instanceManager: manager,
        isActive: async userId => users.includes(userId), hasCapacity: async () => true,
        maxWaitMs: config.routeWaitMs }),
      launch: createBrowserLaunch({ instanceManager: manager, maxExchangeMs: config.launchExchangeMs }),
      maxSocketLifetimeMs: config.socketLifetimeMs,
      developmentSelector: { users, issue: userId => identity.issue(userId) } })
  } catch (error) { await manager.close(); throw error }
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await entry.close(); await manager.close() }, 'public-harness.team-dev')
  process.stdout.write(`team-dev: http://127.0.0.1:${entry.port}/dev\n`)
}
