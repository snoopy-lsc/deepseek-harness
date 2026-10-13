import { afterEach, describe, expect, it } from 'vitest'
import type { SsoConfig } from '../src/sso/config.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { createSamlProvider, samlPlaceholderEmail } from '../src/sso/saml.ts'
import { makeTestKeys, MOCK_IDP_ENTITY_ID, MOCK_SP_ENTITY_ID, startMockSaml, type MockSaml, type ResponseOptions } from './mock-saml.ts'

const ACS = 'http://127.0.0.1:18447/api/auth/sso/acs'
type SamlConfig = Extract<SsoConfig, { kind: 'saml' }>
const mocks: MockSaml[] = []
afterEach(async () => { for (const mock of mocks.splice(0)) await mock.close() })
const start = async () => { const mock = await startMockSaml(); mocks.push(mock); return mock }
const config = (mock: MockSaml, extra: Partial<SamlConfig> = {}): SamlConfig => ({ kind: 'saml', spEntityId: MOCK_SP_ENTITY_ID, idpEntityId: MOCK_IDP_ENTITY_ID, idpSsoUrl: mock.ssoUrl,
  idpCerts: [mock.keys.cert], nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', groupAttribute: 'groups', emailAttribute: 'email', nameAttribute: 'displayName',
  wantAssertionsSigned: false, clockSkewMs: 60_000, allowedGroups: ['engineering'], ...extra })
function provider(mock: MockSaml, extra: Partial<SamlConfig> = {}, seen = new Set<string>()) {
  return createSamlProvider(config(mock, extra), { acsUrl: ACS, replay: id => { if (seen.has(id)) return false; seen.add(id); return true } })
}
async function login(mock: MockSaml, options: ResponseOptions = {}, sp = provider(mock)) {
  mock.next = options
  const { url, secrets } = await sp.begin({ redirectUri: ACS })
  const form = await mock.login(url)
  expect(form.RelayState).toBe(secrets.state)
  return sp.finish({ code: form.SAMLResponse, redirectUri: ACS, nonce: secrets.nonce, verifier: secrets.verifier })
}
async function rejected(promise: Promise<unknown>) {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}

describe('SAML provider', () => {
  it('authn_request_uses_redirect_binding_with_acs_and_persistent_format', async () => {
    const mock = await start()
    const { url, secrets } = await provider(mock).begin({ redirectUri: ACS })
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe(mock.ssoUrl)
    expect([...target.searchParams.keys()].sort()).toEqual(['RelayState', 'SAMLRequest'])
    expect(target.searchParams.get('RelayState')).toBe(secrets.state)
    await mock.login(url)
    expect(mock.requests.at(-1)).toEqual({ id: secrets.nonce, acs: ACS, issuer: MOCK_SP_ENTITY_ID, format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' })
  })

  it('signed_response_or_signed_assertion_maps_to_an_entity_scoped_subject', async () => {
    const mock = await start()
    const subject = `${MOCK_IDP_ENTITY_ID}|u-7f3a9c`
    for (const sign of ['response', 'assertion', 'both'] as const) {
      expect(await login(mock, { sign })).toEqual({ subject, email: 'alice@corp.example', name: 'Alice', groups: ['engineering', 'staff'] })
    }
    delete mock.user.attributes.email
    expect((await login(mock)).email).toBe(samlPlaceholderEmail(subject))
    expect(samlPlaceholderEmail(subject)).toMatch(/^saml-[0-9a-f]{32}@sso\.invalid$/)
  })

  it('unsigned_wrongly_signed_and_wrapped_responses_are_refused', async () => {
    const mock = await start()
    const other = makeTestKeys()
    try {
      expect(await rejected(login(mock, { sign: 'none' }))).toBe('signature')
      expect(await rejected(login(mock, { key: other.key }))).toBe('signature')
      expect(await rejected(login(mock, { sign: 'assertion', wrap: { nameId: 'admin', attributes: { groups: ['engineering'] } } }))).toBe('signature')
      expect(await rejected(login(mock, { sign: 'response' }, provider(mock, { wantAssertionsSigned: true })))).toBe('signature')
    } finally { other.cleanup() }
  })

  it('issuer_audience_recipient_destination_and_in_response_to_are_enforced', async () => {
    const mock = await start()
    expect(await rejected(login(mock, { issuer: 'https://evil.test/idp' }))).toBe('assertion')
    expect(await rejected(login(mock, { audience: 'https://other-sp.test' }))).toBe('assertion')
    expect(await rejected(login(mock, { recipient: 'https://other-sp.test/acs' }))).toBe('assertion')
    expect(await rejected(login(mock, { destination: 'https://other-sp.test/acs' }))).toBe('assertion')
    expect(await rejected(login(mock, { inResponseTo: '_someoneelse' }))).toBe('assertion')
    expect(await rejected(login(mock, { inResponseTo: null }))).toBe('assertion')
  })

  it('time_window_allows_small_skew_only', async () => {
    const mock = await start()
    expect((await login(mock, { notBeforeOffsetMs: 30_000 })).subject).toContain('u-7f3a9c')
    expect(await rejected(login(mock, { notBeforeOffsetMs: 120_000 }))).toBe('assertion')
    expect(await rejected(login(mock, { notOnOrAfterOffsetMs: -120_000 }))).toBe('assertion')
  })

  it('replayed_assertions_transient_ids_and_idp_errors_are_refused', async () => {
    const mock = await start()
    const seen = new Set<string>()
    await login(mock, { assertionId: '_fixed1' }, provider(mock, {}, seen))
    expect(await rejected(login(mock, { assertionId: '_fixed1' }, provider(mock, {}, seen)))).toBe('replay')
    mock.user.format = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'
    expect(await rejected(login(mock))).toBe('nameid')
    mock.user.format = undefined
    expect(await rejected(login(mock, { status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' }))).toBe('idp')
    const sp = provider(mock)
    const { secrets } = await sp.begin({ redirectUri: ACS })
    expect(await rejected(sp.finish({ code: 'not base64 xml', redirectUri: ACS, ...secrets }))).toBe('signature')
  })

  it('sp_metadata_lists_the_acs_and_entity_id', async () => {
    const mock = await start()
    const xml = provider(mock).metadata!()
    expect(xml).toContain(`entityID="${MOCK_SP_ENTITY_ID}"`)
    expect(xml).toContain(`Location="${ACS}"`)
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST')
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent')
  })

  it('signed_authn_requests_verify_at_the_idp_and_unsigned_ones_are_refused_there', async () => {
    const mock = await start(), sp = makeTestKeys('sp'), other = makeTestKeys('other')
    try {
      mock.requireSignedBy = sp.cert
      const signed = provider(mock, { signing: { key: sp.key, cert: sp.cert } })
      const { url } = await signed.begin({ redirectUri: ACS })
      expect([...new URL(url).searchParams.keys()].sort()).toEqual(['RelayState', 'SAMLRequest', 'SigAlg', 'Signature'])
      expect((await login(mock, {}, signed)).subject).toBe(`${MOCK_IDP_ENTITY_ID}|u-7f3a9c`)
      expect(mock.signatures.at(-1)).toEqual({ valid: true, sigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' })
      // Unsigned, or signed by a key the IdP does not know: the IdP refuses before any response.
      expect((await fetch((await provider(mock).begin({ redirectUri: ACS })).url)).status).toBe(403)
      expect((await fetch((await provider(mock, { signing: { key: other.key, cert: other.cert } }).begin({ redirectUri: ACS })).url)).status).toBe(403)
      expect(mock.signatures.slice(-2)).toEqual([undefined, { valid: false, sigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' }])
    } finally { sp.cleanup(); other.cleanup() }
  })

  it('encrypted_assertions_decrypt_with_the_sp_key_and_plain_ones_are_refused_when_required', async () => {
    const mock = await start(), sp = makeTestKeys('sp'), other = makeTestKeys('other')
    try {
      const sealed = () => provider(mock, { decryption: { key: sp.key, cert: sp.cert } })
      for (const sign of ['response', 'assertion', 'both'] as const) {
        expect((await login(mock, { sign, encryptFor: sp.cert }, sealed())).email, sign).toBe('alice@corp.example')
      }
      expect(await rejected(login(mock, {}, sealed()))).toBe('encryption')
      expect(await rejected(login(mock, { sign: 'assertion' }, sealed()))).toBe('encryption')
      // Encrypted to someone else, or unsigned inside the encryption: refused.
      expect(await rejected(login(mock, { encryptFor: other.cert }, sealed()))).toBe('assertion')
      expect(await rejected(login(mock, { sign: 'none', encryptFor: sp.cert }, sealed()))).toBe('signature')
      // Without a decryption key an encrypted assertion cannot be read: refused, never skipped.
      expect(await rejected(login(mock, { encryptFor: sp.cert }))).not.toBeUndefined()
    } finally { sp.cleanup(); other.cleanup() }
  })

  it('sp_metadata_publishes_the_signing_and_encryption_certificates', async () => {
    const mock = await start(), sign = makeTestKeys('sign'), enc = makeTestKeys('enc')
    try {
      const body = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s/g, '')
      const xml = provider(mock, { signing: { key: sign.key, cert: sign.cert }, decryption: { key: enc.key, cert: enc.cert } }).metadata!()
      expect(xml).toMatch(/AuthnRequestsSigned="true"/)
      expect(xml).toMatch(/<KeyDescriptor use="signing">[\s\S]*?<\/KeyDescriptor>/)
      expect(/<KeyDescriptor use="signing">([\s\S]*?)<\/KeyDescriptor>/.exec(xml)![1]!.replace(/\s/g, '')).toContain(body(sign.cert))
      expect(/<KeyDescriptor use="encryption">([\s\S]*?)<\/KeyDescriptor>/.exec(xml)![1]!.replace(/\s/g, '')).toContain(body(enc.cert))
      expect(xml).not.toContain(body(sign.key).slice(10, 60))
      expect(xml).not.toContain(body(enc.key).slice(10, 60))
      expect(provider(mock).metadata!()).not.toContain('KeyDescriptor')
    } finally { sign.cleanup(); enc.cleanup() }
  })
})
