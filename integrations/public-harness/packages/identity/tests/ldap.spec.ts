import { afterEach, describe, expect, it } from 'vitest'
import type { SsoConfig } from '../src/sso/config.ts'
import { createLdapProvider, escapeDnValue, escapeFilterValue, formatObjectGuid, ldapPlaceholderEmail } from '../src/sso/ldap.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { IdentityUnavailableError } from '../src/transports.ts'
import { MOCK_LDAP_BASE, MOCK_LDAP_BIND_DN, MOCK_LDAP_BIND_PASSWORD, MOCK_USER_PASSWORD, makeTestPki, startMockLdap, type MockLdap } from './mock-ldap.ts'

type LdapConfig = Extract<SsoConfig, { kind: 'ldap' }>
const mocks: MockLdap[] = []
afterEach(async () => { for (const mock of mocks.splice(0)) await mock.close() })
const start = async (mode: 'ldaps' | 'starttls' | 'plain' = 'ldaps') => { const mock = await startMockLdap(mode); mocks.push(mock); return mock }
const ENGINEERING = `cn=engineering,ou=groups,${MOCK_LDAP_BASE}`
const config = (mock: MockLdap, extra: Partial<LdapConfig> = {}): LdapConfig => ({ kind: 'ldap', url: mock.url, startTls: false, ca: mock.pki.ca, bindDn: MOCK_LDAP_BIND_DN,
  bindPassword: MOCK_LDAP_BIND_PASSWORD, baseDn: MOCK_LDAP_BASE, userFilter: '(objectClass=user)', usernameAttribute: 'sAMAccountName', idAttribute: 'objectGUID',
  emailAttribute: 'mail', nameAttribute: 'displayName', groupMode: 'memberOf', groupBaseDn: MOCK_LDAP_BASE, groupObjectClass: 'groupOfNames', activeDirectory: true,
  serverId: 'dc1.corp.example:636', allowedGroups: [ENGINEERING], timeoutMs: 1000, ...extra })
const login = (mock: MockLdap, username: string, password = MOCK_USER_PASSWORD, extra: Partial<LdapConfig> = {}) => createLdapProvider(config(mock, extra)).authenticate({ username, password })
async function rejected(promise: Promise<unknown>) {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}

describe('LDAP escaping', () => {
  it('filter_values_follow_rfc_4515', () => {
    expect(escapeFilterValue('a*b(c)d\\e\0f')).toBe('a\\2ab\\28c\\29d\\5ce\\00f')
    expect(escapeFilterValue('张三')).toBe('张三')
    expect(escapeFilterValue('x\u0001\u007f')).toBe('x\\01\\7f')
  })
  it('dn_values_follow_rfc_4514', () => {
    expect(escapeDnValue(' Smith, John+Jr "x" <y>;=#\\ ')).toBe('\\ Smith\\, John\\+Jr \\"x\\" \\<y\\>\\;=#\\\\\\ ')
    expect(escapeDnValue('#lead')).toBe('\\#lead')
  })
  it('object_guid_uses_the_windows_string_form', () => {
    expect(formatObjectGuid(Buffer.from('33221100554477668899aabbccddeeff', 'hex'))).toBe('00112233-4455-6677-8899-aabbccddeeff')
  })
})

describe('LDAP provider', () => {
  it('search_then_bind_maps_the_immutable_id_scoped_by_server', async () => {
    const mock = await start()
    expect(await login(mock, 'alice')).toEqual({ subject: 'dc1.corp.example:636|00112233-4455-6677-8899-aabbccddeeff', email: 'alice@corp.example', name: 'Alice Zhang', groups: [ENGINEERING] })
    expect(mock.binds).toEqual([MOCK_LDAP_BIND_DN, `cn=Alice Zhang,ou=people,${MOCK_LDAP_BASE}`])
    const rfc = await login(mock, 'alice', MOCK_USER_PASSWORD, { idAttribute: 'entryUUID', usernameAttribute: 'uid', userFilter: '(objectClass=inetOrgPerson)', activeDirectory: false })
    expect(rfc.subject).toBe('dc1.corp.example:636|6f1b2c3d-0000-4000-8000-00000000a11c')
    const bob = await login(mock, 'bob', MOCK_USER_PASSWORD, { allowedGroups: [`cn=platform,ou=groups,${MOCK_LDAP_BASE}`] })
    expect(bob.email).toBe(ldapPlaceholderEmail(bob.subject))
  })

  it('starttls_and_ca_pinning', async () => {
    const tls = await start('starttls')
    expect((await login(tls, 'alice', MOCK_USER_PASSWORD, { startTls: true })).name).toBe('Alice Zhang')
    const other = makeTestPki()
    try {
      // A certificate from any other CA, including the system store, is refused before credentials are sent.
      const ldaps = await start()
      await expect(login(ldaps, 'alice', MOCK_USER_PASSWORD, { ca: other.ca })).rejects.toBeInstanceOf(IdentityUnavailableError)
      expect(ldaps.binds).toEqual([])
    } finally { other.cleanup() }
  })

  it('wrong_unknown_empty_and_injected_credentials_look_the_same', async () => {
    const mock = await start()
    expect(await rejected(login(mock, 'alice', 'wrong-password'))).toBe('credentials')
    expect(await rejected(login(mock, 'nobody'))).toBe('credentials')
    // Empty password would be an unauthenticated bind that servers accept; it never reaches the directory.
    const before = mock.binds.length
    expect(await rejected(login(mock, 'alice', ''))).toBe('credentials')
    expect(mock.binds.length).toBe(before)
    expect(await rejected(login(mock, '*'))).toBe('credentials')
    expect(await rejected(login(mock, 'alice)(|(sAMAccountName=*'))).toBe('credentials')
    expect(mock.assertions.filter(([kind]) => kind === '*substrings*')).toEqual([])
    expect(mock.assertions).toContainEqual(['sAMAccountName', '*'])
  })

  it('disabled_ad_accounts_and_groups', async () => {
    const mock = await start()
    expect(await rejected(login(mock, 'carol'))).toBe('inactive')
    // Direct memberOf only: Bob is in Platform, which is nested in Engineering.
    expect((await login(mock, 'bob')).groups).toEqual([`cn=platform,ou=groups,${MOCK_LDAP_BASE}`])
    expect((await login(mock, 'bob', MOCK_USER_PASSWORD, { groupMode: 'nested' })).groups).toEqual([ENGINEERING, `cn=platform,ou=groups,${MOCK_LDAP_BASE}`])
    expect((await login(mock, 'bob', MOCK_USER_PASSWORD, { groupMode: 'search' })).groups).toEqual([`cn=platform,ou=groups,${MOCK_LDAP_BASE}`])
    expect(mock.assertions).toContainEqual([`member:1.2.840.113556.1.4.1941`, `cn=Bob Li,ou=people,${MOCK_LDAP_BASE}`])
  })

  it('outages_timeouts_and_a_bad_service_password_fail_closed', async () => {
    const mock = await start()
    await expect(login(mock, 'alice', MOCK_USER_PASSWORD, { bindPassword: 'not-the-service-password' })).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.delayMs = 1500
    await expect(login(mock, 'alice')).rejects.toBeInstanceOf(IdentityUnavailableError)
    await mock.close(); mocks.splice(mocks.indexOf(mock), 1)
    await expect(login(mock, 'alice')).rejects.toBeInstanceOf(IdentityUnavailableError)
  })
})
