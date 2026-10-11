import { describe, expect, it } from 'vitest'
import { validateTeamDevConfig } from '../src/index.ts'

const config = { host: '127.0.0.1', storageRoot: '/tmp/team-dev', webPatch: '/tmp/web.patch.yml',
  command: '/usr/bin/node', args: ['/tmp/dsh.js'], users: ['alice', 'bob'],
  startupTimeoutMs: 90_000, stopTimeoutMs: 15_000, routeWaitMs: 90_000, retryAfterSeconds: 2,
  launchExchangeMs: 10_000, socketLifetimeMs: 60_000, cookieLifetimeMs: 60_000,
  storageLock: { staleMs: 120_000, updateMs: 10_000 },
  quota: { modelId: 'team-dev-mock', contextWindow: 4096, maxTokens: 1024,
    personalDailyTokens: 100_000, siteDailyTokens: 200_000,
    personalConcurrency: 2, siteConcurrency: 8, busyTimeoutMs: 5000,
    maxBodyBytes: 1_048_576, maxImagesPerRequest: 4, maxInlineImageBytes: 262_144,
    maxEventBytes: 65_536, maxFileBodyBytes: 1_048_576,
    credentialLifetimeMs: 600_000, credentialRotateMs: 480_000 } }

describe('team-dev profile configuration', () => {
  it('accepts fixed test users and local storage', () => {
    expect(validateTeamDevConfig(config)).toEqual(['alice', 'bob'])
  })

  it.each([
    [{ ...config, host: '0.0.0.0' }, 'loopback'],
    [{ ...config, users: [] }, 'user'],
    [{ ...config, users: ['alice', 'alice'] }, 'user'],
    [{ ...config, users: ['Alice', 'alice'] }, 'user'],
    [{ ...config, users: ['CON'] }, 'user'],
    [{ ...config, storageLock: { staleMs: 5000, updateMs: 3000 } }, 'lock'],
    [{ ...config, socketLifetimeMs: 60_001 }, 'socket'],
    [{ ...config, routeWaitMs: 0 }, 'positive'],
    [{ ...config, quota: { ...config.quota, personalDailyTokens: 100 } }, 'quota budget'],
    [{ ...config, quota: { ...config.quota, credentialRotateMs: 600_000 } }, 'rotation'],
  ])('rejects an unsafe local profile', (value, message) => {
    expect(() => validateTeamDevConfig(value)).toThrow(new RegExp(message, 'i'))
  })
})
