/** Identity service entry: Better Auth registration and sessions, the private session socket and account pages. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { readSecret } from './secret.ts'
import type { Server } from 'node:http'
import { createAuth } from './auth.ts'
import { parseIdentityConfig, type IdentityConfig } from './config.ts'
import { openIdentityDatabase } from './database.ts'
import { createAccountPages } from './pages.ts'
import { listenUnix, publicHandler, sessionHandler } from './server.ts'
import { createCaptchaProvider, type CaptchaProvider } from './captcha.ts'
import { createMailTransport } from './mail.ts'
import type { MailTransport } from './transports.ts'
import { createOidcProvider } from './sso/oidc.ts'
import { createWecomProvider } from './sso/wecom.ts'
import type { SsoProvider } from './sso/provider.ts'

export { parseIdentityConfig, parseProviderEnv, type IdentityConfig } from './config.ts'
export { createCaptchaProvider, type CaptchaProvider } from './captcha.ts'
export { createMailTransport } from './mail.ts'
export { readSecret } from './secret.ts'

/** Start both listeners; signup alone allocates no account, instance or model grant.
 * @param config Validated settings.
 * @param overrides Injected providers for tests.
 * @returns Handle that closes listeners and the database.
 */
export async function startIdentity(config: IdentityConfig, overrides: { mail?: MailTransport; captcha?: CaptchaProvider; sso?: SsoProvider; clock?: () => number } = {}): Promise<{ close(): Promise<void> }> {
  // Better Auth enables telemetry when this variable is set, regardless of options; the service sends nothing outbound.
  if (/^(1|true)$/i.test(process.env.BETTER_AUTH_TELEMETRY ?? '')) throw new Error('BETTER_AUTH_TELEMETRY must not be enabled')
  const database = await openIdentityDatabase(config.databaseFile)
  const servers: Server[] = []
  try {
    const sso = overrides.sso ?? (config.sso.kind === 'oidc' ? createOidcProvider(config.sso) : config.sso.kind === 'wecom' ? createWecomProvider(config.sso) : undefined)
    const serviceSecret = await readSecret(config.secretFile)
    const auth = await createAuth(config, database, serviceSecret, overrides.mail ?? createMailTransport(config.mail), sso, overrides.clock)
    const captcha = overrides.captcha ?? createCaptchaProvider(config.captcha)
    servers.push(await listenUnix(publicHandler({ config, auth, database, captcha, serviceSecret, pages: createAccountPages(config, captcha),
      ...overrides.clock === undefined ? {} : { clock: overrides.clock } }), config.publicSocket, 0o660))
    servers.push(await listenUnix(sessionHandler(auth), config.sessionSocket, 0o660, config.sessionSocketGid))
  } catch (error) {
    for (const server of servers) server.close()
    database.close()
    throw error
  }
  return {
    async close() {
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
