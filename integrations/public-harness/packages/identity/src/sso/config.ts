/** Enterprise SSO settings, read only from the service environment and refused at startup when incomplete. */
import { IdentityConfigError } from '../config.ts'
import { validIpEntry } from './ip.ts'

/** Configured enterprise sign-in; `off` keeps public registration behavior unchanged. */
export type SsoConfig =
  | { readonly kind: 'off' }
  | { readonly kind: 'oidc'; readonly issuer: string; readonly clientId: string; readonly clientSecret: string; readonly scopes: readonly string[]
    readonly groupClaims: readonly string[]; readonly allowedGroups: readonly string[]; readonly timeoutMs: number }
/** Administrator emergency password path; enabled only by a source-address allow-list. */
export type EmergencyConfig = { readonly enabled: false } | { readonly enabled: true; readonly allowedIps: readonly string[] }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Parse `DSH_SSO_*` and `DSH_OIDC_*`. Errors name the variable, never its value.
 * @param env Process environment.
 * @param mode Service mode; production requires an HTTPS issuer, local mode allows loopback HTTP for the mock IdP.
 * @returns SSO and emergency settings.
 */
export function parseSsoEnv(env: Readonly<Record<string, string | undefined>>, mode: 'production' | 'local'): { sso: SsoConfig; emergency: EmergencyConfig } {
  const need = (name: string, pattern: RegExp = /^\S(?:.*\S)?$/): string => {
    const value = env[name]
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value) || !pattern.test(value)) throw new IdentityConfigError(name)
    return value
  }
  const optional = (name: string, fallback: string, pattern?: RegExp) => env[name] === undefined || env[name] === '' ? fallback : need(name, pattern)
  const list = (name: string, value: string, item: RegExp) => {
    const items = value.split(',').map(entry => entry.trim())
    if (!items.length || items.some(entry => !item.test(entry))) throw new IdentityConfigError(name)
    return items
  }
  const kind = env.DSH_SSO_PROVIDER ?? 'off'
  let sso: SsoConfig
  if (kind === 'off' || kind === '') sso = { kind: 'off' }
  else if (kind === 'oidc') {
    let issuer: URL
    try { issuer = new URL(need('DSH_OIDC_ISSUER')) } catch { throw new IdentityConfigError('DSH_OIDC_ISSUER') }
    const loopbackHttp = mode === 'local' && issuer.protocol === 'http:' && LOOPBACK.has(issuer.hostname)
    if ((issuer.protocol !== 'https:' && !loopbackHttp) || issuer.search || issuer.hash || issuer.username || issuer.password
      || env.DSH_OIDC_ISSUER!.includes('?') || env.DSH_OIDC_ISSUER!.includes('#')) throw new IdentityConfigError('DSH_OIDC_ISSUER')
    const scopes = optional('DSH_OIDC_SCOPES', 'openid email profile', /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/).split(' ')
    if (!scopes.includes('openid')) throw new IdentityConfigError('DSH_OIDC_SCOPES')
    const timeoutMs = Number(optional('DSH_OIDC_TIMEOUT_MS', '5000', /^[0-9]{3,6}$/))
    if (timeoutMs < 500 || timeoutMs > 60_000) throw new IdentityConfigError('DSH_OIDC_TIMEOUT_MS')
    sso = { kind: 'oidc', issuer: env.DSH_OIDC_ISSUER!, clientId: need('DSH_OIDC_CLIENT_ID', /^[\x21-\x7e]{1,256}$/), clientSecret: need('DSH_OIDC_CLIENT_SECRET', /^.+$/), scopes,
      groupClaims: list('DSH_OIDC_GROUP_CLAIMS', optional('DSH_OIDC_GROUP_CLAIMS', 'groups'), /^[A-Za-z0-9_:./-]{1,256}$/),
      // D7: just-in-time accounts only for configured departments or groups; an empty list would admit nobody, so it refuses start.
      allowedGroups: list('DSH_SSO_ALLOWED_GROUPS', need('DSH_SSO_ALLOWED_GROUPS'), /^[^,\s](?:[^,]{0,254}[^,\s])?$/), timeoutMs }
  } else throw new IdentityConfigError('DSH_SSO_PROVIDER')

  let emergency: EmergencyConfig = { enabled: false }
  if (env.DSH_SSO_EMERGENCY_ALLOWED_IPS !== undefined && env.DSH_SSO_EMERGENCY_ALLOWED_IPS !== '') {
    // The emergency path exists to recover when the IdP is down; without SSO it would be a second password login, so it refuses start.
    if (sso.kind === 'off') throw new IdentityConfigError('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    const value = need('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    const allowedIps = value.split(',').map(entry => entry.trim())
    if (allowedIps.some(entry => !validIpEntry(entry))) throw new IdentityConfigError('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    emergency = { enabled: true, allowedIps }
  }
  return { sso, emergency }
}
