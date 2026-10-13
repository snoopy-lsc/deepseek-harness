import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyJws, type Jwk } from '../src/sso/jwt.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { signJwt, testKey } from './jwt-keys.ts'

const rsa = testKey('RS256', 'r1'), ec = testKey('ES256', 'e1'), other = testKey('RS256', 'r1')
const claims = { iss: 'https://idp.example.test', sub: 'alice' }
const reject = (token: string, keys: Jwk[]) => {
  try { verifyJws(token, keys) } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}

describe('JWS verification', () => {
  it('accepts_rs256_and_es256_with_matching_kid', () => {
    expect(verifyJws(signJwt(claims, rsa), [ec.jwk, rsa.jwk])).toEqual(claims)
    expect(verifyJws(signJwt(claims, ec), [rsa.jwk, ec.jwk])).toEqual(claims)
  })

  it('rejects_unsafe_algorithms_wrong_keys_and_tampering', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const none = `${b64({ alg: 'none', kid: 'r1' })}.${b64(claims)}.`
    expect(reject(none, [rsa.jwk])).toBe('token-algorithm')
    const hsInput = `${b64({ alg: 'HS256', kid: 'r1' })}.${b64(claims)}`
    expect(reject(`${hsInput}.${createHmac('sha256', 'secret').update(hsInput).digest('base64url')}`, [rsa.jwk])).toBe('token-algorithm')
    expect(reject(signJwt(claims, other), [rsa.jwk])).toBe('token-signature')
    expect(reject(signJwt(claims, rsa, { kid: 'missing' }), [rsa.jwk])).toBe('token-key')
    // A key published for one algorithm cannot verify another.
    expect(reject(signJwt(claims, rsa, { kid: 'e1' }), [ec.jwk])).toBe('token-key')
    const [head, , sig] = signJwt(claims, rsa).split('.')
    expect(reject(`${head}.${b64({ ...claims, sub: 'mallory' })}.${sig}`, [rsa.jwk])).toBe('token-signature')
    for (const bad of ['', 'a.b', 'a.b.c.d', '!!.??.**', `${head}.notjson.${sig}`]) expect(reject(bad, [rsa.jwk])).toBe('token-malformed')
  })
})
