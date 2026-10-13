import { describe, expect, it } from 'vitest'
import { newTotpSecret, otpauthUri, totp, verifyTotp } from '../src/sso/totp.ts'

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", truncated to six digits.
const SEED = Buffer.from('12345678901234567890', 'ascii')
const VECTORS: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]

describe('TOTP', () => {
  it('matches_rfc6238_vectors', () => {
    for (const [seconds, code] of VECTORS) expect(totp(SEED, Math.floor(seconds / 30))).toBe(code)
  })

  it('verifies_within_one_step_and_returns_the_step', () => {
    const now = 1111111111 * 1000, step = Math.floor(now / 30_000)
    expect(verifyTotp(SEED, '050471', now)).toBe(step)
    expect(verifyTotp(SEED, totp(SEED, step - 1), now)).toBe(step - 1)
    expect(verifyTotp(SEED, totp(SEED, step + 1), now)).toBe(step + 1)
    expect(verifyTotp(SEED, totp(SEED, step - 2), now)).toBeUndefined()
    for (const bad of ['', '05047', '0504711', 'abcdef', ' 050471']) expect(verifyTotp(SEED, bad, now)).toBeUndefined()
  })

  it('new_secrets_are_random_and_enrollable', () => {
    const a = newTotpSecret(), b = newTotpSecret()
    expect(a).toHaveLength(20)
    expect(a.equals(b)).toBe(false)
    const uri = new URL(otpauthUri(SEED, 'admin@example.test', 'DeepSeek Harness'))
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(uri.searchParams.get('algorithm')).toBe('SHA1')
    expect(uri.searchParams.get('digits')).toBe('6')
    expect(uri.searchParams.get('period')).toBe('30')
  })
})
