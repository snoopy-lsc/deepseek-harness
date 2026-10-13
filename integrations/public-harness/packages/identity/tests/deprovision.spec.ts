/** Automatic deprovisioning: store, reconciliation policy and fail-safety, the LDAP/WeCom/DingTalk directory lookups against 127.0.0.1 mocks,
 * session revocation through the listeners, the operator CLI and the environment settings. */
import { chmodSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase, type IdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { runSsoCli } from '../src/sso-cli.ts'
import { normalizeDn, parseSsoEnv, type SsoConfig } from '../src/sso/config.ts'
import { createDingtalkProvider } from '../src/sso/dingtalk.ts'
import { reconcileOnce } from '../src/sso/deprovision.ts'
import { createLdapProvider } from '../src/sso/ldap.ts'
import type { DirectoryLookup, DirectoryRecord } from '../src/sso/provider.ts'
import { createWecomProvider } from '../src/sso/wecom.ts'
import { IdentityUnavailableError } from '../src/transports.ts'
import { call, mailbox, sessionCookie, setup } from './helpers.ts'
import { MOCK_DT_CLIENT_ID, MOCK_DT_CORP_ID, MOCK_DT_SECRET, startMockDingtalk } from './mock-dingtalk.ts'
import { MOCK_LDAP_BASE, MOCK_LDAP_BIND_DN, MOCK_LDAP_BIND_PASSWORD, startMockLdap, type MockLdap } from './mock-ldap.ts'
import { MOCK_AGENT_ID, MOCK_CORP_ID, MOCK_WECOM_SECRET, startMockWecom } from './mock-wecom.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const DAY = 86_400_000
const POLICY = { intervalMs: 3_600_000, maxInactiveDays: 0, maxDisablePerRun: 10 }

/** A database with Better Auth's tables replaced by the two columns the store touches, and `n` bound SSO users. */
async function seeded(n: number, provider = 'ldap'): Promise<IdentityDatabase> {
  const { config } = await setup()
  const db = await openIdentityDatabase(config.databaseFile)
  open.push({ close: async () => db.close() })
  db.db.exec('CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, userId TEXT)')
  for (let i = 0; i < n; i++) {
    db.db.prepare('INSERT INTO user (id, email) VALUES (?, ?)').run(`u${i}`, `user${i}@corp.example`)
    db.db.prepare('INSERT INTO session (id, userId) VALUES (?, ?)').run(`s${i}`, `u${i}`)
    db.sso.setOrigin(`u${i}`, 'sso'); db.sso.bindSubject(provider, `dir|${i}`, `u${i}`, 1_000)
  }
  return db
}
const fake = (answers: Record<string, DirectoryRecord | 'error' | undefined>): DirectoryLookup => ({
  async lookup(subject) { const answer = answers[subject]; if (answer === 'error') throw new IdentityUnavailableError('sso'); return answer },
})
const sessions = (db: IdentityDatabase, userId: string) => (db.db.prepare('SELECT count(*) AS n FROM session WHERE userId = ?').get(userId) as { n: number }).n

describe('deprovisioning store and policy', () => {
  it('directory_answers_disable_revoke_sessions_and_audit_while_errors_skip', async () => {
    const db = await seeded(6)
    const report = await reconcileOnce({ database: db, kind: 'ldap', allowedGroups: ['eng'], policy: POLICY, now: 10 * DAY, directory: fake({
      'dir|0': { status: 'active', groups: ['eng'] }, 'dir|1': { status: 'missing' }, 'dir|2': { status: 'disabled' }, 'dir|3': { status: 'active', groups: ['sales'] },
      'dir|4': 'error', 'dir|5': undefined }) })
    expect(report).toEqual({ checked: 6, skipped: 1, aborted: false,
      disabled: [{ userId: 'u1', reason: 'directory-missing' }, { userId: 'u2', reason: 'directory-disabled' }, { userId: 'u3', reason: 'directory-group' }] })
    expect([0, 1, 2, 3, 4, 5].map(i => sessions(db, `u${i}`))).toEqual([1, 0, 0, 0, 1, 1])
    expect(db.sso.listDisabled().map(row => row.userId)).toEqual(['u1', 'u2', 'u3'])
    const audit = db.sso.listAudit(0)
    expect(audit.filter(row => row.event === 'sso-disable').map(row => [row.userId, row.email, row.detail])).toEqual([
      ['u1', 'user1@corp.example', 'directory-missing'], ['u2', 'user2@corp.example', 'directory-disabled'], ['u3', 'user3@corp.example', 'directory-group']])
    expect(audit.at(-1)).toMatchObject({ event: 'sso-reconcile', outcome: 'error', detail: 'checked=6 disabled=3 skipped=1' })
    // A second run does not look at disabled accounts again, and re-enabling needs an operator.
    expect((await reconcileOnce({ database: db, kind: 'ldap', allowedGroups: ['eng'], policy: POLICY, now: 11 * DAY, directory: fake({ 'dir|0': { status: 'active', groups: ['eng'] } }) })).checked).toBe(3)
    expect(db.sso.enableUser('u1', 12 * DAY)).toBe(true)
    expect(db.sso.enableUser('u1', 12 * DAY)).toBe(false)
  })

  it('an_unreachable_directory_or_an_implausible_mass_result_disables_nobody', async () => {
    const db = await seeded(12)
    const down: DirectoryLookup = { lookup: async () => { throw new IdentityUnavailableError('sso') } }
    expect(await reconcileOnce({ database: db, kind: 'ldap', allowedGroups: ['eng'], policy: POLICY, now: DAY, directory: down })).toEqual({ checked: 12, disabled: [], skipped: 12, aborted: false })
    // Every user "missing" (a wrong base DN looks exactly like this): more than maxDisablePerRun, so the run aborts.
    const gone: DirectoryLookup = { lookup: async () => ({ status: 'missing' }) }
    const report = await reconcileOnce({ database: db, kind: 'ldap', allowedGroups: ['eng'], policy: POLICY, now: DAY, directory: gone })
    expect(report).toMatchObject({ disabled: [], aborted: true })
    expect(db.sso.listDisabled()).toEqual([])
    expect(db.sso.listAudit(0).at(-1)).toMatchObject({ event: 'sso-reconcile', outcome: 'error', detail: 'checked=12 disabled=0 skipped=0 aborted=12>10' })
    expect((await reconcileOnce({ database: db, kind: 'ldap', allowedGroups: ['eng'], policy: { ...POLICY, maxDisablePerRun: 12 }, now: DAY, directory: gone })).disabled).toHaveLength(12)
  })

  it('inactivity_policy_uses_the_last_sign_in_and_applies_without_a_directory', async () => {
    const db = await seeded(3, 'oidc')
    db.sso.touchLogin('oidc', 'dir|1', 50 * DAY)
    const policy = { ...POLICY, maxInactiveDays: 90 }
    expect((await reconcileOnce({ database: db, kind: 'oidc', allowedGroups: [], policy, now: 90 * DAY })).disabled).toEqual([])
    const report = await reconcileOnce({ database: db, kind: 'oidc', allowedGroups: [], policy, now: 91 * DAY })
    // u0 and u2 never signed in after binding at t=1000; u1 did at day 50.
    expect(report.disabled).toEqual([{ userId: 'u0', reason: 'inactive' }, { userId: 'u2', reason: 'inactive' }])
    expect((await reconcileOnce({ database: db, kind: 'oidc', allowedGroups: [], policy, now: 141 * DAY })).disabled).toEqual([{ userId: 'u1', reason: 'inactive' }])
    // Policy off: nothing happens however old the sign-in.
    const fresh = await seeded(1, 'saml')
    expect((await reconcileOnce({ database: fresh, kind: 'saml', allowedGroups: [], policy: POLICY, now: 10_000 * DAY })).disabled).toEqual([])
  })

  it('older_databases_gain_the_last_login_column_in_place', async () => {
    const { config } = await setup()
    const raw = new DatabaseSync(config.databaseFile)
    raw.exec('CREATE TABLE dsh_sso_link (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (provider, user_id))')
    raw.prepare('INSERT INTO dsh_sso_link VALUES (?, ?, ?, ?)').run('ldap', 'dir|old', 'u-old', 5)
    raw.close()
    chmodSync(config.databaseFile, 0o600)
    const db = await openIdentityDatabase(config.databaseFile)
    try { expect(db.sso.listLinks('ldap')).toEqual([{ provider: 'ldap', subject: 'dir|old', userId: 'u-old', createdAt: 5, lastLoginAt: undefined }]) } finally { db.close() }
  })
})

type LdapConfig = Extract<SsoConfig, { kind: 'ldap' }>
const ldapConfig = (mock: MockLdap, extra: Partial<LdapConfig> = {}): LdapConfig => ({ kind: 'ldap', url: mock.url, startTls: false, ca: mock.pki.ca, bindDn: MOCK_LDAP_BIND_DN,
  bindPassword: MOCK_LDAP_BIND_PASSWORD, baseDn: MOCK_LDAP_BASE, userFilter: '(objectClass=user)', usernameAttribute: 'sAMAccountName', idAttribute: 'objectGUID', emailAttribute: 'mail',
  nameAttribute: 'displayName', groupMode: 'memberOf', groupBaseDn: MOCK_LDAP_BASE, groupObjectClass: 'group', activeDirectory: true, serverId: new URL(mock.url).host,
  allowedGroups: [normalizeDn(`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`)], timeoutMs: 1000, ...extra })

describe('directory lookups', () => {
  it('ldap_finds_users_by_object_guid_or_entry_uuid_and_reports_disabled_missing_and_groups', async () => {
    const mock = await startMockLdap(); open.push(mock)
    const host = new URL(mock.url).host
    const ad = createLdapProvider(ldapConfig(mock)).directory!
    const alice = `${host}|00112233-4455-6677-8899-aabbccddeeff`
    expect(await ad.lookup(alice)).toEqual({ status: 'active', groups: [normalizeDn(`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`)] })
    // The GUID went out as escaped bytes, never as text.
    expect(mock.assertions.find(([attr]) => attr === 'objectGUID')).toBeDefined()
    expect(await ad.lookup(`${host}|00112233-4455-6677-8899-aabbccddeeee`)).toEqual({ status: 'missing' })
    expect(await ad.lookup(`${host}|ccddeeff-aabb-8899-7766-554433221100`)).toEqual({ status: 'disabled' })
    expect(await ad.lookup('other.example:636|00112233-4455-6677-8899-aabbccddeeff')).toBeUndefined()
    const nested = createLdapProvider(ldapConfig(mock, { groupMode: 'nested' })).directory!
    expect((await nested.lookup(`${host}|33221100-5544-7766-8899-aabbccddeeff`) as { groups: readonly string[] }).groups).toContain(normalizeDn(`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`))
    const openldap = createLdapProvider(ldapConfig(mock, { idAttribute: 'entryUUID', activeDirectory: false })).directory!
    expect(await openldap.lookup(`${host}|6f1b2c3d-0000-4000-8000-00000000a11c`)).toMatchObject({ status: 'active' })
    expect(await openldap.lookup(`${host}|x*)(objectclass=*`)).toEqual({ status: 'missing' })
    // A wrong service password or a dead server is an error, never "missing".
    await expect(createLdapProvider(ldapConfig(mock, { bindPassword: 'wrong' })).directory!.lookup(alice)).rejects.toBeInstanceOf(IdentityUnavailableError)
    await mock.close(); open.pop()
    await expect(ad.lookup(alice)).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('wecom_reports_status_departments_and_deleted_members_and_errors_stay_errors', async () => {
    const mock = await startMockWecom(); open.push(mock)
    const config = { kind: 'wecom' as const, corpId: MOCK_CORP_ID, agentId: MOCK_AGENT_ID, secret: MOCK_WECOM_SECRET, apiBase: mock.base, loginUrl: mock.loginUrl,
      allowedGroups: ['2'], recursiveDepartments: true, timeoutMs: 1000 }
    const directory = createWecomProvider(config).directory!
    const subject = `${MOCK_CORP_ID}:zhangsan`
    expect(await directory.lookup(subject)).toEqual({ status: 'active', groups: ['3', '2'] })
    mock.members.get('ZhangSan')!.status = 5
    expect(await directory.lookup(subject)).toEqual({ status: 'disabled' })
    mock.members.get('ZhangSan')!.status = 1; mock.members.get('ZhangSan')!.department = [4]
    expect(await directory.lookup(subject)).toEqual({ status: 'active', groups: ['4'] })
    mock.failOnce.set('/cgi-bin/user/get', 60011)
    await expect(directory.lookup(subject)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.members.delete('ZhangSan')
    expect(await directory.lookup(subject)).toEqual({ status: 'missing' })
    expect(await directory.lookup('othercorp:zhangsan')).toBeUndefined()
    mock.httpStatus = 502
    await expect(directory.lookup(subject)).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('dingtalk_reports_active_flag_departments_and_departed_members', async () => {
    const mock = await startMockDingtalk(); open.push(mock)
    const config = { kind: 'dingtalk' as const, clientId: MOCK_DT_CLIENT_ID, clientSecret: MOCK_DT_SECRET, corpId: MOCK_DT_CORP_ID, apiBase: mock.base, oapiBase: mock.base,
      loginUrl: mock.loginUrl, exclusiveLogin: false, allowedGroups: ['2'], recursiveDepartments: true, timeoutMs: 1000 }
    const directory = createDingtalkProvider(config).directory!
    const subject = `${MOCK_DT_CORP_ID}:UnionZhang01`
    expect(await directory.lookup(subject)).toEqual({ status: 'active', groups: ['3', '2'] })
    mock.members.get('UnionZhang01')!.active = false
    expect(await directory.lookup(subject)).toEqual({ status: 'disabled' })
    mock.failOnce.set('/topapi/v2/user/get', 50001)
    await expect(directory.lookup(subject)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.members.delete('UnionZhang01')
    expect(await directory.lookup(subject)).toEqual({ status: 'missing' })
    expect(await directory.lookup('othercorp:UnionZhang01')).toBeUndefined()
  })
})

describe('deprovisioning through the service', () => {
  it('a_directory_disable_revokes_the_live_session_and_blocks_sign_in_until_the_cli_enables_it', async () => {
    const mock = await startMockLdap(); open.push(mock)
    const { dir, config } = await setup({}, { DSH_SSO_PROVIDER: 'ldap', DSH_LDAP_URL: mock.url, DSH_LDAP_CA_FILE: mock.pki.caFile, DSH_LDAP_BIND_DN: MOCK_LDAP_BIND_DN,
      DSH_LDAP_BIND_PASSWORD: MOCK_LDAP_BIND_PASSWORD, DSH_LDAP_BASE_DN: MOCK_LDAP_BASE, DSH_LDAP_USER_FILTER: '(objectClass=user)', DSH_LDAP_TIMEOUT_MS: '1000',
      DSH_SSO_ALLOWED_GROUPS: `cn=Engineering,ou=groups,${MOCK_LDAP_BASE}` })
    open.push(await startIdentity(config, { mail: mailbox().mail }))
    const IP = { 'x-forwarded-for': '203.0.113.7' }
    const signIn = () => call(config.publicSocket, 'POST', '/api/auth/sso/ldap/sign-in', { username: 'alice', password: 'mock-user-test-only-pw' }, IP)
    const first = await signIn()
    expect(first.status).toBe(200)
    const cookie = sessionCookie(first)!
    expect((await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).status).toBe(200)
    // The directory removes Alice from Engineering; the next run disables her and her live session stops working at once.
    const entry = [...mock.entries].find(([dn]) => dn.startsWith('cn=Alice'))![1]
    entry.memberOf = []
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      const report = await reconcileOnce({ database: db, kind: 'ldap', directory: createLdapProvider(config.sso as LdapConfig).directory!, allowedGroups: (config.sso as LdapConfig).allowedGroups,
        policy: config.deprovision, now: Date.now() })
      expect(report.disabled.map(item => item.reason)).toEqual(['directory-group'])
    } finally { db.close() }
    expect((await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).status).toBe(401)
    // Back in the group, still refused: re-enabling is an operator decision.
    entry.memberOf = [`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`]
    const blocked = await signIn()
    expect(blocked.status).toBe(403)
    expect(JSON.parse(blocked.body).code).toBe('disabled')
    const file = join(dir, 'identity.json'), lines: string[] = []
    await writeFile(file, JSON.stringify({ databaseFile: config.databaseFile }))
    expect(await runSsoCli(['--config', file, 'list-disabled'], line => lines.push(line))).toBe(0)
    expect(lines[0]).toMatch(/^alice@corp\.example\t\S+\tdirectory-group$/)
    expect(await runSsoCli(['--config', file, 'enable', '--email', 'alice@corp.example'], line => lines.push(line))).toBe(0)
    const again = await signIn()
    expect(again.status).toBe(200)
    // The CLI disable revokes the new session too and is audited with its reason.
    expect(await runSsoCli(['--config', file, 'disable', '--email', 'Alice@Corp.Example', '--reason', 'offboarded'], line => lines.push(line))).toBe(0)
    expect(lines.at(-1)).toBe('disabled; every session was revoked')
    expect((await call(config.sessionSocket, 'POST', '/internal/session', { cookie: sessionCookie(again)! })).status).toBe(401)
    expect(await runSsoCli(['--config', file, 'disable', '--email', 'nobody@corp.example'], line => lines.push(line))).toBe(1)
    const check = await openIdentityDatabase(config.databaseFile)
    try {
      expect(check.sso.listAudit(0).filter(row => row.event === 'sso-disable' || row.event === 'sso-enable').map(row => [row.event, row.detail ?? ''])).toEqual([
        ['sso-disable', 'directory-group'], ['sso-enable', ''], ['sso-disable', 'cli: offboarded']])
    } finally { check.close() }
    await expect(runSsoCli(['--config', file, 'enable', '--email', 'alice@corp.example', '--reason', 'x'], () => {})).rejects.toThrow(/usage/)
  })

  it('the_scheduler_runs_reconciliation_in_the_service', async () => {
    const mock = await startMockLdap(); open.push(mock)
    const { config } = await setup({}, { DSH_SSO_PROVIDER: 'ldap', DSH_LDAP_URL: mock.url, DSH_LDAP_CA_FILE: mock.pki.caFile, DSH_LDAP_BIND_DN: MOCK_LDAP_BIND_DN,
      DSH_LDAP_BIND_PASSWORD: MOCK_LDAP_BIND_PASSWORD, DSH_LDAP_BASE_DN: MOCK_LDAP_BASE, DSH_LDAP_USER_FILTER: '(objectClass=user)', DSH_LDAP_TIMEOUT_MS: '1000',
      DSH_SSO_ALLOWED_GROUPS: `cn=Engineering,ou=groups,${MOCK_LDAP_BASE}` })
    open.push(await startIdentity(config, { mail: mailbox().mail, reconcileIntervalMs: 100 }))
    const first = await call(config.publicSocket, 'POST', '/api/auth/sso/ldap/sign-in', { username: 'alice', password: 'mock-user-test-only-pw' }, { 'x-forwarded-for': '203.0.113.7' })
    const cookie = sessionCookie(first)!
    // While the directory is unreachable the session stays valid.
    mock.delayMs = 5000
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect((await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).status).toBe(200)
    mock.delayMs = 0
    const entry = [...mock.entries].find(([dn]) => dn.startsWith('cn=Alice'))![1]
    entry.userAccountControl = ['514']
    let status = 200
    for (let i = 0; i < 50 && status === 200; i++) { await new Promise(resolve => setTimeout(resolve, 100)); status = (await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).status }
    expect(status).toBe(401)
  }, 20_000)

  it('settings_have_safe_defaults_bounds_and_require_sso', () => {
    const base = { DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: 'https://idp.corp.example', DSH_OIDC_CLIENT_ID: 'harness', DSH_OIDC_CLIENT_SECRET: 'placeholder-value', DSH_SSO_ALLOWED_GROUPS: 'eng' }
    expect(parseSsoEnv(base, 'production').deprovision).toEqual({ intervalMs: 3_600_000, maxInactiveDays: 0, maxDisablePerRun: 10 })
    expect(parseSsoEnv({ ...base, DSH_SSO_RECONCILE_INTERVAL_MINUTES: '0', DSH_SSO_MAX_INACTIVE_DAYS: '90', DSH_SSO_RECONCILE_MAX_DISABLE: '50' }, 'production').deprovision)
      .toEqual({ intervalMs: 0, maxInactiveDays: 90, maxDisablePerRun: 50 })
    expect(parseSsoEnv({}, 'production').deprovision.intervalMs).toBe(0)
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...base, DSH_SSO_RECONCILE_INTERVAL_MINUTES: '1' }, 'DSH_SSO_RECONCILE_INTERVAL_MINUTES'],
      [{ ...base, DSH_SSO_RECONCILE_INTERVAL_MINUTES: '-5' }, 'DSH_SSO_RECONCILE_INTERVAL_MINUTES'],
      [{ ...base, DSH_SSO_MAX_INACTIVE_DAYS: '4000' }, 'DSH_SSO_MAX_INACTIVE_DAYS'],
      [{ ...base, DSH_SSO_RECONCILE_MAX_DISABLE: '0' }, 'DSH_SSO_RECONCILE_MAX_DISABLE'],
      [{ DSH_SSO_MAX_INACTIVE_DAYS: '30' }, 'DSH_SSO_MAX_INACTIVE_DAYS'],
    ]
    for (const [env, name] of cases) expect(() => parseSsoEnv(env, 'production'), name).toThrow(name)
  })
})
