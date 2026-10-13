import { afterEach, describe, expect, it } from 'vitest'
import type { SsoConfig } from '../src/sso/config.ts'
import { createOidcProvider } from '../src/sso/oidc.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { IdentityUnavailableError } from '../src/transports.ts'
import { testKey } from './jwt-keys.ts'
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, startMockIdp, type MockIdp } from './mock-oidc.ts'

const REDIRECT = 'http://127.0.0.1:18443/api/auth/sso/callback'
const idps: MockIdp[] = []
afterEach(async () => { for (const idp of idps.splice(0)) await idp.close() })
const config = (issuer: string, extra: Partial<Extract<SsoConfig, { kind: 'oidc' }>> = {}): Extract<SsoConfig, { kind: 'oidc' }> => ({
  kind: 'oidc', issuer, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, scopes: ['openid', 'email', 'profile'], groupClaims: ['groups', 'department'],
  allowedGroups: ['engineering'], timeoutMs: 1000, ...extra })

async function round(idp: MockIdp, provider = createOidcProvider(config(idp.issuer)), mutate?: (input: { code: string; nonce: string; verifier: string }) => void) {
  const { url, secrets } = await provider.begin({ redirectUri: REDIRECT })
  const back = await idp.authorize(url)
  expect(back.searchParams.get('state')).toBe(secrets.state)
  const input = { code: back.searchParams.get('code')!, nonce: secrets.nonce, verifier: secrets.verifier }
  mutate?.(input)
  return provider.finish({ ...input, redirectUri: REDIRECT })
}
async function rejected(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}
const mock = async (...args: Parameters<typeof startMockIdp>) => { const idp = await startMockIdp(...args); idps.push(idp); return idp }

describe('OIDC provider', () => {
  it('authorization_url_uses_pkce_state_and_nonce', async () => {
    const idp = await mock()
    const { url, secrets } = await createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe(`${idp.issuer}/authorize`)
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ response_type: 'code', client_id: MOCK_CLIENT_ID, redirect_uri: REDIRECT, scope: 'openid email profile',
      state: secrets.state, nonce: secrets.nonce, code_challenge_method: 'S256' })
    expect(target.searchParams.get('code_challenge')).not.toBe(secrets.verifier)
    expect(secrets.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    const again = await createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })
    expect(again.secrets.state).not.toBe(secrets.state)
  })

  it('valid_login_maps_subject_email_and_group_claims', async () => {
    const idp = await mock({ sub: 'emp-001', email: 'Alice@Corp.Example', name: 'Alice', groups: ['engineering', 'oncall', 7], department: 'R&D' })
    expect(await round(idp)).toEqual({ subject: 'emp-001', email: 'alice@corp.example', name: 'Alice', groups: ['engineering', 'oncall', 'R&D'] })
    expect(idp.authMethods).toEqual(['client_secret_basic'])
    idp.discovery = { token_endpoint_auth_methods_supported: ['client_secret_post'] }
    expect((await round(idp)).subject).toBe('emp-001')
    expect(idp.authMethods.at(-1)).toBe('client_secret_post')
  })

  it('es256_keys_and_rotation_refetch_jwks_once', async () => {
    const idp = await mock(), provider = createOidcProvider(config(idp.issuer))
    await round(idp, provider)
    expect(idp.jwksFetches).toBe(1)
    idp.keys = [testKey('ES256', 'k2')]
    expect((await round(idp, provider)).subject).toBe('emp-001')
    expect(idp.jwksFetches).toBe(2)
    await round(idp, provider)
    expect(idp.jwksFetches).toBe(2)
  })

  it('invalid_tokens_and_claims_are_rejected', async () => {
    const idp = await mock()
    const now = Math.floor(Date.now() / 1000)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ iss: 'http://127.0.0.1:1' }, 'token-issuer'],
      [{ aud: 'someone-else' }, 'token-audience'],
      [{ aud: [MOCK_CLIENT_ID, 'other'] }, 'token-audience'],
      [{ azp: 'other' }, 'token-audience'],
      [{ exp: now - 120 }, 'token-expired'],
      [{ iat: now + 600 }, 'token-issued-at'],
      [{ nonce: 'replayed' }, 'token-nonce'],
      [{ sub: '' }, 'token-subject'],
      [{ email: undefined }, 'email-missing'],
      [{ email: 'not-an-email' }, 'email-missing'],
      [{ email_verified: false }, 'email-unverified'],
    ]
    for (const [override, code] of cases) {
      idp.override = override
      expect(await rejected(round(idp)), code).toBe(code)
    }
    idp.override = { aud: [MOCK_CLIENT_ID, 'other'], azp: MOCK_CLIENT_ID }
    expect((await round(idp)).subject).toBe('emp-001')
    idp.override = {}
    expect(await rejected(round(idp, undefined, input => { input.verifier = 'x'.repeat(43) }))).toBe('token-exchange')
    expect(await rejected(round(idp, undefined, input => { input.code = 'forged' }))).toBe('token-exchange')
    const provider = createOidcProvider(config(idp.issuer))
    await round(idp, provider)
    idp.keys = [{ ...testKey('RS256', 'k1'), jwk: idp.keys[0]!.jwk }]
    expect(await rejected(round(idp, provider))).toBe('token-signature')
  })

  it('discovery_must_name_the_configured_issuer', async () => {
    const idp = await mock()
    idp.discovery = { issuer: 'https://evil.example' }
    await expect(createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })).rejects.toBeInstanceOf(IdentityUnavailableError)
    idp.discovery = { token_endpoint: 'http://evil.example/token' }
    await expect(createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('idp_outage_or_timeout_is_unavailable', async () => {
    const idp = await mock()
    const provider = createOidcProvider(config(idp.issuer))
    const { url, secrets } = await provider.begin({ redirectUri: REDIRECT })
    const code = (await idp.authorize(url)).searchParams.get('code')!
    idp.tokenStatus = 502
    await expect(provider.finish({ code, nonce: secrets.nonce, verifier: secrets.verifier, redirectUri: REDIRECT })).rejects.toBeInstanceOf(IdentityUnavailableError)
    idp.tokenStatus = undefined; idp.delayMs = 1500
    await expect(createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })).rejects.toBeInstanceOf(IdentityUnavailableError)
    idp.delayMs = 0
    await idp.close(); idps.splice(idps.indexOf(idp), 1)
    await expect(createOidcProvider(config(idp.issuer)).begin({ redirectUri: REDIRECT })).rejects.toBeInstanceOf(IdentityUnavailableError)
  })
})
