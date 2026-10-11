import { describe, expect, it } from 'vitest'
import { parseContainerName, parseInstanceId, parseUnitName } from '../src/runtime.ts'

describe('runtime identifiers received from durable records', () => {
  it('accepts only bounded instance IDs and derived runtime names', () => {
    expect(parseInstanceId('launch_1-abc')).toBe('launch_1-abc')
    expect(parseContainerName('dsh-' + 'a'.repeat(24))).toBe('dsh-' + 'a'.repeat(24))
    expect(parseUnitName('dsh-user-' + 'a'.repeat(24) + '.service')).toBe('dsh-user-' + 'a'.repeat(24) + '.service')
  })
  it.each(['', '../etc', 'a'.repeat(129), 'launch.service'])('rejects invalid instance ID %s', value => {
    expect(() => parseInstanceId(value)).toThrow()
  })
  it.each(['other.service', 'dsh-user-' + 'A'.repeat(24) + '.service', 'dsh-user-' + 'a'.repeat(24) + '.service/../x'])('rejects a non-derived unit %s', value => {
    expect(() => parseUnitName(value)).toThrow()
  })
  it.each(['alice', 'dsh-' + 'a'.repeat(23), 'dsh-' + 'A'.repeat(24)])('rejects a non-derived container %s', value => {
    expect(() => parseContainerName(value)).toThrow()
  })
})
