import { describe, expect, it } from 'vitest'
import { validateTeamDevConfig } from '../src/index.ts'

const config = { host: '127.0.0.1', storageRoot: '/tmp/team-dev', webPatch: '/tmp/web.patch.yml',
  command: '/usr/bin/node', args: ['/tmp/dsh.js'], users: ['alice', 'bob'],
  startupTimeoutMs: 90_000, stopTimeoutMs: 15_000, routeWaitMs: 90_000,
  launchExchangeMs: 10_000, socketLifetimeMs: 60_000, cookieLifetimeMs: 60_000 }

describe('team-dev profile configuration', () => {
  it('accepts fixed test users and local storage', () => {
    expect(validateTeamDevConfig(config)).toEqual(['alice', 'bob'])
  })

  it.each([
    [{ ...config, host: '0.0.0.0' }, 'loopback'],
    [{ ...config, users: [] }, 'user'],
    [{ ...config, users: ['alice', 'alice'] }, 'user'],
    [{ ...config, socketLifetimeMs: 60_001 }, 'socket'],
    [{ ...config, routeWaitMs: 0 }, 'positive'],
  ])('rejects an unsafe local profile', (value, message) => {
    expect(() => validateTeamDevConfig(value)).toThrow(new RegExp(message, 'i'))
  })
})
