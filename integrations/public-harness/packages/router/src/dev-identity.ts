/** Signed local test-user cookies available only in the loopback profile. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseUserId, type UserId } from '@public-harness/contracts'
import { singleHeader, type IdentityVerifier } from './config.ts'

/** Fixed local identities and private signer for one development profile. */
export interface DevelopmentIdentityConfig {
  readonly mode: string
  readonly host: string
  readonly secret: Uint8Array
  readonly testUsers: readonly string[]
  readonly lifetimeMs: number
  readonly clock?: () => Date
}

/** Issue test-user cookies and verify them on each browser request. */
export function createDevelopmentIdentity(config: DevelopmentIdentityConfig): IdentityVerifier & {
  issue(userId: string): string
} {
  if (config.mode !== 'team-dev') throw new Error('development identity requires team-dev mode')
  if (config.host !== '127.0.0.1') throw new Error('development identity requires loopback')
  if (config.secret.byteLength < 32 || !Number.isSafeInteger(config.lifetimeMs)
    || config.lifetimeMs <= 0 || config.lifetimeMs > 3_600_000) throw new Error('invalid development identity settings')
  const users = new Set(config.testUsers.map(parseUserId))
  if (users.size === 0 || users.size !== config.testUsers.length) throw new Error('fixed test users are required')
  const clock = config.clock ?? (() => new Date())
  const sign = (payload: string): string => createHmac('sha256', config.secret).update(payload).digest('base64url')
  return {
    issue(value: string) {
      const userId = parseUserId(value)
      if (!users.has(userId)) throw new Error('unknown test user')
      const now = clock().valueOf()
      if (!Number.isSafeInteger(now)) throw new Error('invalid development identity clock')
      const payload = Buffer.from(JSON.stringify({ userId, issuedAt: now,
        expiresAt: now + config.lifetimeMs, nonce: randomBytes(8).toString('base64url') })).toString('base64url')
      return `team_dev=${payload}.${sign(payload)}`
    },
    async verify(headers) {
      const cookie = singleHeader(headers, 'cookie')
      const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('team_dev='))
      if (matches.length !== 1) throw new Error('missing or duplicate development cookie')
      const token = matches[0]!.slice('team_dev='.length)
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid development cookie')
      const [payload, signature] = token.split('.') as [string, string]
      const expected = Buffer.from(sign(payload))
      const actual = Buffer.from(signature)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid development cookie signature')
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
      catch { throw new Error('invalid development cookie payload') }
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('invalid development cookie payload')
      const value = decoded as Record<string, unknown>
      if (typeof value.userId !== 'string' || !Number.isSafeInteger(value.issuedAt)
        || !Number.isSafeInteger(value.expiresAt) || typeof value.nonce !== 'string') throw new Error('invalid development cookie payload')
      const userId: UserId = parseUserId(value.userId)
      const now = clock().valueOf()
      if (!users.has(userId) || Number(value.expiresAt) <= now || Number(value.issuedAt) > now
        || Number(value.expiresAt) - Number(value.issuedAt) !== config.lifetimeMs) throw new Error('development cookie expired or unknown user')
      return userId
    },
  }
}
