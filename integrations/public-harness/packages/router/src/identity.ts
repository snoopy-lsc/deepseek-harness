/** Signed production identity validation after the HTTPS forward-auth hop. */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { parseUserId, type UserId } from '@public-harness/contracts'
import { singleHeader, type IdentityVerifier } from './config.ts'

/** Trusted authentik signing keys and current account status. */
export interface ProductionIdentityConfig {
  readonly issuer: string
  readonly audience: string
  readonly publicKeys: Readonly<Record<string, string>>
  readonly isActive: (userId: UserId) => Promise<boolean>
  readonly clock?: () => Date
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid identity token')
  return value as Record<string, unknown>
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 8192) throw new Error('invalid identity token encoding')
  const bytes = Buffer.from(segment, 'base64url')
  if (bytes.toString('base64url') !== segment) throw new Error('invalid identity token encoding')
  return bytes
}

/** Build a verifier with locally configured public keys, not request-provided keys. */
export function createProductionIdentity(config: ProductionIdentityConfig): IdentityVerifier {
  const issuer = new URL(config.issuer)
  if (issuer.protocol !== 'https:' || !config.audience || !config.isActive) throw new Error('invalid production identity configuration')
  const keys = new Map<string, KeyObject>()
  for (const [kid, pem] of Object.entries(config.publicKeys)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(kid)) throw new Error('invalid identity key ID')
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('identity key must be RSA')
    keys.set(kid, key)
  }
  if (keys.size === 0) throw new Error('production identity keys are required')
  const clock = config.clock ?? (() => new Date())
  return {
    async verify(headers: IncomingHttpHeaders) {
      const token = singleHeader(headers, 'x-authentik-jwt')
      const uid = parseUserId(singleHeader(headers, 'x-authentik-uid'))
      if (token.length > 16384) throw new Error('identity token exceeds limit')
      const parts = token.split('.')
      if (parts.length !== 3) throw new Error('invalid identity token')
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
      const header = record(JSON.parse(decode(encodedHeader).toString('utf8')))
      const payload = record(JSON.parse(decode(encodedPayload).toString('utf8')))
      if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
        throw new Error('unsupported identity signature')
      }
      const key = keys.get(header.kid)
      if (key === undefined || !verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key, decode(encodedSignature))) throw new Error('invalid identity signature')
      const now = Math.floor(clock().valueOf() / 1000)
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(payload.exp) || Number(payload.exp) <= now
        || !Number.isSafeInteger(payload.iat) || Number(payload.iat) > now
        || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || Number(payload.nbf) > now))) {
        throw new Error('identity token expired or not yet valid')
      }
      if (payload.iss !== config.issuer) throw new Error('identity issuer mismatch')
      if (payload.aud !== config.audience) throw new Error('identity audience mismatch')
      if (typeof payload.sub !== 'string' || parseUserId(payload.sub) !== uid) throw new Error('identity UID mismatch')
      if (!await config.isActive(uid)) throw new Error('identity account inactive')
      return uid
    },
  }
}
