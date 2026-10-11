import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDevelopmentIdentity } from '../src/dev-identity.ts'

const secret = randomBytes(32)
const now = 1_760_000_000_000
const config = { mode: 'team-dev' as const, host: '127.0.0.1' as const, secret,
  testUsers: ['alice', 'bob'], lifetimeMs: 60_000, clock: () => new Date(now) }

describe('local test-user identity', () => {
  it('issues a signed cookie only for a fixed test user', async () => {
    const dev = createDevelopmentIdentity(config)
    const cookie = dev.issue('alice')
    expect(await dev.verify({ cookie })).toBe('alice')
    expect(() => dev.issue('mallory')).toThrow(/test user/i)
  })

  it('rejects missing, changed, duplicate, and expired cookies', async () => {
    const dev = createDevelopmentIdentity(config)
    const cookie = dev.issue('alice')
    await expect(dev.verify({})).rejects.toThrow()
    await expect(dev.verify({ cookie: `${cookie}x` })).rejects.toThrow()
    await expect(dev.verify({ cookie: `${cookie}; ${cookie}` })).rejects.toThrow()
    const later = createDevelopmentIdentity({ ...config, clock: () => new Date(now + 61_000) })
    await expect(later.verify({ cookie })).rejects.toThrow(/expired/i)
  })

  it('refuses production mode and any public bind', () => {
    expect(() => createDevelopmentIdentity({ ...config, mode: 'production' })).toThrow(/team-dev/i)
    expect(() => createDevelopmentIdentity({ ...config, host: '0.0.0.0' })).toThrow(/loopback/i)
  })
})
