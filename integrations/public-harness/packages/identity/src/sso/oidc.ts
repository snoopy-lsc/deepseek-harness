/** OpenID Connect provider: discovery, Authorization Code with PKCE (S256), state and nonce, and ID token validation against the issuer's JWKS. */
import { createHash, randomBytes } from 'node:crypto'
import { IdentityUnavailableError } from '../transports.ts'
import type { SsoConfig } from './config.ts'
import { verifyJws, type Jwk } from './jwt.ts'
import { SsoRejectedError, type SsoIdentity, type SsoProvider } from './provider.ts'

type OidcConfig = Extract<SsoConfig, { kind: 'oidc' }>
interface Discovery { authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; postAuth: boolean }

const DISCOVERY_TTL_MS = 3_600_000
const JWKS_REFRESH_MS = 60_000
const SKEW_S = 60
const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,255}$/
const random = () => randomBytes(32).toString('base64url')

/** Create the OIDC provider.
 * @param config OIDC settings from `DSH_OIDC_*`.
 * @param deps Injected fetch and clock for tests.
 * @returns Provider; IdP failures raise `IdentityUnavailableError`, invalid responses `SsoRejectedError`.
 */
export function createOidcProvider(config: OidcConfig, deps: { fetch?: typeof fetch; clock?: () => number } = {}): SsoProvider {
  const fetcher = deps.fetch ?? fetch, clock = deps.clock ?? Date.now
  const issuer = new URL(config.issuer)
  let discovery: { value: Discovery; at: number } | undefined
  let jwks: { keys: Jwk[] } | undefined
  let lastRefresh: number | undefined

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) }) }
    catch { throw new IdentityUnavailableError('sso') }
  }
  async function json(response: Response): Promise<Record<string, unknown>> {
    let value: unknown
    try { value = await response.json() } catch { throw new IdentityUnavailableError('sso') }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IdentityUnavailableError('sso')
    return value as Record<string, unknown>
  }
  // Endpoints must stay on HTTPS; a loopback HTTP issuer (local mode only, enforced by the configuration) may use its own origin.
  const endpoint = (value: unknown): string => {
    if (typeof value !== 'string') throw new IdentityUnavailableError('sso')
    let url: URL
    try { url = new URL(value) } catch { throw new IdentityUnavailableError('sso') }
    if (url.protocol !== 'https:' && !(issuer.protocol === 'http:' && url.origin === issuer.origin)) throw new IdentityUnavailableError('sso')
    if (url.username || url.password || url.hash) throw new IdentityUnavailableError('sso')
    return url.href
  }
  async function discover(): Promise<Discovery> {
    if (discovery !== undefined && clock() - discovery.at < DISCOVERY_TTL_MS) return discovery.value
    const response = await request(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
    if (!response.ok) throw new IdentityUnavailableError('sso')
    const doc = await json(response)
    // OIDC Discovery §4.3: the document must name exactly the configured issuer.
    if (doc.issuer !== config.issuer) throw new IdentityUnavailableError('sso')
    const methods = doc.token_endpoint_auth_methods_supported
    const postAuth = Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')
    const value = { authorizationEndpoint: endpoint(doc.authorization_endpoint), tokenEndpoint: endpoint(doc.token_endpoint), jwksUri: endpoint(doc.jwks_uri), postAuth }
    discovery = { value, at: clock() }
    return value
  }
  async function keys(refresh: boolean): Promise<Jwk[]> {
    if (jwks !== undefined && !refresh) return jwks.keys
    // Forced refreshes are rate-limited so tokens with made-up key IDs cannot make the service hammer the IdP.
    if (refresh) {
      if (lastRefresh !== undefined && clock() - lastRefresh < JWKS_REFRESH_MS) return jwks?.keys ?? []
      lastRefresh = clock()
    }
    const response = await request((await discover()).jwksUri)
    if (!response.ok) throw new IdentityUnavailableError('sso')
    const doc = await json(response)
    if (!Array.isArray(doc.keys)) throw new IdentityUnavailableError('sso')
    jwks = { keys: doc.keys.filter((key): key is Jwk => typeof key === 'object' && key !== null) }
    return jwks.keys
  }
  return {
    kind: 'oidc',
    async begin({ redirectUri }) {
      const { authorizationEndpoint } = await discover()
      const secrets = { state: random(), nonce: random(), verifier: random() }
      const url = new URL(authorizationEndpoint)
      for (const [name, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: config.scopes.join(' '),
        state: secrets.state, nonce: secrets.nonce, code_challenge: createHash('sha256').update(secrets.verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(name, value)
      return { url: url.href, secrets }
    },
    async finish({ code, redirectUri, nonce, verifier }) {
      if (!code || code.length > 4096) throw new SsoRejectedError('token-exchange')
      const { tokenEndpoint, postAuth } = await discover()
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier })
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
      if (postAuth) { form.set('client_id', config.clientId); form.set('client_secret', config.clientSecret) }
      else {
        // RFC 6749 §2.3.1: form-encode the client ID and secret before Basic encoding.
        const enc = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')
        headers.authorization = `Basic ${Buffer.from(`${enc(config.clientId)}:${enc(config.clientSecret)}`).toString('base64')}`
      }
      const response = await request(tokenEndpoint, { method: 'POST', headers, body: form.toString() })
      if (response.status >= 500) throw new IdentityUnavailableError('sso')
      if (!response.ok) throw new SsoRejectedError('token-exchange')
      const idToken = (await json(response)).id_token
      if (typeof idToken !== 'string') throw new SsoRejectedError('token-response')
      let claims: Record<string, unknown>
      try { claims = verifyJws(idToken, await keys(false)) } catch (error) {
        // An unknown key ID usually means the IdP rotated keys: refetch once (rate-limited), then verify again.
        if (!(error instanceof SsoRejectedError) || error.code !== 'token-key') throw error
        claims = verifyJws(idToken, await keys(true))
      }
      return identity(claims, nonce)
    },
  }

  function identity(claims: Record<string, unknown>, nonce: string): SsoIdentity {
    const now = clock() / 1000
    if (claims.iss !== config.issuer) throw new SsoRejectedError('token-issuer')
    const aud = claims.aud
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : []
    if (!audiences.includes(config.clientId)) throw new SsoRejectedError('token-audience')
    if (audiences.length > 1 && claims.azp !== config.clientId) throw new SsoRejectedError('token-audience')
    if (claims.azp !== undefined && claims.azp !== config.clientId) throw new SsoRejectedError('token-audience')
    if (typeof claims.exp !== 'number' || claims.exp <= now - SKEW_S) throw new SsoRejectedError('token-expired')
    if (typeof claims.iat !== 'number' || claims.iat > now + SKEW_S) throw new SsoRejectedError('token-issued-at')
    if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw new SsoRejectedError('token-nonce')
    const subject = claims.sub
    if (typeof subject !== 'string' || subject.length < 1 || subject.length > 255) throw new SsoRejectedError('token-subject')
    // D4 trusts the IdP for email ownership, but an explicit `email_verified: false` is never accepted.
    if (claims.email_verified === false) throw new SsoRejectedError('email-unverified')
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email)) throw new SsoRejectedError('email-missing')
    const named = [claims.name, claims.preferred_username].find((value): value is string => typeof value === 'string' && value.trim() !== '')
    const name = (named ?? email.split('@')[0]!).trim().slice(0, 128)
    const groups = new Set<string>()
    for (const claim of config.groupClaims) {
      const value = claims[claim]
      for (const item of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) if (typeof item === 'string' && item.length <= 256) groups.add(item)
    }
    return { subject, email, name, groups: [...groups] }
  }
}
