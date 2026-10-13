/** A local SAML 2.0 IdP for tests: 127.0.0.1 only, keys generated per run with openssl into a temporary directory and never committed. */
import { execFileSync } from 'node:child_process'
import { createVerify, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { SignedXml } from 'xml-crypto'
import { encrypt } from 'xml-encryption'

export const MOCK_IDP_ENTITY_ID = 'https://idp.mock.test/saml'
export const MOCK_SP_ENTITY_ID = 'https://harness.mock.test/saml/sp'
const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'

/** A throwaway self-signed signing pair; `dir/idp.crt` is what the SP pins. */
export function makeTestKeys(name = 'idp'): { dir: string; certFile: string; keyFile: string; cert: string; key: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-saml-test-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=mock-${name}.test`, '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' })
  // Private keys are kept owner-only, as the SP requires of its own key files.
  chmodSync(join(dir, `${name}.key`), 0o600)
  return { dir, certFile: join(dir, `${name}.crt`), keyFile: join(dir, `${name}.key`), cert: readFileSync(join(dir, `${name}.crt`), 'utf8'), key: readFileSync(join(dir, `${name}.key`), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export interface SamlUser { nameId: string; format?: string; attributes: Record<string, string[]> }
/** Knobs for one response; each defaults to a correct, Response-signed answer for the pending request. */
export interface ResponseOptions {
  sign?: 'response' | 'assertion' | 'both' | 'none'
  key?: string
  issuer?: string
  audience?: string
  recipient?: string
  destination?: string | null
  inResponseTo?: string | null
  notBeforeOffsetMs?: number
  notOnOrAfterOffsetMs?: number
  status?: string
  /** Wrap the signed assertion away and put an unsigned forged one in its place. */
  wrap?: SamlUser
  assertionId?: string
  /** Encrypt the assertion to this SP certificate (EncryptedAssertion, AES-256-GCM with RSA-OAEP). */
  encryptFor?: string
}
export interface MockSaml {
  base: string
  ssoUrl: string
  user: SamlUser
  next: ResponseOptions
  keys: ReturnType<typeof makeTestKeys>
  /** When set, AuthnRequests must carry a valid HTTP-Redirect signature by this SP certificate; others get 403. */
  requireSignedBy?: string
  /** Signature checks of the requests seen: undefined when unsigned, else whether it verified and the SigAlg. */
  signatures: Array<{ valid: boolean; sigAlg: string } | undefined>
  /** Requests seen: ID, ACS URL, issuer, NameIDPolicy format. */
  requests: Array<{ id: string; acs: string; issuer: string; format: string | undefined }>
  /** Build a response for a request (exposed for direct tests). */
  respond(request: { id: string; acs: string }, options?: ResponseOptions): Promise<string>
  /** Follow the SP redirect like a browser and return the auto-post form fields. */
  login(url: string): Promise<{ action: string; SAMLResponse: string; RelayState: string }>
  close(): Promise<void>
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export async function startMockSaml(): Promise<MockSaml> {
  const keys = makeTestKeys()
  let server!: Server
  const sign = (xml: string, id: string, key: string, beforeIssuer: boolean) => {
    const signer = new SignedXml({ privateKey: key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' })
    signer.addReference({ xpath: `//*[@ID='${id}']`, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] })
    signer.computeSignature(xml, { location: { reference: `//*[@ID='${id}']/*[local-name()='Issuer']`, action: beforeIssuer ? 'after' : 'after' } })
    return signer.getSignedXml()
  }
  const assertion = (user: SamlUser, request: { id: string; acs: string }, o: ResponseOptions, id: string) => {
    const now = Date.now()
    const attrs = Object.entries(user.attributes).map(([name, values]) => `<saml:Attribute Name="${esc(name)}">${values.map(v => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('')
    const irt = o.inResponseTo === null ? '' : ` InResponseTo="${esc(o.inResponseTo ?? request.id)}"`
    return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${esc(o.issuer ?? MOCK_IDP_ENTITY_ID)}</saml:Issuer>`
      + `<saml:Subject><saml:NameID Format="${esc(user.format ?? PERSISTENT)}">${esc(user.nameId)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`
      + `<saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(now + (o.notOnOrAfterOffsetMs ?? 300_000))}" Recipient="${esc(o.recipient ?? request.acs)}"/></saml:SubjectConfirmation></saml:Subject>`
      + `<saml:Conditions NotBefore="${iso(now + (o.notBeforeOffsetMs ?? -60_000))}" NotOnOrAfter="${iso(now + (o.notOnOrAfterOffsetMs ?? 300_000))}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience ?? MOCK_SP_ENTITY_ID)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
      + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
      + `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion>`
  }
  const mock: MockSaml = {
    base: '', ssoUrl: '', keys, requests: [], signatures: [], next: {},
    user: { nameId: 'u-7f3a9c', attributes: { email: ['Alice@Corp.Example'], displayName: ['Alice'], groups: ['engineering', 'staff'] } },
    async respond(request, o = {}) {
      const key = o.key ?? keys.key, mode = o.sign ?? 'response'
      const responseId = `_r${randomBytes(12).toString('hex')}`, assertionId = o.assertionId ?? `_a${randomBytes(12).toString('hex')}`
      let body = assertion(mock.user, request, o, assertionId)
      if (mode === 'assertion' || mode === 'both') body = sign(body, assertionId, key, true)
      if (o.encryptFor !== undefined) {
        const cert = o.encryptFor
        const data = await new Promise<string>((resolve, reject) => encrypt(body, { rsa_pub: cert, pem: cert, encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
          keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p', disallowEncryptionWithInsecureAlgorithm: true }, (error, result) => error ? reject(error) : resolve(result)))
        body = `<saml:EncryptedAssertion>${data}</saml:EncryptedAssertion>`
      }
      if (o.wrap) {
        // XML signature wrapping: the signed assertion is hidden inside Extensions and a forged one takes its place.
        body = `<samlp:Extensions>${body}</samlp:Extensions>${assertion(o.wrap, request, o, `_f${randomBytes(8).toString('hex')}`)}`
      }
      const destination = o.destination === null ? '' : ` Destination="${esc(o.destination ?? request.acs)}"`
      const irt = o.inResponseTo === null ? '' : ` InResponseTo="${esc(o.inResponseTo ?? request.id)}"`
      let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(Date.now())}"${destination}${irt}>`
        + `<saml:Issuer>${esc(o.issuer ?? MOCK_IDP_ENTITY_ID)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${body}</samlp:Response>`
      if (mode === 'response' || mode === 'both') xml = sign(xml, responseId, key, true)
      return Buffer.from(xml).toString('base64')
    },
    async login(url) {
      const reply = await fetch(url, { redirect: 'manual' })
      const html = await reply.text()
      const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? ''
      return { action: /action="([^"]+)"/.exec(html)![1]!, SAMLResponse: field('SAMLResponse'), RelayState: field('RelayState') }
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => { keys.cleanup(); resolve() }) }),
  }
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', mock.base)
    if (url.pathname !== '/sso') { res.writeHead(404); res.end(); return }
    // HTTP-Redirect binding signature (saml-bindings-2.0-os §3.4.4.1): over the raw, still-encoded SAMLRequest, RelayState and SigAlg, in that order.
    const raw = new Map((url.search.slice(1).split('&').filter(Boolean)).map(part => { const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)] as [string, string] }))
    let check: { valid: boolean; sigAlg: string } | undefined
    if (raw.has('Signature')) {
      const signed = ['SAMLRequest', 'RelayState', 'SigAlg'].filter(name => raw.has(name)).map(name => `${name}=${raw.get(name)}`).join('&')
      const sigAlg = decodeURIComponent(raw.get('SigAlg') ?? '')
      const verifier = createVerify(sigAlg === 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' ? 'RSA-SHA256' : 'RSA-SHA1')
      verifier.update(signed)
      let valid = false
      try { valid = mock.requireSignedBy !== undefined && verifier.verify(mock.requireSignedBy, decodeURIComponent(raw.get('Signature')!), 'base64') } catch { valid = false }
      check = { valid, sigAlg }
    }
    mock.signatures.push(check)
    if (mock.requireSignedBy !== undefined && !check?.valid) { res.writeHead(403); res.end('signature required'); return }
    let xml: string
    try { xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8') } catch { res.writeHead(400); res.end(); return }
    const attr = (name: string) => new RegExp(`${name}="([^"]+)"`).exec(xml)?.[1]
    const request = { id: attr('ID') ?? '', acs: attr('AssertionConsumerServiceURL') ?? '', issuer: /Issuer[^>]*>([^<]+)</.exec(xml)?.[1] ?? '', format: attr('Format') }
    mock.requests.push(request)
    const response = await mock.respond(request, mock.next)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><form method="post" action="${esc(request.acs)}"><input type="hidden" name="SAMLResponse" value="${response}"><input type="hidden" name="RelayState" value="${esc(url.searchParams.get('RelayState') ?? '')}"><button>Continue</button></form><script>document.forms[0].submit()</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.ssoUrl = `${mock.base}/sso`
  return mock
}
