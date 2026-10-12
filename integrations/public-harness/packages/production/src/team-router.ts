/** Production router profile: authentik-signed identity, Linux provisioner, Unix-socket ingress. Never loads development identity. */
import { readFile } from 'node:fs/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { InstanceManager, UserId } from '@public-harness/contracts'
import { connectProvisioner } from '@public-harness/provisioner-client'
import { createProductionIdentity } from '@public-harness/router/identity'
import { createNativeIdentity, NATIVE_SESSION_COOKIES } from '@public-harness/router/native-identity'
import { createBrowserLaunch } from '@public-harness/router/launch'
import { createOwnerRouter } from '@public-harness/router/routes'
import { startRouterHealthServer } from '@public-harness/router/health'
import { startRouterServer, type RouterServerConfig } from '@public-harness/router/server'
import { absolutePath, exactRecord, positiveInt, readConfigFile } from './config-file.ts'

/** Everything the production router needs; secrets are file references only. */
export interface TeamRouterConfig {
  /** Exact browser-facing authority (`host[:port]`); other Host values are refused. */
  readonly publicAuthority: string
  readonly routerSocket: string
  /** Group id of the Caddy service account; the only account besides the router that may connect. */
  readonly routerSocketGid: number
  readonly healthSocket: string
  readonly provisionerSocket: string
  /** How long one provisioner `ensure` may take (a cold start may load the image archive); at least `routeWaitMs`. */
  readonly provisionerEnsureTimeoutMs: number
  /** Explicitly tagged identity mode; an untagged record is authentik for existing configurations. Modes never mix. */
  readonly identity: { readonly kind?: 'authentik'; readonly issuer: string; readonly audience: string; readonly publicKeyFiles: Readonly<Record<string, string>> }
    | { readonly kind: 'better-auth'; readonly sessionSocket: string; readonly timeoutMs: number; readonly maxResponseBytes: number; readonly sessionRecheckMs: number }
  readonly routeWaitMs: number
  readonly retryAfterSeconds: number
  readonly launchExchangeMs: number
  readonly socketLifetimeMs: number
  readonly maxRequestBodyBytes: number
  readonly maxHeaderBytes: number
}

/** Parse and validate the production router file strictly: unknown or missing keys are errors. */
export function parseTeamRouterConfig(value: unknown): TeamRouterConfig {
  const record = exactRecord(value, ['publicAuthority', 'routerSocket', 'routerSocketGid', 'healthSocket', 'provisionerSocket', 'provisionerEnsureTimeoutMs', 'identity',
    'routeWaitMs', 'retryAfterSeconds', 'launchExchangeMs', 'socketLifetimeMs', 'maxRequestBodyBytes', 'maxHeaderBytes'], 'team-router configuration')
  const tagged = record.identity as { kind?: unknown } | null
  let parsedIdentity: TeamRouterConfig['identity']
  if (tagged !== null && typeof tagged === 'object' && tagged.kind === 'better-auth') {
    const native = exactRecord(record.identity, ['kind', 'sessionSocket', 'timeoutMs', 'maxResponseBytes', 'sessionRecheckMs'], 'identity')
    parsedIdentity = { kind: 'better-auth', sessionSocket: absolutePath(native.sessionSocket, 'identity.sessionSocket'), timeoutMs: positiveInt(native.timeoutMs, 'identity.timeoutMs'),
      maxResponseBytes: positiveInt(native.maxResponseBytes, 'identity.maxResponseBytes'), sessionRecheckMs: positiveInt(native.sessionRecheckMs, 'identity.sessionRecheckMs') }
  } else {
    const keys = tagged !== null && typeof tagged === 'object' && 'kind' in tagged ? ['kind', 'issuer', 'audience', 'publicKeyFiles'] : ['issuer', 'audience', 'publicKeyFiles']
    if (keys.length === 4 && tagged!.kind !== 'authentik') throw new Error('identity kind must be authentik or better-auth')
    const identity = exactRecord(record.identity, keys, 'identity')
    const files = exactRecord(identity.publicKeyFiles, Object.keys(identity.publicKeyFiles as object), 'publicKeyFiles')
    if (Object.keys(files).length === 0) throw new Error('at least one identity public key file is required')
    for (const [kid, path] of Object.entries(files)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(kid)) throw new Error('identity key ID is invalid')
      absolutePath(path, `publicKeyFiles.${kid}`)
    }
    if (typeof identity.issuer !== 'string' || new URL(identity.issuer).protocol !== 'https:') throw new Error('identity issuer must be an HTTPS URL')
    if (typeof identity.audience !== 'string' || !identity.audience) throw new Error('identity audience is required')
    parsedIdentity = { kind: 'authentik', issuer: identity.issuer, audience: identity.audience, publicKeyFiles: files as Record<string, string> }
  }
  if (typeof record.publicAuthority !== 'string' || !/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(record.publicAuthority)) {
    throw new Error('publicAuthority must be host or host:port')
  }
  // Browsers omit the default port, so a Host carrying :80 or :443 never arrives and every request would get 421.
  if (/:(?:80|443)$/.test(record.publicAuthority)) throw new Error('publicAuthority must omit the default port')
  const gid = record.routerSocketGid
  if (typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid < 0) throw new Error('routerSocketGid must be a group id')
  const socketLifetimeMs = positiveInt(record.socketLifetimeMs, 'socketLifetimeMs')
  const routeWaitMs = positiveInt(record.routeWaitMs, 'routeWaitMs')
  const provisionerEnsureTimeoutMs = positiveInt(record.provisionerEnsureTimeoutMs, 'provisionerEnsureTimeoutMs')
  // A shorter ensure would fail a start the router page is still waiting for, turning "starting" into a service error.
  if (provisionerEnsureTimeoutMs < routeWaitMs) throw new Error('provisionerEnsureTimeoutMs must be at least routeWaitMs')
  if (provisionerEnsureTimeoutMs > 3_600_000) throw new Error('provisionerEnsureTimeoutMs must be at most 3600000')
  if (socketLifetimeMs > 60_000) throw new Error('socketLifetimeMs must be at most 60000')
  return { publicAuthority: record.publicAuthority, routerSocket: absolutePath(record.routerSocket, 'routerSocket'), routerSocketGid: gid,
    healthSocket: absolutePath(record.healthSocket, 'healthSocket'), provisionerSocket: absolutePath(record.provisionerSocket, 'provisionerSocket'),
    provisionerEnsureTimeoutMs,
    identity: parsedIdentity,
    routeWaitMs, retryAfterSeconds: positiveInt(record.retryAfterSeconds, 'retryAfterSeconds'),
    launchExchangeMs: positiveInt(record.launchExchangeMs, 'launchExchangeMs'), socketLifetimeMs,
    maxRequestBodyBytes: positiveInt(record.maxRequestBodyBytes, 'maxRequestBodyBytes'), maxHeaderBytes: positiveInt(record.maxHeaderBytes, 'maxHeaderBytes') }
}

/** Injectable collaborators so wiring can be tested without sockets or key files. */
export interface TeamRouterDeps {
  readonly manager?: InstanceManager
  readonly isActive?: (userId: UserId) => Promise<boolean>
  readonly readKey?: (path: string) => Promise<string>
  readonly clock?: () => Date
}

/** Compose the production router configuration: signed identity, provisioner-backed routing, Secure cookies, Unix ingress. */
export async function buildTeamRouterServerConfig(config: TeamRouterConfig, deps: TeamRouterDeps = {}): Promise<RouterServerConfig> {
  const connected = deps.manager === undefined || deps.isActive === undefined ? connectProvisioner(config.provisionerSocket, { ensureTimeoutMs: config.provisionerEnsureTimeoutMs }) : undefined
  const manager = deps.manager ?? connected!.manager
  const isActive = deps.isActive ?? connected!.isActive
  const read = deps.readKey ?? (path => readFile(path, 'utf8'))
  let identity: RouterServerConfig['identity']
  let native: Pick<RouterServerConfig, 'sessionRecheckMs' | 'stripCookies'> = {}
  if (config.identity.kind === 'better-auth') {
    identity = createNativeIdentity({ socketPath: config.identity.sessionSocket, timeoutMs: config.identity.timeoutMs, maxResponseBytes: config.identity.maxResponseBytes, isActive })
    // The account session cookie authenticates to the router only; instances never receive it.
    native = { sessionRecheckMs: config.identity.sessionRecheckMs, stripCookies: ['team_dev', ...NATIVE_SESSION_COOKIES] }
  } else {
    const publicKeys: Record<string, string> = {}
    for (const [kid, path] of Object.entries(config.identity.publicKeyFiles)) publicKeys[kid] = await read(path)
    identity = createProductionIdentity({ issuer: config.identity.issuer, audience: config.identity.audience, publicKeys, isActive, clock: deps.clock })
  }
  return { ...native,
    listen: { kind: 'unix', path: config.routerSocket, gid: config.routerSocketGid }, secureCookies: true,
    publicAuthority: config.publicAuthority, identity, retryAfterSeconds: config.retryAfterSeconds,
    maxSocketLifetimeMs: config.socketLifetimeMs, maxRequestBodyBytes: config.maxRequestBodyBytes, maxHeaderBytes: config.maxHeaderBytes,
    // Admission is authoritative in the provisioner (typed CapacityError); a router-side count would drift when instances idle-stop.
    ownerRouter: createOwnerRouter({ instanceManager: manager, isActive, hasCapacity: async () => true, maxWaitMs: config.routeWaitMs }),
    launch: createBrowserLaunch({ instanceManager: manager, maxExchangeMs: config.launchExchangeMs }),
  }
}

/** Start the production router and its private health socket. */
export async function startTeamRouter(config: TeamRouterConfig, deps: TeamRouterDeps = {}): Promise<{ close(): Promise<void> }> {
  const server = await startRouterServer(await buildTeamRouterServerConfig(config, deps))
  let health: Awaited<ReturnType<typeof startRouterHealthServer>>
  try {
    health = await startRouterHealthServer(config.healthSocket, async () => {
      const { createConnection } = await import('node:net')
      const reachable = await new Promise<boolean>(resolve => {
        const socket = createConnection(config.provisionerSocket)
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })
      return { ok: reachable }
    })
  } catch (error) { await server.close(); throw error }
  return { async close() { await health.close(); await server.close() } }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-team-router'

/** The profile points at one root-owned JSON file. */
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile team-router`. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const running = await startTeamRouter(parseTeamRouterConfig(await readConfigFile(config.configFile)))
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await running.close() }, 'public-harness.team-router')
}
