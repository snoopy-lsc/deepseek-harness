/** Market npm bearer tokens: mint plaintext, store SHA-256, compare in constant time. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface MintedMarketToken {
  /** Plaintext bearer secret returned once to the provisioner / npmrc. */
  readonly token: string
  /** Hex SHA-256 stored on `plugin_endpoint.token_sha256`. */
  readonly tokenSha256: string
}

/** Hex SHA-256 of a market bearer token. */
export function hashMarketToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Draw a fresh opaque token and its stored hash. */
export function mintMarketToken(): MintedMarketToken {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenSha256: hashMarketToken(token) }
}

/** First 8 hex chars of a token hash for access logs (never the plaintext). */
export function tokenHashLogPrefix(tokenSha256: string): string {
  return tokenSha256.slice(0, 8)
}

/**
 * Constant-time check that `Authorization` is `Bearer <token>` whose SHA-256
 * equals the stored hash. Missing / wrong / empty stored hash → false.
 */
export function bearerMatches(authorization: string | undefined, tokenSha256: string | null | undefined): boolean {
  if (authorization === undefined || tokenSha256 === null || tokenSha256 === undefined || tokenSha256.length === 0) {
    return false
  }
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix)) return false
  const presented = authorization.slice(prefix.length)
  if (presented.length === 0) return false
  const actual = Buffer.from(hashMarketToken(presented), 'utf8')
  const expected = Buffer.from(tokenSha256, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
