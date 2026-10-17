/** Better Auth instance: email/password with required verification, database-backed sessions, no cookie cache, no telemetry. */
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'
import type { MailTransport } from './transports.ts'
import type { PasswordSsoProvider, SsoProvider } from './sso/provider.ts'
import { ssoPlugin } from './sso/plugin.ts'

/** Cookie prefix; the session cookie is `<prefix>.session_token` (with `__Secure-` over HTTPS). */
export const COOKIE_PREFIX = 'dsh-account'

/** Build Better Auth options for this service; exported for migration tooling.
 * @param config Validated settings.
 * @param database Open identity database.
 * @param secret Signing secret read from `secretFile`.
 * @param mail Delivery transport.
 * @param sso Enterprise sign-in provider; absent when `DSH_SSO_PROVIDER` is off.
 * @param clock Clock for SSO state and audit.
 * @returns Better Auth options.
 */
export function authOptions(config: IdentityConfig, database: IdentityDatabase, secret: string, mail: MailTransport, sso?: SsoProvider | PasswordSsoProvider, clock?: () => number) {
  return {
    plugins: sso === undefined ? [] : [ssoPlugin({ config, store: database.sso, groups: database.groups, provider: sso, ...clock === undefined ? {} : { clock } })],
    appName: 'DeepSeek Harness', baseURL: config.publicOrigin, basePath: '/api/auth', secret,
    database: database.db, trustedOrigins: [config.publicOrigin], telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: config.verificationTtlSeconds,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await mail({ to: user.email, subject: 'Reset your DeepSeek Harness password', text: `Open this link to choose a new password:\n${url}\n\nIf you did not ask for this, ignore this message.` })
      },
    },
    emailVerification: {
      sendOnSignUp: true, autoSignInAfterVerification: false, expiresIn: config.verificationTtlSeconds,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await mail({ to: user.email, subject: 'Verify your DeepSeek Harness account', text: `Open this link to verify your email address:\n${url}` })
      },
    },
    // Every lookup reads the session row, so sign-out and revocation take effect on the next request.
    session: { expiresIn: config.sessionTtlSeconds, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 100 },
    advanced: { useSecureCookies: config.mode === 'production', cookiePrefix: COOKIE_PREFIX, ipAddress: { ipAddressHeaders: ['x-dsh-client-ip'] } },
  }
}

/** Create the auth instance and apply its owned schema migration.
 * @param config Validated settings.
 * @param database Open identity database.
 * @param secret Signing secret.
 * @param mail Delivery transport.
 * @param sso Enterprise sign-in provider, when configured.
 * @param clock Clock for SSO state and audit.
 * @returns Ready Better Auth instance.
 */
export async function createAuth(config: IdentityConfig, database: IdentityDatabase, secret: string, mail: MailTransport, sso?: SsoProvider | PasswordSsoProvider, clock?: () => number) {
  const options = authOptions(config, database, secret, mail, sso, clock)
  const { runMigrations } = await getMigrations(options)
  await runMigrations()
  return betterAuth(options)
}
/** The configured auth instance type. */
export type IdentityAuth = Awaited<ReturnType<typeof createAuth>>
