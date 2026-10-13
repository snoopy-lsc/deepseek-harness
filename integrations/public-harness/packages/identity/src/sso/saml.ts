/** SAML 2.0 service provider: SP-initiated HTTP-Redirect AuthnRequest and HTTP-POST ACS, built on @node-saml/node-saml with extra checks it leaves out.
 * References: SAML 2.0 Core, Bindings and Profiles (OASIS, http://docs.oasis-open.org/security/saml/v2.0/), Web Browser SSO Profile
 * (saml-profiles-2.0-os §4.1), and the @node-saml/node-saml README https://github.com/node-saml/node-saml. */
import { createHash, randomBytes } from 'node:crypto'
import { SAML, SamlStatusError, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml'
import { DOMParser } from '@xmldom/xmldom'
import * as xpath from 'xpath'
import type { SsoConfig } from './config.ts'
import { SsoRejectedError, type SsoIdentity, type SsoProvider } from './provider.ts'

type SamlConfig = Extract<SsoConfig, { kind: 'saml' }>

const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,255}$/
/** Largest accepted SAMLResponse (base64), matching the ACS body limit. */
const MAX_RESPONSE = 512 * 1024
const select = xpath.useNamespaces({ saml: 'urn:oasis:names:tc:SAML:2.0:assertion', samlp: 'urn:oasis:names:tc:SAML:2.0:protocol' })

/** Stand-in address when the IdP sends no usable email attribute; same rule as WeCom and DingTalk.
 * @param subject Entity-scoped subject.
 * @returns Placeholder address.
 */
export function samlPlaceholderEmail(subject: string): string {
  return `saml-${createHash('sha256').update(`saml\0${subject}`).digest('hex').slice(0, 32)}@sso.invalid`
}

/** Create the SAML provider.
 * @param config SAML settings from `DSH_SAML_*`.
 * @param deps ACS URL, the assertion replay check (true when the ID was unused) and an optional clock.
 * @returns Provider; every invalid response raises `SsoRejectedError`, so sign-in fails closed.
 */
export function createSamlProvider(config: SamlConfig, deps: { acsUrl: string; replay: (assertionId: string, expiresAt: number) => boolean; clock?: () => number }): SsoProvider {
  const clock = deps.clock ?? Date.now
  const saml = (requestId: string | undefined) => {
    // InResponseTo is bound to the request ID stored with this browser's single-use state, never to a process-wide cache.
    const cacheProvider: CacheProvider = {
      saveAsync: async () => null,
      // node-saml reads the value as the request's creation time.
      getAsync: async key => requestId !== undefined && key === requestId ? new Date(clock()).toISOString() : null,
      removeAsync: async () => null,
    }
    return new SAML({
      callbackUrl: deps.acsUrl, entryPoint: config.idpSsoUrl, issuer: config.spEntityId, audience: config.spEntityId, idpIssuer: config.idpEntityId,
      idpCert: [...config.idpCerts], identifierFormat: config.nameIdFormat, wantAuthnResponseSigned: false, wantAssertionsSigned: config.wantAssertionsSigned,
      acceptedClockSkewMs: config.clockSkewMs, disableRequestedAuthnContext: true, validateInResponseTo: ValidateInResponseTo.always, cacheProvider,
      generateUniqueId: () => requestId ?? `_${randomBytes(20).toString('hex')}`,
    })
  }
  const reject = (code: string): never => { throw new SsoRejectedError(code) }

  return {
    kind: 'saml',
    async begin() {
      const secrets = { state: randomBytes(32).toString('base64url'), nonce: `_${randomBytes(20).toString('hex')}`, verifier: randomBytes(32).toString('base64url') }
      // HTTP-Redirect binding: deflated, unsigned AuthnRequest; RelayState carries the state the ACS uses to find this attempt.
      return { url: await saml(secrets.nonce).getAuthorizeUrlAsync(secrets.state, undefined, {}), secrets }
    },
    async finish({ code, nonce }): Promise<SsoIdentity> {
      if (!code || code.length > MAX_RESPONSE || !/^[A-Za-z0-9+/]+={0,2}$/.test(code)) reject('signature')
      let profile: Profile | null = null
      try { ({ profile } = await saml(nonce).validatePostResponseAsync({ SAMLResponse: code })) } catch (error) {
        if (error instanceof SamlStatusError) reject('idp')
        // Signature failures, XML signature wrapping (several or moved assertions) and malformed XML all land here.
        reject(/signature|signed data|xml|parse|certificate/i.test(error instanceof Error ? error.message : '') ? 'signature' : 'assertion')
      }
      if (profile === null || profile === undefined) return reject('assertion')
      // node-saml checks signatures, audience, time and InResponseTo; the rest of the Web Browser SSO profile is checked here, on the verified XML only.
      const assertionXml = profile.getAssertionXml?.(), responseXml = profile.getSamlResponseXml?.()
      if (assertionXml === undefined || responseXml === undefined) return reject('assertion')
      const parse = (xml: string) => new DOMParser({ errorHandler: { error: () => reject('assertion'), fatalError: () => reject('assertion') } }).parseFromString(xml, 'text/xml')
      const assertion = parse(assertionXml), response = parse(responseXml)
      const text = (doc: Document, path: string) => { const nodes = select(path, doc) as Node[]; return nodes.length === 1 ? nodes[0]!.nodeValue ?? nodes[0]!.textContent ?? '' : undefined }
      // The Response itself may be unsigned when only the Assertion is; its Status and Destination can then only be made stricter, never looser.
      if (text(response, '/samlp:Response/samlp:Status/samlp:StatusCode/@Value') !== SUCCESS) reject('idp')
      const destination = text(response, '/samlp:Response/@Destination')
      if (destination !== undefined && destination !== deps.acsUrl) reject('assertion')
      if (text(assertion, '/saml:Assertion/saml:Issuer/text()') !== config.idpEntityId) reject('assertion')
      const now = clock()
      const confirmations = (select(`/saml:Assertion/saml:Subject/saml:SubjectConfirmation[@Method='${BEARER}']/saml:SubjectConfirmationData`, assertion) as Element[])
        .filter(data => data.getAttribute('Recipient') === deps.acsUrl && data.getAttribute('InResponseTo') === nonce
          && Date.parse(data.getAttribute('NotOnOrAfter') ?? '') + config.clockSkewMs > now)
      if (!confirmations.length) reject('assertion')
      const id = text(assertion, '/saml:Assertion/@ID')
      const until = Date.parse(text(assertion, '/saml:Assertion/saml:Conditions/@NotOnOrAfter') ?? confirmations[0]!.getAttribute('NotOnOrAfter') ?? '')
      if (!id || !Number.isFinite(until)) return reject('assertion')
      if (!deps.replay(id, until + config.clockSkewMs)) reject('replay')

      // Persistent IDs are preferred; transient IDs change per login and could never find the account again.
      const format = profile.nameIDFormat
      if (format === TRANSIENT || format !== config.nameIdFormat || typeof profile.nameID !== 'string' || !profile.nameID || profile.nameID.length > 512) reject('nameid')
      const subject = `${config.idpEntityId}|${profile.nameID}`
      const values = (name: string) => { const value = profile[name]; return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string') }
      const groups = [...new Set(values(config.groupAttribute).map(group => group.trim()).filter(group => group && group.length <= 256))]
      const mail = values(config.emailAttribute).map(value => value.trim()).find(value => EMAIL.test(value))
      const name = values(config.nameAttribute).map(value => value.trim()).find(Boolean) ?? profile.nameID
      return { subject, email: mail?.toLowerCase() ?? samlPlaceholderEmail(subject), name: name.slice(0, 128), groups }
    },
    metadata: () => saml(undefined).generateServiceProviderMetadata(null, null),
  }
}
