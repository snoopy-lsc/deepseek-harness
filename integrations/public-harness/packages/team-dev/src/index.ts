/** Cordis application plugin for the local-only multi-user development profile. */
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseUserId, type UserId } from '@public-harness/contracts'
import { createDevInstanceManager } from '@public-harness/dev-runtime'
import { createDevelopmentIdentity } from '@public-harness/router/dev-identity'
import { createOwnerRouter } from '@public-harness/router/routes'
import { createBrowserLaunch } from '@public-harness/router/launch'
import { startRouterServer } from '@public-harness/router/server'

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
  readonly launchExchangeMs: number
  readonly socketLifetimeMs: number
  readonly cookieLifetimeMs: number
}

/** Parse required profile settings before any listener or child starts. */
export const Config: z<TeamDevConfig> = z.object({
  host: z.string().required(), storageRoot: z.string().required(), webPatch: z.string().required(),
  command: z.string().required(), args: z.array(z.string()).required(), users: z.array(z.string()).required(),
  startupTimeoutMs: z.number().step(1).min(1).required(),
  stopTimeoutMs: z.number().step(1).min(1).required(),
  routeWaitMs: z.number().step(1).min(1).required(),
  launchExchangeMs: z.number().step(1).min(1).required(),
  socketLifetimeMs: z.number().step(1).min(1).required(),
  cookieLifetimeMs: z.number().step(1).min(1).required(),
})

/** Enforce loopback, private paths, fixed users, and positive bounded waits. */
export function validateTeamDevConfig(config: TeamDevConfig): UserId[] {
  if (config.host !== '127.0.0.1') throw new Error('team-dev requires loopback')
  for (const path of [config.storageRoot, config.webPatch, config.command]) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('team-dev paths must be absolute')
  }
  if (config.args.length === 0) throw new Error('team-dev dsh command arguments are required')
  const users = config.users.map(parseUserId)
  if (users.length === 0 || new Set(users).size !== users.length) throw new Error('fixed test users are required')
  for (const [name, value] of Object.entries(config).filter(([name]) => name.endsWith('Ms'))) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be positive`)
  }
  if (config.socketLifetimeMs > 60_000) throw new Error('socket lifetime exceeds 60 seconds')
  if (config.cookieLifetimeMs > 3_600_000) throw new Error('test cookie lifetime exceeds one hour')
  return users
}

/** Stable plugin name. */
export const name = 'public-harness-team-dev'

/** Start the local browser entry and the lazy per-user Harness supervisor. */
export async function apply(ctx: Context, config: TeamDevConfig): Promise<void> {
  const users = validateTeamDevConfig(config)
  const manager = createDevInstanceManager({ mode: 'development', host: '127.0.0.1',
    storageRoot: config.storageRoot, webPatch: config.webPatch, command: config.command,
    args: [...config.args], users, startupTimeoutMs: config.startupTimeoutMs,
    stopTimeoutMs: config.stopTimeoutMs })
  const identity = createDevelopmentIdentity({ mode: 'team-dev', host: '127.0.0.1',
    secret: randomBytes(32), testUsers: users, lifetimeMs: config.cookieLifetimeMs })
  let entry: Awaited<ReturnType<typeof startRouterServer>>
  try {
    entry = await startRouterServer({ host: config.host, identity,
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
