import { generateKeyPairSync, sign } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createProductionIdentity } from '../src/identity.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const now = 1_760_000_000
const active = vi.fn(async () => true)
const verifier = () => createProductionIdentity({ issuer: 'https://login.example.test/',
  audience: 'public-harness', publicKeys: { current: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  isActive: active, clock: () => new Date(now * 1000) })
const jwt = (claims: Record<string, unknown>, kid = 'current') => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: 'https://login.example.test/', aud: 'public-harness',
    sub: 'alice', exp: now + 60, iat: now, ...claims })).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
}
const headers = (token: string, uid: string | string[] = 'alice') => ({ 'x-authentik-jwt': token, 'x-authentik-uid': uid })

describe('production identity verification', () => {
  it('accepts a signed active identity with matching UID', async () => {
    expect(await verifier().verify(headers(jwt({})))).toBe('alice')
  })

  it.each([
    [headers(jwt({ exp: now - 1 })), 'expired'],
    [headers(jwt({ iss: 'https://other.test/' })), 'issuer'],
    [headers(jwt({ aud: 'other-app' })), 'audience'],
    [headers(jwt({ sub: 'bob' })), 'UID'],
    [headers(jwt({}), ['alice', 'alice']), 'duplicate'],
    [headers(jwt({}), 'alice,bob'), 'UID'],
    [{ 'x-authentik-uid': 'alice' }, 'missing'],
    [headers(jwt({}), 'bob'), 'UID'],
    [headers(jwt({}), 'alice'), 'signature'],
  ])('rejects an invalid identity (%s)', async (value, reason) => {
    const received: IncomingHttpHeaders = { ...value }
    if (reason === 'signature') received['x-authentik-jwt'] = `${jwt({}).slice(0, -2)}aa`
    await expect(verifier().verify(received)).rejects.toThrow()
  })

  it('accepts a rotated configured key and denies an unknown key', async () => {
    expect(await verifier().verify(headers(jwt({}, 'current')))).toBe('alice')
    await expect(verifier().verify(headers(jwt({}, 'removed')))).rejects.toThrow()
  })

  it('denies suspended users after a valid signature', async () => {
    active.mockResolvedValueOnce(false)
    await expect(verifier().verify(headers(jwt({})))).rejects.toThrow(/inactive/i)
  })
})
