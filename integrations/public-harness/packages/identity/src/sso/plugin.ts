/** Better Auth plugin for enterprise SSO: `/sso/start` and `/sso/callback` (redirect providers) or `/sso/ldap/sign-in` (LDAP) mint ordinary
 * Better Auth sessions for bound or just-in-time accounts. */
import { randomBytes } from 'node:crypto'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { parseUserId } from '@public-harness/contracts'
import type { IdentityConfig } from '../config.ts'
import { safeReturnPath } from '../pages.ts'
import { IdentityUnavailableError } from '../transports.ts'
import { SsoRejectedError, type PasswordSsoProvider, type SsoIdentity, type SsoProvider } from './provider.ts'
import { SsoBindingError, STATE_TTL_MS, type SsoStore } from './store.ts'

/** Browser-binding cookie name for one sign-in attempt. */
export const SSO_BROWSER_COOKIE = 'dsh-sso'
const CALLBACK = '/api/auth/sso/callback'
const RETURN = /^\/(?:account|u\/[A-Za-z0-9_-]{1,128})\/$/
/** LDAP lockout: failures per (username, IP) and per username, in a sliding window. */
export const LDAP_LOCKOUT = { window: 15 * 60_000, perUserIp: 5, perUser: 20 } as const

/** Collaborators of the SSO plugin. */
export interface SsoPluginDeps {
  readonly config: IdentityConfig
  readonly store: SsoStore
  readonly provider: SsoProvider | PasswordSsoProvider
  /** Shortest answer time for a refused LDAP sign-in, so timing says little about why; default 300 ms. */
  readonly ldapFloorMs?: number
  readonly clock?: () => number
}

/** Build the plugin.
 * @param deps Settings, store, provider and clock.
 * @returns Better Auth plugin.
 */
export function ssoPlugin(deps: SsoPluginDeps) {
  const { config, store, provider } = deps, clock = deps.clock ?? Date.now
  if (config.sso.kind === 'off') throw new Error('sso plugin requires an SSO provider')
  const allowed = new Set(config.sso.allowedGroups)
  const secure = config.mode === 'production'
  // `__Secure-` keeps the binding cookie HTTPS-only in production; SameSite=Lax lets the IdP's top-level redirect carry it back.
  const cookieName = secure ? `__Secure-${SSO_BROWSER_COOKIE}` : SSO_BROWSER_COOKIE
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/api/auth/sso/' }
  const redirectUri = `${config.publicOrigin}${CALLBACK}`
  const unavailable = () => new APIError('SERVICE_UNAVAILABLE', { code: 'unavailable', message: 'identity provider unavailable' })
  type Ctx = Parameters<typeof setSessionCookie>[0]
  /** Shared by every provider: D7 allow-list, subject binding or just-in-time account, then an ordinary session. */
  async function complete(ctx: Ctx, identity: SsoIdentity, fail: (code: string, extra?: { userId?: string; email?: string }) => Error, ip: string | undefined): Promise<string> {
    const who = { email: identity.email }
    // D7: membership is checked on every sign-in, so removing someone from the group stops new sessions.
    if (!identity.groups.some(group => allowed.has(group))) throw fail('group', who)
    const adapter = ctx.context.internalAdapter
    const kind = provider.kind
    let userId = store.findSubject(kind, identity.subject)
    let user
    if (userId !== undefined) {
      user = await adapter.findUserById(userId)
      if (user === null) throw fail('account-missing', { ...who, userId })
    } else {
      // D2: never merge by email. An address already held by any account (invite, emergency or legacy) refuses the sign-in.
      if (await adapter.findUserByEmail(identity.email) !== null) throw fail('email-in-use', who)
      user = await adapter.createUser({ email: identity.email, name: identity.name, emailVerified: true }, { method: `sso-${kind}`, sso: { providerId: kind } })
      try {
        store.setOrigin(user.id, 'sso')
        store.bindSubject(kind, identity.subject, user.id, clock())
      } catch (error) {
        await adapter.deleteUser(user.id)
        if (error instanceof SsoBindingError) throw fail('binding', who)
        throw error
      }
      userId = user.id
    }
    const session = await adapter.createSession(user.id)
    await setSessionCookie(ctx, { session, user })
    store.audit({ event: 'sso-sign-in', outcome: 'ok', userId, ...who, ...ip === undefined ? {} : { ip } }, clock())
    return userId
  }
  const failures = new Map<string, number[]>()
  const recent = (key: string, now: number) => (failures.get(key) ?? []).filter(at => at > now - LDAP_LOCKOUT.window)
  const ldapEndpoint = (password: PasswordSsoProvider) => ({
    ssoLdapSignIn: createAuthEndpoint('/sso/ldap/sign-in', { method: 'POST' }, async ctx => {
      const ip = ctx.request?.headers.get('x-dsh-client-ip') ?? undefined
      const body = (ctx.body ?? {}) as { username?: unknown; password?: unknown; return?: unknown }
      const username = typeof body.username === 'string' ? body.username : '', secret = typeof body.password === 'string' ? body.password : ''
      const asked = typeof body.return === 'string' && RETURN.test(body.return) ? body.return : ''
      const started = Date.now(), now = clock()
      const userKey = `u:${username.trim().toLowerCase().slice(0, 256)}`, pairKey = `${userKey}|${ip ?? ''}`
      const audit = (outcome: 'denied' | 'error', detail: string) => store.audit({ event: 'sso-sign-in', outcome, detail, ...ip === undefined ? {} : { ip } }, clock())
      // Every refusal waits out the same floor and carries a fixed code, so neither timing nor wording says which part was wrong.
      const refuse = async (code: string, status: 'UNAUTHORIZED' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS') => {
        const wait = (deps.ldapFloorMs ?? 300) - (Date.now() - started)
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        return new APIError(status, { code, message: code })
      }
      if (recent(pairKey, now).length >= LDAP_LOCKOUT.perUserIp || recent(userKey, now).length >= LDAP_LOCKOUT.perUser) {
        audit('denied', 'locked')
        throw await refuse('locked', 'TOO_MANY_REQUESTS')
      }
      let identity
      try { identity = await password.authenticate({ username, password: secret }) } catch (error) {
        if (error instanceof SsoRejectedError) {
          audit('denied', error.code)
          for (const key of [pairKey, userKey]) failures.set(key, [...recent(key, now), now])
          if (failures.size > 50_000) for (const [key, list] of failures) if (!list.some(at => at > now - LDAP_LOCKOUT.window)) failures.delete(key)
          throw await refuse('credentials', 'UNAUTHORIZED')
        }
        if (error instanceof IdentityUnavailableError) { audit('error', 'unavailable'); throw unavailable() }
        throw error
      }
      failures.delete(pairKey)
      const fail = (code: string, extra: { userId?: string; email?: string } = {}) => {
        store.audit({ event: 'sso-sign-in', outcome: 'denied', detail: code, ...ip === undefined ? {} : { ip }, ...extra }, clock())
        return new APIError('FORBIDDEN', { code, message: code })
      }
      const userId = await complete(ctx, identity, fail, ip)
      const back = asked ? safeReturnPath(asked, parseUserId(userId)) : `/u/${userId}/`
      return ctx.json({ redirect: `/account/?return=${encodeURIComponent(back)}` })
    }),
  })
  if (!('begin' in provider)) return { id: 'dsh-sso', endpoints: ldapEndpoint(provider) }
  const redirect = provider
  return {
    id: 'dsh-sso',
    endpoints: {
      ssoStart: createAuthEndpoint('/sso/start', { method: 'GET' }, async ctx => {
        const asked = typeof ctx.query?.return === 'string' ? ctx.query.return : ''
        let begun
        try { begun = await redirect.begin({ redirectUri }) } catch (error) {
          if (error instanceof IdentityUnavailableError) throw unavailable()
          throw error
        }
        const browser = randomBytes(32).toString('base64url')
        store.saveState(begun.secrets.state, { browser, nonce: begun.secrets.nonce, verifier: begun.secrets.verifier, returnTo: RETURN.test(asked) ? asked : '' }, clock())
        ctx.setCookie(cookieName, browser, { ...cookieOptions, maxAge: STATE_TTL_MS / 1000 })
        throw ctx.redirect(begun.url)
      }),
      ssoCallback: createAuthEndpoint('/sso/callback', { method: 'GET' }, async ctx => {
        const ip = ctx.request?.headers.get('x-dsh-client-ip') ?? undefined
        const fail = (code: string, extra: { userId?: string; email?: string } = {}) => {
          store.audit({ event: 'sso-sign-in', outcome: 'denied', detail: code, ...ip === undefined ? {} : { ip }, ...extra }, clock())
          return ctx.redirect(`/account/login?sso_error=${encodeURIComponent(code)}`)
        }
        const browser = ctx.getCookie(cookieName) ?? ''
        ctx.setCookie(cookieName, '', { ...cookieOptions, maxAge: 0 })
        const query = ctx.query as Record<string, unknown> | undefined
        const state = typeof query?.state === 'string' ? query.state : ''
        if (typeof query?.error === 'string') { if (state) store.takeState(state, browser, clock()); throw fail('idp') }
        // DingTalk returns the code as `authCode`; every other provider uses `code`.
        const code = typeof query?.code === 'string' ? query.code : typeof query?.authCode === 'string' ? query.authCode : ''
        const saved = state && browser && code ? store.takeState(state, browser, clock()) : undefined
        if (saved === undefined) throw fail('state')
        let identity
        try { identity = await redirect.finish({ code, redirectUri, nonce: saved.nonce, verifier: saved.verifier }) } catch (error) {
          if (error instanceof SsoRejectedError) throw fail(error.code)
          if (error instanceof IdentityUnavailableError) {
            store.audit({ event: 'sso-sign-in', outcome: 'error', detail: 'unavailable', ...ip === undefined ? {} : { ip } }, clock())
            throw unavailable()
          }
          throw error
        }
        const userId = await complete(ctx, identity, fail, ip)
        const back = saved.returnTo ? safeReturnPath(saved.returnTo, parseUserId(userId)) : `/u/${userId}/`
        throw ctx.redirect(`/account/?return=${encodeURIComponent(back)}`)
      }),
    },
  }
}
