import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AUDIT_RETENTION_MS, createSsoStore, SsoBindingError, STATE_TTL_MS } from '../src/sso/store.ts'
import { ipAllowed, validIpEntry } from '../src/sso/ip.ts'

const store = () => createSsoStore(new DatabaseSync(':memory:'))
const record = { browser: 'browser-a', nonce: 'n', verifier: 'v', returnTo: '/account/' }

describe('SSO store', () => {
  it('login_state_is_single_use_browser_bound_and_expires', () => {
    const db = new DatabaseSync(':memory:'), s = createSsoStore(db)
    s.saveState('state-1', record, 1000)
    expect(s.takeState('state-1', 'browser-a', 2000)).toEqual({ nonce: 'n', verifier: 'v', returnTo: '/account/' })
    expect(s.takeState('state-1', 'browser-a', 2000)).toBeUndefined()
    s.saveState('state-2', record, 1000)
    // A callback from another browser burns the state, so the rightful browser cannot be raced afterwards either.
    expect(s.takeState('state-2', 'browser-b', 2000)).toBeUndefined()
    expect(s.takeState('state-2', 'browser-a', 2000)).toBeUndefined()
    s.saveState('state-3', record, 1000)
    expect(s.takeState('state-3', 'browser-a', 1000 + STATE_TTL_MS)).toBeUndefined()
    expect(STATE_TTL_MS).toBe(10 * 60_000)
    // Only hashes are stored.
    s.saveState('state-4', record, 1000)
    const raw = JSON.stringify(db.prepare('SELECT * FROM dsh_sso_state').all())
    expect(raw).toContain('browser')
    expect(raw).not.toContain('state-')
  })

  it('subject_binding_is_unique_and_never_reaches_invite_or_emergency_accounts', () => {
    const s = store()
    s.setOrigin('u1', 'sso')
    s.bindSubject('oidc', 'sub-1', 'u1', 1)
    expect(s.findSubject('oidc', 'sub-1')).toBe('u1')
    expect(s.findSubject('oidc', 'sub-2')).toBeUndefined()
    expect(() => s.bindSubject('oidc', 'sub-2', 'u1', 1)).toThrow(SsoBindingError)
    s.setOrigin('u2', 'sso')
    expect(() => s.bindSubject('oidc', 'sub-1', 'u2', 1)).toThrow(SsoBindingError)
    s.setOrigin('contractor', 'invite')
    expect(() => s.bindSubject('oidc', 'sub-3', 'contractor', 1)).toThrow(SsoBindingError)
    expect(() => s.setOrigin('contractor', 'sso')).toThrow(SsoBindingError)
    expect(() => s.bindSubject('oidc', 'sub-4', 'legacy', 1)).toThrow(SsoBindingError)
    expect(() => s.setOrigin('u1', 'emergency')).toThrow(SsoBindingError)
    s.setOrigin('admin', 'invite'); s.setOrigin('admin', 'emergency')
    expect(s.origin('admin')).toBe('emergency')
    expect(() => s.bindSubject('oidc', 'sub-5', 'admin', 1)).toThrow(SsoBindingError)
    expect(s.findSubject('oidc', 'sub-3')).toBeUndefined()
  })

  it('totp_steps_are_single_use', () => {
    const s = store()
    s.enrollEmergency('admin', 'sealed', 1)
    expect(s.emergencySecret('admin')).toBe('sealed')
    expect(s.useTotpStep('admin', 100)).toBe(true)
    expect(s.useTotpStep('admin', 100)).toBe(false)
    expect(s.useTotpStep('admin', 99)).toBe(false)
    expect(s.useTotpStep('admin', 101)).toBe(true)
    expect(s.useTotpStep('nobody', 500)).toBe(false)
    expect(s.listEmergency().map(entry => entry.userId)).toEqual(['admin'])
    expect(s.revokeEmergency('admin')).toBe(true)
    expect(s.emergencySecret('admin')).toBeUndefined()
  })

  it('audit_rows_are_kept_for_one_year', () => {
    const s = store(), day = 86_400_000
    expect(AUDIT_RETENTION_MS).toBe(365 * day)
    s.audit({ event: 'emergency-sign-in', outcome: 'denied', ip: '192.0.2.1', detail: 'totp' }, 0)
    s.audit({ event: 'sso-sign-in', outcome: 'ok', userId: 'u1' }, 10 * day)
    expect(s.listAudit(0)).toHaveLength(2)
    s.audit({ event: 'sso-sign-in', outcome: 'ok', userId: 'u1' }, AUDIT_RETENTION_MS + 1)
    expect(s.listAudit(0).map(row => row.at)).toEqual([10 * day, AUDIT_RETENTION_MS + 1])
    s.pruneAudit(AUDIT_RETENTION_MS + 10 * day + 1)
    expect(s.listAudit(0)).toHaveLength(1)
  })
})

describe('address allow-list', () => {
  it('matches_ipv4_ipv6_and_mapped_addresses', () => {
    const list = ['10.20.0.0/16', '192.0.2.7', '2001:db8::/32']
    expect(ipAllowed('10.20.3.4', list)).toBe(true)
    expect(ipAllowed('10.21.0.1', list)).toBe(false)
    expect(ipAllowed('192.0.2.7', list)).toBe(true)
    expect(ipAllowed('192.0.2.8', list)).toBe(false)
    expect(ipAllowed('::ffff:10.20.9.9', list)).toBe(true)
    expect(ipAllowed('2001:db8:1::5', list)).toBe(true)
    expect(ipAllowed('2001:db9::5', list)).toBe(false)
    expect(ipAllowed('unknown', list)).toBe(false)
    expect(ipAllowed('10.20.0.1', [])).toBe(false)
    expect(['0.0.0.0/0', '::/0', 'fe80::1'].every(validIpEntry)).toBe(true)
    expect(['10.0.0.0/33', '10.0.0.0/1/2', 'host', '::/129', '10.0.0.0/'].some(validIpEntry)).toBe(false)
  })
})
