/** Compact JWS verification for ID tokens: RS256 and ES256 only, key chosen by `kid`, no `none` or shared-secret algorithms. */
import { createPublicKey, verify, type JsonWebKey as NodeJwk } from 'node:crypto'
import { SsoRejectedError } from './provider.ts'

/** A published JSON Web Key, as found in an issuer's JWKS document. */
export interface Jwk { readonly kty?: unknown; readonly kid?: unknown; readonly alg?: unknown; readonly use?: unknown; readonly crv?: unknown; readonly [field: string]: unknown }

const ALGORITHMS = { RS256: 'RSA', ES256: 'EC' } as const

function decode(segment: string | undefined): Record<string, unknown> {
  if (segment === undefined || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new SsoRejectedError('token-malformed')
  let value: unknown
  try { value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) } catch { throw new SsoRejectedError('token-malformed') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SsoRejectedError('token-malformed')
  return value as Record<string, unknown>
}

/** Verify a compact JWS and return its claims.
 * @param token Compact serialization.
 * @param keys The issuer's published JWKs.
 * @returns Claims; throws `SsoRejectedError` for anything that does not verify.
 */
export function verifyJws(token: string, keys: readonly Jwk[]): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new SsoRejectedError('token-malformed')
  const header = decode(parts[0]), claims = decode(parts[1])
  const alg = header.alg
  if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) throw new SsoRejectedError('token-algorithm')
  const kty = ALGORITHMS[alg as keyof typeof ALGORITHMS]
  const candidates = keys.filter(key => key.kid === header.kid && key.kty === kty && (key.alg === undefined || key.alg === alg)
    && (key.use === undefined || key.use === 'sig') && (kty !== 'EC' || key.crv === 'P-256'))
  if (candidates.length !== 1) throw new SsoRejectedError('token-key')
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw new SsoRejectedError('token-malformed')
  let ok = false
  try {
    const key = createPublicKey({ key: candidates[0] as unknown as NodeJwk, format: 'jwk' })
    ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), kty === 'EC' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2]!, 'base64url'))
  } catch { ok = false }
  if (!ok) throw new SsoRejectedError('token-signature')
  return claims
}
