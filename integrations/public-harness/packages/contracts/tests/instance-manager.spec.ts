import { describe, expect, it } from 'vitest'
import { parseInstanceEndpoint, parseUserId } from '../src/index.ts'

describe('instance manager input', () => {
  it('accepts canonical opaque user IDs', () => {
    expect(parseUserId('Alice_01-Z')).toBe('Alice_01-Z')
    expect(parseUserId('x'.repeat(128))).toHaveLength(128)
  })

  it.each(['', 'a/b', '../alice', 'a\\b', 'a.b', 'üser', 'Ａlice', 'x'.repeat(129)])('rejects noncanonical ID %j', value => {
    expect(() => parseUserId(value)).toThrow()
  })

  it('accepts only a loopback TCP endpoint or an absolute Unix socket', () => {
    expect(parseInstanceEndpoint({ kind: 'tcp', host: '127.0.0.1', port: 3412 }))
      .toEqual({ kind: 'tcp', host: '127.0.0.1', port: 3412 })
    expect(parseInstanceEndpoint({ kind: 'unix', path: '/tmp/harness.sock' }))
      .toEqual({ kind: 'unix', path: '/tmp/harness.sock' })
  })

  it.each([
    { kind: 'tcp', host: '0.0.0.0', port: 3412 },
    { kind: 'tcp', host: '127.0.0.1', port: 0 },
    { kind: 'tcp', host: '127.0.0.1', port: 65536 },
    { kind: 'unix', path: 'relative.sock' },
    { kind: 'unix', path: '/tmp/a.sock', extra: true },
    { kind: 'other', path: '/tmp/a.sock' },
  ])('rejects unsafe endpoint %j', endpoint => {
    expect(() => parseInstanceEndpoint(endpoint)).toThrow()
  })
})
