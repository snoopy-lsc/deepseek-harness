/** Short-lived, instance-bound credentials for the model quota proxy. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseUserId, type UserId } from '@public-harness/contracts'

/** A token and its Unix-epoch expiry for private credential-file rotation. */
export interface IssuedToken { readonly token: string; readonly expiresAt: number }

/** Signing configuration shared only by the quota service and its control path. */
export interface TokenIssuerConfig {
  readonly secret: Buffer
  readonly issuer: string
  readonly lifetimeMs: number
  readonly clock?: () => Date
}

/** Issue and verify credentials for a single deployment environment. */
export interface TokenIssuer {
  issue(userId: UserId, instanceId: string): IssuedToken
  verify(token: string, instanceId: string): UserId
}

function validInstanceId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid instance identity')
}

/** Create a credential issuer with a strict fifteen-minute maximum lifetime. */
export function createTokenIssuer(config: TokenIssuerConfig): TokenIssuer {
  if (config.secret.length < 32 || !/^[A-Za-z0-9_-]{1,128}$/.test(config.issuer)
    || !Number.isSafeInteger(config.lifetimeMs) || config.lifetimeMs < 1 || config.lifetimeMs > 900_000) {
    throw new Error('invalid quota credential configuration')
  }
  const now = (): number => {
    const value = (config.clock?.() ?? new Date()).valueOf()
    if (!Number.isSafeInteger(value)) throw new Error('invalid quota credential clock')
    return value
  }
  const signature = (payload: string): Buffer => createHmac('sha256', config.secret).update(payload).digest()
  return {
    issue(userId, instanceId) {
      validInstanceId(instanceId)
      const issuedAt = now()
      const expiresAt = issuedAt + config.lifetimeMs
      const payload = Buffer.from(JSON.stringify({ version: 1, issuer: config.issuer, userId,
        instanceId, issuedAt, expiresAt, nonce: randomBytes(16).toString('base64url') })).toString('base64url')
      return { token: `${payload}.${signature(payload).toString('base64url')}`, expiresAt }
    },
    verify(token, instanceId) {
      validInstanceId(instanceId)
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid quota token')
      const [payload, mac] = token.split('.')
      const expected = signature(payload!)
      const actual = Buffer.from(mac!, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid quota token signature')
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) }
      catch { throw new Error('invalid quota token payload') }
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('invalid quota token payload')
      const record = decoded as Record<string, unknown>
      if (Object.keys(record).sort().join(',') !== 'expiresAt,instanceId,issuedAt,issuer,nonce,userId,version'
        || record.version !== 1 || typeof record.issuer !== 'string'
        || typeof record.userId !== 'string' || typeof record.instanceId !== 'string'
        || typeof record.issuedAt !== 'number' || !Number.isSafeInteger(record.issuedAt)
        || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)
        || typeof record.nonce !== 'string') throw new Error('invalid quota token payload')
      if (record.issuer !== config.issuer) throw new Error('quota token issuer mismatch')
      if (record.instanceId !== instanceId) throw new Error('quota token instance mismatch')
      if (record.issuedAt > now() || record.expiresAt <= now()
        || record.expiresAt - record.issuedAt > config.lifetimeMs) throw new Error('quota token expired')
      return parseUserId(record.userId)
    },
  }
}
