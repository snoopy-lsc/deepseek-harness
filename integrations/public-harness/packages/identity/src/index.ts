/** Identity service entry: Better Auth registration and sessions, the private session socket and account pages. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { UsageSource } from './me.ts'
import { createQuotaAccountClient, type QuotaAdmin } from './quota-account.ts'
import { readFile } from 'node:fs/promises'
import { readSecret } from './secret.ts'
import type { Server } from 'node:http'
import { createAuth } from './auth.ts'
import { parseIdentityConfig, type IdentityConfig } from './config.ts'
import { openIdentityDatabase } from './database.ts'
import { createAccountPages } from './pages.ts'
import { listenUnix, publicHandler, SAML_ACS_PATH, sessionHandler } from './server.ts'
import { createCaptchaProvider, type CaptchaProvider } from './captcha.ts'
import { createMailTransport } from './mail.ts'
import type { MailTransport } from './transports.ts'
import { createOidcProvider } from './sso/oidc.ts'
import { createDingtalkProvider } from './sso/dingtalk.ts'
import { createLdapProvider } from './sso/ldap.ts'
import { createSamlProvider } from './sso/saml.ts'
import { createWecomProvider } from './sso/wecom.ts'
import type { PasswordSsoProvider, SsoProvider } from './sso/provider.ts'
import { LDAP_LOCKOUT } from './sso/plugin.ts'
import { reconcileOnce } from './sso/deprovision.ts'

const PRUNE_INTERVAL_MS = 10 * 60_000

export { parseIdentityConfig, parseProviderEnv, type IdentityConfig } from './config.ts'
export { createCaptchaProvider, type CaptchaProvider } from './captcha.ts'
export { createMailTransport } from './mail.ts'
export { readSecret } from './secret.ts'
export { createQuotaAccountClient, type QuotaAdmin, type QuotaLimits } from './quota-account.ts'

/** Start both listeners; signup alone allocates no account, instance or model grant.
 * @param config Validated settings.
 * @param overrides Injected providers, clock and reconciliation interval for tests.
 * @returns Handle that closes listeners and the database.
 */
export async function startIdentity(config: IdentityConfig, overrides: { mail?: MailTransport; captcha?: CaptchaProvider; sso?: SsoProvider | PasswordSsoProvider; clock?: () => number; reconcileIntervalMs?: number; usage?: UsageSource; quota?: QuotaAdmin } = {}): Promise<{ close(): Promise<void> }> {
  // Better Auth enables telemetry when this variable is set, regardless of options; the service sends nothing outbound.
  if (/^(1|true)$/i.test(process.env.BETTER_AUTH_TELEMETRY ?? '')) throw new Error('BETTER_AUTH_TELEMETRY must not be enabled')
  const database = await openIdentityDatabase(config.databaseFile)
  // Production path: the quota service's account socket feeds the personal center and the allowance editor; overrides are for tests.
  const account = config.quotaAccountSocket === undefined ? undefined : createQuotaAccountClient(config.quotaAccountSocket)
  const usage = overrides.usage ?? account?.usage, quota = overrides.quota ?? account
  const servers: Server[] = []
  const timers: NodeJS.Timeout[] = []
  try {
    const sso = overrides.sso ?? (config.sso.kind === 'oidc' ? createOidcProvider(config.sso) : config.sso.kind === 'wecom' ? createWecomProvider(config.sso)
      : config.sso.kind === 'dingtalk' ? createDingtalkProvider(config.sso)
      : config.sso.kind === 'saml' ? createSamlProvider(config.sso, { acsUrl: `${config.publicOrigin}${SAML_ACS_PATH}`, replay: (id, until) => database.sso.useAssertion(id, until, Date.now()) })
      : config.sso.kind === 'ldap' ? createLdapProvider(config.sso)
      : undefined)
    const serviceSecret = await readSecret(config.secretFile)
    const auth = await createAuth(config, database, serviceSecret, overrides.mail ?? createMailTransport(config.mail), sso, overrides.clock)
    const captcha = overrides.captcha ?? createCaptchaProvider(config.captcha)
    servers.push(await listenUnix(publicHandler({ config, auth, database, captcha, serviceSecret, pages: createAccountPages(config, captcha), ...sso !== undefined && 'metadata' in sso && sso.metadata ? { ssoMetadata: sso.metadata() } : {},
      ...overrides.clock === undefined ? {} : { clock: overrides.clock }, ...usage === undefined ? {} : { usage }, ...quota === undefined ? {} : { quota } }), config.publicSocket, 0o660))
    servers.push(await listenUnix(sessionHandler(auth, userId => database.sso.disabledAt(userId) !== undefined), config.sessionSocket, 0o660, config.sessionSocketGid))
    // Expired counters, login state and assertion IDs are deleted every ten minutes; a failure here is logged and retried next time.
    const prune = () => { try { database.prune(Date.now(), LDAP_LOCKOUT.window) } catch (error) { console.error('identity: prune failed', error instanceof Error ? error.message : error) } }
    prune()
    timers.push(setInterval(prune, PRUNE_INTERVAL_MS).unref())
    const reconcileEvery = overrides.reconcileIntervalMs ?? config.deprovision.intervalMs
    if (sso !== undefined && config.sso.kind !== 'off' && reconcileEvery > 0) {
      const { kind, allowedGroups } = config.sso
      let running = false
      // One run at a time; a run that throws is logged and the next interval tries again. Nothing here can disable on an error.
      const reconcile = async () => {
        if (running) return
        running = true
        try {
          await reconcileOnce({ database, kind, ...sso.directory === undefined ? {} : { directory: sso.directory }, allowedGroups, policy: config.deprovision,
            now: (overrides.clock ?? Date.now)(), log: line => console.log(line) })
        } catch (error) { console.error('identity: sso reconcile failed', error instanceof Error ? error.message : error) } finally { running = false }
      }
      timers.push(setInterval(() => { void reconcile() }, reconcileEvery).unref())
    }
  } catch (error) {
    for (const timer of timers) clearInterval(timer)
    for (const server of servers) server.close()
    database.close()
    throw error
  }
  return {
    async close() {
      for (const timer of timers) clearInterval(timer)
      await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
      database.close()
    },
  }
}

/** Stable Cordis service name. */
export const name = 'public-harness-identity'
/** Root-owned configuration file location. */
export interface PluginConfig { configFile: string }
/** Cordis configuration schema. */
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })
/** Start the identity service from its configuration file plus the provider environment, and close it with the owning context.
 * @param ctx Owning Cordis context.
 * @param config Configuration file location.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const service = await startIdentity(parseIdentityConfig(JSON.parse(await readFile(config.configFile, 'utf8')), process.env))
  const owner = ctx as Context & Pick<Fiber, 'effect'>
  owner.effect(() => async () => { await service.close() }, 'public-harness.identity.close')
}
