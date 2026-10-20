/** Local model fixture and per-user quota listeners for the development profile. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { platformModelRows, type UserId } from '@public-harness/contracts'
import { createQuotaLedger, type PersonalUsage } from '@public-harness/quota/ledger'
import { createTokenIssuer } from '@public-harness/quota/tokens'
import { createAdmission } from '@public-harness/quota/admission'
import { createMessagesForwarder } from '@public-harness/quota/messages'
import { startQuotaHttpServer } from '@public-harness/quota/server'
import type { QuotaAccountLedger } from '@public-harness/quota/account'
import { validateDevUsers } from '@public-harness/dev-runtime'
import lockfile from 'proper-lockfile'

/** Portable ownership lease settings for one development data root. */
export interface StorageLockConfig {
  readonly staleMs: number
  readonly updateMs: number
}

/** Validate the maintained lock provider's lease and heartbeat limits.
 * @param config - explicit development storage ownership timing.
 */
export function validateStorageLockConfig(config: StorageLockConfig): void {
  const { staleMs, updateMs } = config
  if (!Number.isSafeInteger(staleMs) || staleMs < 5000 || !Number.isSafeInteger(updateMs)
    || updateMs < 1000 || updateMs > staleMs / 2) throw new Error('invalid development storage lock timing')
}

/** Required development model and resource limits. */
export interface TeamDevQuotaConfig {
  readonly modelId: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly personalDailyTokens: number
  readonly siteDailyTokens: number
  readonly personalConcurrency: number
  readonly siteConcurrency: number
  readonly busyTimeoutMs: number
  readonly maxBodyBytes: number
  readonly maxImagesPerRequest: number
  readonly maxInlineImageBytes: number
  readonly maxEventBytes: number
  readonly maxFileBodyBytes: number
  readonly credentialLifetimeMs: number
  readonly credentialRotateMs: number
  /**
   * Optional real model upstream, mirroring the production quota service's `upstreamRoot`. Without it the built-in mock
   * answers. The platform key is read only from the named environment variable of this (router) process; the name must
   * contain `KEY` so the development runtime strips it from every Harness child, and the key is never written to a patch,
   * credential file, or instance.
   */
  readonly upstream?: TeamDevUpstreamConfig
}

/** A pinned HTTPS Messages upstream and the environment variable holding its key. */
export interface TeamDevUpstreamConfig {
  /** HTTPS URL ending in `/v1`, without credentials, query, or fragment; `/messages` is appended. */
  readonly root: string
  /** Upper-case environment variable name containing `KEY`, for example `DSH_TEAM_DEV_UPSTREAM_KEY`. */
  readonly keyEnv: string
}

/** Validate the upstream and read its key from the environment; nothing is returned when no upstream is configured. */
export function resolveTeamDevUpstream(upstream: TeamDevUpstreamConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env): { url: string; key: string } | undefined {
  // The config schema fills an omitted object with empty fields; both empty means no upstream.
  if (upstream === undefined || (!upstream.root && !upstream.keyEnv)) return undefined
  let url: URL
  try { url = new URL(upstream.root) } catch { throw new Error('team-dev upstream root must be an HTTPS URL ending in /v1') }
  if (url.protocol !== 'https:' || !url.pathname.endsWith('/v1') || url.search || url.hash || url.username || url.password) {
    throw new Error('team-dev upstream root must be an HTTPS URL ending in /v1')
  }
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(upstream.keyEnv) || !upstream.keyEnv.includes('KEY')) {
    throw new Error('team-dev upstream keyEnv must be an upper-case variable name containing KEY')
  }
  const key = env[upstream.keyEnv]?.trim()
  if (key === undefined || key.length < 8) throw new Error(`team-dev upstream key is missing from ${upstream.keyEnv}`)
  return { url: `${url.href}/messages`, key }
}

/** Running private model service and one Web patch per fixed user. */
export interface TeamDevQuota {
  readonly patches: ReadonlyMap<UserId, string>
  /** Create one user's private model channel; concurrent calls share the same initialization. */
  ensureUser(userId: UserId): Promise<string>
  /** One user's own read-only usage from the ledger, for the personal center. */
  usage(userId: UserId): Promise<PersonalUsage>
  /** The ledger's account operations, served on the same account socket production uses (`startQuotaAccountServer`). */
  readonly account: QuotaAccountLedger
  /** Reservations shared by local knowledge-base compile jobs and Web requests. */
  readonly budget: Pick<ReturnType<typeof createQuotaLedger>, 'reserve' | 'settle'>
  /** Private Messages endpoints and credential files for initialized local identities. */
  readonly channels: ReadonlyMap<UserId, { readonly baseUrl: string; readonly credentialFile: string }>
  /** Stop listeners after in-flight credential writes finish; repeated calls join shutdown. */
  close(): Promise<void>
}

function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

/** Start a deterministic mock upstream and the real durable quota path. */
export async function startTeamDevQuota(options: {
  readonly storageRoot: string
  readonly baseWebPatch: string
  readonly users: readonly UserId[]
  readonly config: TeamDevQuotaConfig
  readonly storageLock: StorageLockConfig
  /** Test seam for the real-upstream path; production code uses global fetch. */
  readonly fetcher?: typeof fetch
  readonly env?: Readonly<Record<string, string | undefined>>
}): Promise<TeamDevQuota> {
  const { config } = options
  if (options.users.length > 0) validateDevUsers(options.users)
  validateStorageLockConfig(options.storageLock)
  const { staleMs, updateMs } = options.storageLock
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.modelId)
    || !Number.isSafeInteger(config.credentialLifetimeMs) || config.credentialLifetimeMs < 1
    || config.credentialLifetimeMs > 900_000
    || !Number.isSafeInteger(config.credentialRotateMs) || config.credentialRotateMs < 1
    || config.credentialRotateMs >= config.credentialLifetimeMs) {
    throw new Error('invalid development quota model or credential rotation')
  }
  const upstream = resolveTeamDevUpstream(config.upstream, options.env)
  const quotaHome = join(options.storageRoot, 'quota')
  await privateDirectory(options.storageRoot)
  await privateDirectory(quotaHome)
  const release = await lockfile.lock(options.storageRoot, { stale: staleMs, update: updateMs, retries: 0 })
  let ledger: ReturnType<typeof createQuotaLedger>
  try { ledger = createQuotaLedger({ databasePath: join(quotaHome, 'ledger.sqlite'),
    personalDailyTokens: config.personalDailyTokens, siteDailyTokens: config.siteDailyTokens,
    personalConcurrency: config.personalConcurrency, siteConcurrency: config.siteConcurrency,
    busyTimeoutMs: config.busyTimeoutMs }) }
  catch (error) { await release(); throw error }
  const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'team-dev',
    lifetimeMs: config.credentialLifetimeMs })
  const platformKey = randomBytes(32).toString('base64url')
  const mock = createServer((request, response) => {
    if (request.url !== '/v1/messages' || request.method !== 'POST'
      || request.headers['x-api-key'] !== platformKey) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      { type: 'message_start', message: { id: `msg_${randomUUID()}`, model: config.modelId,
        usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local mock model response.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ].map(sse).join(''))
  })
  const listeners: Array<{ close(): Promise<void> }> = []
  const timers: NodeJS.Timeout[] = []
  const rotations = new Set<Promise<void>>()
  const patches = new Map<UserId, string>()
  const channels = new Map<UserId, { baseUrl: string; credentialFile: string }>()
  let mockStarted = false
  try {
    let forwardMessages: ReturnType<typeof createMessagesForwarder>
    if (upstream === undefined) {
      const mockPort = await listen(mock)
      mockStarted = true
      forwardMessages = createMessagesForwarder({ upstreamUrl: `http://127.0.0.1:${mockPort}/v1/messages`, platformKey,
        maxEventBytes: config.maxEventBytes, ledger })
    } else {
      forwardMessages = createMessagesForwarder({ upstreamUrl: upstream.url, platformKey: upstream.key,
        maxEventBytes: config.maxEventBytes, ledger, ...options.fetcher === undefined ? {} : { fetcher: options.fetcher } })
    }
    const parsed: unknown = JSON.parse(await readFile(options.baseWebPatch, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('development Web patch must contain a list')
    const providerUrl = import.meta.resolve('@public-harness/quota-provider')
    const uiUrl = import.meta.resolve('@public-harness/ui')
    let closing: Promise<void> | undefined
    const initializing = new Map<UserId, Promise<string>>()
    const createUser = async (userId: UserId): Promise<string> => {
      validateDevUsers([...patches.keys(), userId])
      const home = join(options.storageRoot, 'users', userId, 'home')
      await privateDirectory(join(options.storageRoot, 'users'))
      await privateDirectory(join(options.storageRoot, 'users', userId))
      await privateDirectory(home)
      const instanceId = randomBytes(18).toString('base64url')
      const listener = await startQuotaHttpServer({ host: '127.0.0.1', instanceId, issuer,
        admission: createAdmission({ issuer, ledger, config: {
          modelContextWindows: { [config.modelId]: config.contextWindow },
          modelMaxOutputTokens: { [config.modelId]: config.maxTokens },
          maxBodyBytes: config.maxBodyBytes, maxImagesPerRequest: config.maxImagesPerRequest,
          maxInlineImageBytes: config.maxInlineImageBytes,
        } }),
        forwardMessages, files: { handle: async () => new Response(null, { status: 404 }), owns: () => false },
        maxBodyBytes: config.maxBodyBytes, maxFileBodyBytes: config.maxFileBodyBytes,
      })
      listeners.push(listener)
      let active: Promise<void> | undefined
      let timer: NodeJS.Timeout | undefined
      try {
        const credentialFile = join(home, 'quota-credential.json')
        const rotate = async (): Promise<void> => {
          const issued = issuer.issue(userId, instanceId)
          const temporary = `${credentialFile}.${randomUUID()}`
          await writeFile(temporary, `${JSON.stringify(issued)}\n`, { flag: 'wx', mode: 0o600 })
          await rename(temporary, credentialFile)
        }
        await rotate()
        timer = setInterval(() => {
          if (active !== undefined) return
          active = rotate().catch((_error: unknown) => {
            process.stderr.write('team-dev: model credential rotation failed\n')
          }).finally(() => { if (active !== undefined) rotations.delete(active); active = undefined })
          rotations.add(active)
        }, config.credentialRotateMs)
        timers.push(timer)
        const patch = join(home, 'team-dev-web.patch.yml')
        // Child processes never inherit model keys, so the official route has none: start on the platform model and hide it.
        await writeFile(patch, `${JSON.stringify([...parsed, { id: 'ui-brand-official', disabled: true }, { id: 'ui-settings-account', disabled: true }, ...platformModelRows({ provider: 'platform', model: config.modelId }), { insert: [{
          id: 'public-harness-quota-provider', name: providerUrl,
          config: { proxyBaseUrl: `http://127.0.0.1:${listener.port}/v1`, credentialFile,
            provider: 'platform', modelId: config.modelId, modelName: upstream === undefined ? 'Local mock model' : 'Platform model',
            contextWindow: config.contextWindow, maxTokens: config.maxTokens },
        }, { id: 'public-harness-ui', name: uiUrl }] }])}\n`, { mode: 0o600 })
        channels.set(userId, { baseUrl: `http://127.0.0.1:${listener.port}/v1`, credentialFile })
        patches.set(userId, patch)
        return patch
      } catch (error) {
        if (timer !== undefined) {
          clearInterval(timer)
          timers.splice(timers.indexOf(timer), 1)
        }
        await active
        try { await listener.close() }
        catch (closeError) { throw new AggregateError([error, closeError], 'failed to initialize and stop a local model channel') }
        listeners.splice(listeners.indexOf(listener), 1)
        throw error
      }
    }
    const ensureUser = (userId: UserId): Promise<string> => {
      if (closing !== undefined) return Promise.reject(new Error('development quota is closed'))
      const existing = patches.get(userId)
      if (existing !== undefined) return Promise.resolve(existing)
      let pending = initializing.get(userId)
      if (pending === undefined) {
        validateDevUsers([...new Set([...patches.keys(), ...initializing.keys(), userId])])
        pending = createUser(userId)
        initializing.set(userId, pending)
        void pending.then(() => initializing.delete(userId), () => initializing.delete(userId))
      }
      return pending
    }
    for (const userId of options.users) await ensureUser(userId)
    return { patches, ensureUser, budget: ledger, channels, usage: userId => ledger.usage(userId), account: ledger, close() { return closing ??= (async () => {
      await Promise.allSettled([...initializing.values()])
      for (const timer of timers) clearInterval(timer)
      await Promise.all(rotations)
      const outcomes = await Promise.allSettled(listeners.map(listener => listener.close()))
      try { if (mockStarted) await closeServer(mock) } finally {
        try { ledger.close() } finally { await release() }
      }
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'failed to stop quota listeners')
    })() } }
  } catch (error) {
    for (const timer of timers) clearInterval(timer)
    await Promise.all(rotations)
    await Promise.allSettled(listeners.map(listener => listener.close()))
    try { if (mockStarted) await closeServer(mock) } finally {
      try { ledger.close() } finally { await release() }
    }
    throw error
  }
}
