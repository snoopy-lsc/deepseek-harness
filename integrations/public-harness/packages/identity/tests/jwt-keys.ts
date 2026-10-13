import type { Jwk } from '../src/sso/jwt.ts'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

export interface TestKey { kid: string; alg: 'RS256' | 'ES256'; privateKey: KeyObject; jwk: Jwk }
/** Generate a throwaway signing key for a mock IdP. */
export function testKey(alg: 'RS256' | 'ES256', kid: string): TestKey {
  const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' } }
}
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
/** Sign a compact JWS. */
export function signJwt(payload: Record<string, unknown>, key: TestKey, header: Record<string, unknown> = {}): string {
  const input = `${b64({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header })}.${b64(payload)}`
  const signature = key.alg === 'RS256' ? sign('sha256', Buffer.from(input), key.privateKey) : sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}
