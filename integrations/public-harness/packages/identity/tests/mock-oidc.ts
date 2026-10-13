/** A local OpenID Connect provider for tests: 127.0.0.1 only, throwaway keys, no real secrets. */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { signJwt, testKey, type TestKey } from './jwt-keys.ts'

export const MOCK_CLIENT_ID = 'harness-test'
/** Test-only value; the mock IdP is the only party that knows it. */
export const MOCK_CLIENT_SECRET = 'mock-idp-test-only-value'
export interface MockUser { sub: string; email?: string; name?: string; groups?: unknown; [claim: string]: unknown }
export interface MockIdp {
  issuer: string
  /** Who the next authorization signs in. */
  user: MockUser
  keys: TestKey[]
  /** Claims merged into the next ID tokens (e.g. a wrong `aud`). */
  override: Record<string, unknown>
  /** Fields merged into the discovery document. */
  discovery: Record<string, unknown>
  /** Status the token endpoint answers with instead of a token, when set. */
  tokenStatus?: number
  /** Delay before every answer, to exercise timeouts. */
  delayMs: number
  /** Client authentication methods seen at the token endpoint. */
  authMethods: string[]
  jwksFetches: number
  /** Authorization-endpoint handler for tests that skip the browser: returns the redirect target. */
  authorize(url: string): Promise<URL>
  close(): Promise<void>
}

const b64url = (buffer: Buffer) => buffer.toString('base64url')

/** Start the mock IdP on an ephemeral 127.0.0.1 port. */
export async function startMockIdp(user: MockUser = { sub: 'emp-001', email: 'alice@corp.example', name: 'Alice', groups: ['engineering'] }): Promise<MockIdp> {
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; user: MockUser }>()
  let server!: Server
  const idp: MockIdp = {
    issuer: '', user, keys: [testKey('RS256', 'k1')], override: {}, discovery: {}, delayMs: 0, authMethods: [], jwksFetches: 0,
    async authorize(url) {
      const reply = await fetch(url, { redirect: 'manual' })
      return new URL(reply.headers.get('location')!)
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
  server = createServer((req, res) => {
    void (async () => {
      if (idp.delayMs) await new Promise(resolve => setTimeout(resolve, idp.delayMs))
      const url = new URL(req.url ?? '/', idp.issuer)
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256', 'ES256'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], ...idp.discovery })
      }
      if (url.pathname === '/jwks') { idp.jwksFetches++; return json(200, { keys: idp.keys.map(key => key.jwk) }) }
      if (url.pathname === '/authorize') {
        const q = url.searchParams
        if (q.get('client_id') !== MOCK_CLIENT_ID || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256'
          || !q.get('scope')?.split(' ').includes('openid') || !q.get('state') || !q.get('nonce') || !q.get('code_challenge')) return json(400, { error: 'invalid_request' })
        const code = b64url(randomBytes(16))
        codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirectUri: q.get('redirect_uri')!, user: { ...idp.user } })
        const target = new URL(q.get('redirect_uri')!)
        target.searchParams.set('code', code); target.searchParams.set('state', q.get('state')!)
        res.writeHead(302, { location: target.href }); res.end(); return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += String(chunk)
        const form = new URLSearchParams(body)
        let id = form.get('client_id'), secret = form.get('client_secret')
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')
        if (basic) {
          const [user, pass] = Buffer.from(basic[1]!, 'base64').toString().split(':').map(part => decodeURIComponent(part.replace(/\+/g, ' ')))
          id = user ?? null; secret = pass ?? null; idp.authMethods.push('client_secret_basic')
        } else idp.authMethods.push('client_secret_post')
        if (idp.tokenStatus !== undefined) return json(idp.tokenStatus, { error: 'server_error' })
        if (id !== MOCK_CLIENT_ID || secret !== MOCK_CLIENT_SECRET) return json(401, { error: 'invalid_client' })
        const entry = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (form.get('grant_type') !== 'authorization_code' || entry === undefined || entry.redirectUri !== form.get('redirect_uri')
          || b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== entry.challenge) return json(400, { error: 'invalid_grant' })
        const now = Math.floor(Date.now() / 1000)
        const id_token = signJwt({ iss: idp.issuer, aud: MOCK_CLIENT_ID, iat: now, exp: now + 300, nonce: entry.nonce, ...entry.user, ...idp.override }, idp.keys.at(-1)!)
        return json(200, { access_token: b64url(randomBytes(16)), token_type: 'Bearer', expires_in: 300, id_token })
      }
      json(404, { error: 'not_found' })
    })().catch(() => { res.destroy() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return idp
}
