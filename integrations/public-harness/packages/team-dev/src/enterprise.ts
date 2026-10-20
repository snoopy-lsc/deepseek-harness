/** Local enterprise profile: real identity, administration, quota and knowledge bases with development Web processes. */
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import lockfile from 'proper-lockfile'
import { parseUserId, startIdleReaper } from '@public-harness/contracts'
import { createDevInstanceManager } from '@public-harness/dev-runtime'
import { parseIdentityConfig, startIdentity } from '@public-harness/identity'
import { createMailTransport } from '@public-harness/identity/mail'
import type { Mail } from '@public-harness/identity/transports'
import { startKbService, createDirectRunner, devUserTrees, createMockModel, createMessagesModel, ModelError, type ModelSource } from '@public-harness/kb'
import type { ModelReply } from '@public-harness/kb/model'
import { estimateInputTokens } from '@public-harness/quota/admission'
import { QuotaExceededError } from '@public-harness/quota/ledger'
import { startQuotaAccountServer } from '@public-harness/quota/account'
import { createNativeIdentity, NATIVE_SESSION_COOKIES } from '@public-harness/router/native-identity'
import { createOwnerRouter } from '@public-harness/router/routes'
import { createBrowserLaunch } from '@public-harness/router/launch'
import { startRouterServer } from '@public-harness/router/server'
import { parseEnterpriseConfig, type EnterpriseConfig } from './enterprise-config.ts'
import { initializeAccounts, localCredentials, privateFile, type LocalCredential } from './enterprise-accounts.ts'
import { startEnterpriseEntry } from './enterprise-proxy.ts'
import { resolveTeamDevUpstream, startTeamDevQuota } from './quota.ts'

export { parseEnterpriseConfig, type EnterpriseConfig } from './enterprise-config.ts'

/** Running local services; all state remains under the configured enterprise home. */
export interface EnterpriseService {
  readonly origin: string
  readonly accounts: readonly LocalCredential[]
  close(): Promise<void>
}

/** Compose the enterprise services on loopback without Linux account or mount isolation.
 * @param config Parsed local settings, including initial accounts and resource limits.
 * @returns Ready ingress and a disposer that waits for every child and service.
 */
export async function startEnterprise(config: EnterpriseConfig): Promise<EnterpriseService> {
  if (process.platform === 'win32') throw new Error('enterprise development currently requires macOS or Linux Unix sockets')
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(config.stateRoot, { retries: 0,
    stale: config.team.storageLock.staleMs, update: config.team.storageLock.updateMs })
  const cleanups = new Map<string, () => Promise<void>>()
  cleanups.set('ownership', release)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    const errors: unknown[] = []
    for (const key of ['entry', 'router', 'reaper', 'runtime', 'identity', 'kb', 'quota-account', 'quota', 'sockets', 'ownership']) {
      try { await cleanups.get(key)?.() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'enterprise development shutdown failed; inspect the server log before restarting')
  })()
  try {
    const sockets = await mkdtemp(join(tmpdir(), 'ed-'))
    cleanups.set('sockets', () => rm(sockets, { recursive: true, force: true }))
    const entry = await startEnterpriseEntry(config.port, config.team.retryAfterSeconds)
    cleanups.set('entry', () => entry.close())
    const secretFile = join(config.stateRoot, 'identity.secret')
    await privateFile(secretFile, () => randomBytes(48).toString('base64url'))
    const mailbox = join(config.stateRoot, 'mailbox')
    await mkdir(mailbox, { recursive: true, mode: 0o700 })
    const accountSocket = join(sockets, 'quota.sock')
    const kbSocket = join(sockets, 'kb.sock')
    const identityConfig = parseIdentityConfig({ mode: 'local', publicOrigin: entry.origin,
      publicSocket: join(sockets, 'id.sock'), sessionSocket: join(sockets, 'sess.sock'), sessionSocketGid: process.getgid!(),
      databaseFile: join(config.stateRoot, 'identity.sqlite'), secretFile,
      ...config.identity, clientIpHeader: 'x-forwarded-for', enrollmentOpen: true,
    }, { ...process.env, DSH_MAIL_PROVIDER: 'mailbox', DSH_MAILBOX_DIR: mailbox, DSH_MAIL_FROM: 'local@example.test',
      DSH_CAPTCHA_PROVIDER: 'test', DSH_CAPTCHA_TEST_TOKEN: 'enterprise-local',
      DSH_ADMIN_EMAILS: [...config.accounts.filter(account => account.role === 'admin').map(account => account.email), process.env.DSH_ADMIN_EMAILS].filter(Boolean).join(','),
      DSH_QUOTA_ACCOUNT_SOCKET: accountSocket, DSH_KB_SOCKET: kbSocket })
    const latestMail = new Map<string, Mail>()
    const deliver = createMailTransport(identityConfig.mail)
    const quota = await startTeamDevQuota({ storageRoot: config.team.storageRoot, baseWebPatch: config.team.webPatch,
      users: [], config: config.team.quota, storageLock: config.team.storageLock })
    cleanups.set('quota', () => quota.close())
    const account = await startQuotaAccountServer(accountSocket, quota.account)
    cleanups.set('quota-account', () => account.close())
    const realModel = resolveTeamDevUpstream(config.team.quota.upstream) !== undefined
    const models: ModelSource = { async open(chargedTo) {
      const userId = parseUserId(chargedTo)
      if (realModel) {
        await quota.ensureUser(userId)
        const channel = quota.channels.get(userId)!
        return { model: createMessagesModel({ baseUrl: channel.baseUrl, model: config.team.quota.modelId,
          credential: async () => z.object({ token: z.string().required() })(JSON.parse(await readFile(channel.credentialFile, 'utf8'))).token }), async close() {} }
      }
      const mock = createMockModel({ demo: true })
      return { model: { async complete(request) {
        const inputBytes = Buffer.byteLength(JSON.stringify({ system: request.system, messages: [{ role: 'user', content: request.prompt }] }))
        const maximum = estimateInputTokens(inputBytes, config.team.quota.contextWindow) + Math.min(request.maxTokens, config.team.quota.maxTokens)
        const reservation = await quota.budget.reserve(userId, maximum).catch((error: unknown) => {
          if (error instanceof QuotaExceededError) throw new ModelError(error.reason === 'personal concurrency' || error.reason === 'site concurrency' ? 429 : 402, error.message)
          throw error
        })
        let reply: ModelReply
        try { reply = await mock.complete(request) }
        catch (error) { await quota.budget.settle(reservation.id, 0); throw error }
        await quota.budget.settle(reservation.id, reply.inputTokens + reply.outputTokens)
        return reply
      } }, async close() {} }
    } }
    const kbRoot = join(config.stateRoot, 'kb')
    const kb = await startKbService({ root: kbRoot, socket: kbSocket,
      users: devUserTrees(config.team.storageRoot), runner: createDirectRunner(),
      jobs: { models, siteWorkers: config.kb.siteWorkers, perUserPerHour: config.kb.perUserPerHour },
      sweepIntervalMs: config.kb.sweepIntervalMs,
      log: line => console.error(line),
    })
    cleanups.set('kb', () => kb.close())
    const identity = await startIdentity(identityConfig, { mail: async mail => { await deliver(mail); latestMail.set(mail.to, mail) } })
    cleanups.set('identity', () => identity.close())
    const accounts = identityConfig.sso.kind === 'off' ? await localCredentials(config.stateRoot, config.accounts) : []
    const users = await initializeAccounts({ accounts, socket: identityConfig.publicSocket, origin: entry.origin, databaseFile: identityConfig.databaseFile, timeoutMs: config.team.launchExchangeMs, latestMail })
    const runtime = createDevInstanceManager({ mode: 'development', host: '127.0.0.1', storageRoot: config.team.storageRoot,
      users, command: config.team.command, args: config.team.args, kbRoot,
      webPatch: userId => quota.patches.get(userId)!, maxActive: config.team.maxActiveInstances,
      startupTimeoutMs: config.team.startupTimeoutMs, stopTimeoutMs: config.team.stopTimeoutMs })
    cleanups.set('runtime', () => runtime.close())
    const stopReaper = startIdleReaper({ tracker: runtime.tracker, running: () => runtime.active(), stop: userId => runtime.stop(userId),
      idleMs: config.team.idleStopMs, intervalMs: config.team.storageLock.updateMs,
      onError: () => console.error('enterprise-dev: idle workspace shutdown failed; inspect the local runtime') })
    cleanups.set('reaper', async () => { stopReaper() })
    const manager = { async ensure(userId: Parameters<typeof runtime.ensure>[0]) {
      await quota.ensureUser(userId)
      runtime.register(userId)
      return runtime.ensure(userId)
    }, launchGrant: runtime.launchGrant, stop: runtime.stop }
    const router = await startRouterServer({ host: '127.0.0.1', publicAuthority: new URL(entry.origin).host,
      identity: createNativeIdentity({ socketPath: identityConfig.sessionSocket, timeoutMs: config.team.launchExchangeMs,
        maxResponseBytes: config.team.quota.maxEventBytes, isActive: async () => true }),
      stripCookies: NATIVE_SESSION_COOKIES, sessionRecheckMs: config.team.launchExchangeMs,
      ownerRouter: createOwnerRouter({ instanceManager: manager, isActive: async () => true,
        hasCapacity: async userId => runtime.active().includes(userId) || runtime.active().length < config.team.maxActiveInstances,
        maxWaitMs: config.team.routeWaitMs }),
      launch: createBrowserLaunch({ instanceManager: manager, maxExchangeMs: config.team.launchExchangeMs }),
      maxSocketLifetimeMs: config.team.socketLifetimeMs, retryAfterSeconds: config.team.retryAfterSeconds })
    cleanups.set('router', () => router.close())
    entry.activate(identityConfig.publicSocket, router.port)
    return { origin: entry.origin, accounts, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'enterprise startup failed and cleanup requires attention') }
    throw error
  }
}

/** Cordis entry settings reference a local JSON file. */
export const Config = z.object({ configFile: z.string().required() })
/** Stable profile plugin name. */
export const name = 'public-harness-enterprise-dev'
/** Start through the named dsh profile and retain every service until context disposal.
 * @param ctx Owning plugin context.
 * @param config JSON settings file.
 */
export async function apply(ctx: Context, config: { configFile: string }): Promise<void> {
  const settings = parseEnterpriseConfig(JSON.parse(await readFile(config.configFile, 'utf8')))
  const service = await startEnterprise(settings)
  const owner = ctx as Context & Pick<Fiber, 'effect'>
  owner.effect(() => () => service.close(), 'public-harness.enterprise-dev')
  process.stdout.write(`enterprise-dev: ${service.origin}/account/login?lang=zh\n`)
  if (service.accounts.length > 0) process.stdout.write(`enterprise-dev: local passwords: ${join(settings.stateRoot, 'accounts.json')}\n`)
  else process.stdout.write('enterprise-dev: sign in with the configured enterprise SSO provider\n')
}
