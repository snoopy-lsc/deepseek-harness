/** Persisted groups: the store, refresh at SSO sign-in and directory reconciliation, and the `/api/admin/groups*` routes. */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase, type IdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { reconcileOnce } from '../src/sso/deprovision.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup, type Reply } from './helpers.ts'
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, startMockIdp, type MockIdp } from './mock-oidc.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0).reverse()) await item.close() })
const PASSWORD = 'correct horse battery'
const json = (reply: { body: string }) => JSON.parse(reply.body)

async function database(): Promise<IdentityDatabase> {
  const { config } = await setup()
  const db = await openIdentityDatabase(config.databaseFile)
  open.push({ close: async () => db.close() })
  db.db.exec('CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, userId TEXT)')
  return db
}

describe('group store', () => {
  it('sync_replaces_only_the_rows_of_one_source_and_keeps_local_memberships', async () => {
    const db = await database(), groups = db.groups
    const seen: string[][] = []
    groups.subscribe(ids => seen.push([...ids]))
    expect(groups.syncUser('u1', 'wecom', ['dept:1', 'dept:2'], 'login', 10)).toBe(true)
    const local = groups.createLocal('Pilot readers', 11)
    expect(groups.addLocalMember(local.id, 'u1', 12)).toBe(true)
    expect(groups.syncUser('u1', 'wecom', ['dept:2', 'dept:3'], 'reconcile', 13)).toBe(true)
    expect(groups.groupsOf('u1')).toEqual([local.id, 'wecom:dept:2', 'wecom:dept:3'].sort())
    // Unchanged input is not a change and notifies nobody.
    expect(groups.syncUser('u1', 'wecom', ['dept:3', 'dept:2'], 'reconcile', 14)).toBe(false)
    expect(seen).toEqual([['u1'], ['u1'], ['u1']])
    // Empty, control-character and oversized values never become groups.
    groups.syncUser('u2', 'oidc', ['', 'a\nb', 'x'.repeat(600), 'eng'], 'login', 15)
    expect(groups.groupsOf('u2')).toEqual(['oidc:eng'])
    // Synced groups cannot be renamed through the local operations or deleted.
    expect(groups.deleteLocal('wecom:dept:2')).toBe(false)
    expect(groups.addLocalMember('wecom:dept:2', 'u2', 16)).toBe(false)
  })

  it('effective_groups_include_ancestor_departments_and_members_can_include_descendants', async () => {
    const db = await database(), groups = db.groups
    groups.syncUser('u1', 'ldap', ['cn=backend,ou=eng'], 'login', 1)
    groups.syncUser('u2', 'ldap', ['cn=eng'], 'login', 1)
    db.db.prepare("UPDATE dsh_group SET parent_id = 'ldap:cn=eng' WHERE id = 'ldap:cn=backend,ou=eng'").run()
    expect(groups.effectiveGroupsOf('u1')).toEqual(['ldap:cn=backend,ou=eng', 'ldap:cn=eng'])
    expect(groups.membersOf('ldap:cn=eng')).toEqual(['u2'])
    expect(groups.membersOf('ldap:cn=eng', true)).toEqual(['u1', 'u2'])
    // A corrupted cycle terminates.
    db.db.prepare("UPDATE dsh_group SET parent_id = 'ldap:cn=backend,ou=eng' WHERE id = 'ldap:cn=eng'").run()
    expect(groups.effectiveGroupsOf('u2')).toEqual(['ldap:cn=backend,ou=eng', 'ldap:cn=eng'])
  })

  it('reconciliation_refreshes_groups_of_active_directory_records_only', async () => {
    const db = await database()
    for (const id of ['u1', 'u2']) { db.db.prepare('INSERT INTO user (id, email) VALUES (?, ?)').run(id, `${id}@corp.example`); db.sso.setOrigin(id, 'sso') }
    db.sso.bindSubject('wecom', 'w1', 'u1', 1); db.sso.bindSubject('wecom', 'w2', 'u2', 1)
    db.groups.syncUser('u2', 'wecom', ['7'], 'login', 1)
    await reconcileOnce({ database: db, kind: 'wecom', allowedGroups: ['1', '7'], policy: { intervalMs: 1, maxInactiveDays: 0, maxDisablePerRun: 10 }, now: 5,
      directory: { lookup: async subject => subject === 'w1' ? { status: 'active', groups: ['1', '2'] } : { status: 'disabled' } } })
    expect(db.groups.groupsOf('u1')).toEqual(['wecom:1', 'wecom:2'])
    // A disabled record does not rewrite groups (the account is disabled instead).
    expect(db.groups.groupsOf('u2')).toEqual(['wecom:7'])
  })
})

describe('sign-in refresh', () => {
  const IP = { 'x-forwarded-for': '203.0.113.7' }
  const cookiesOf = (reply: Reply) => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]!)
  async function login(socket: string, idp: MockIdp) {
    const begin = await call(socket, 'GET', '/api/auth/sso/start', undefined, IP)
    const browser = cookiesOf(begin).find(cookie => cookie.startsWith('dsh-sso='))!
    const back = await idp.authorize(String(begin.headers.location))
    return call(socket, 'GET', back.pathname + back.search, undefined, { ...IP, cookie: browser })
  }
  it('oidc_groups_are_stored_at_each_sign_in', async () => {
    const idp = await startMockIdp(); open.push(idp)
    const { config } = await setup({}, { DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: idp.issuer, DSH_OIDC_CLIENT_ID: MOCK_CLIENT_ID,
      DSH_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET, DSH_SSO_ALLOWED_GROUPS: 'engineering,/corp/research', DSH_OIDC_TIMEOUT_MS: '2000' })
    const service = await startIdentity(config, { mail: mailbox().mail }); open.push(service)
    idp.user = { sub: 'emp-9', email: 'dana@corp.example', groups: ['engineering', '/corp/research'] }
    expect(sessionCookie(await login(config.publicSocket, idp))).toBeDefined()
    const read = () => {
      const db = new DatabaseSync(config.databaseFile, { readOnly: true })
      try { return (db.prepare('SELECT group_id, via FROM dsh_user_group ORDER BY group_id').all() as Array<{ group_id: string; via: string }>).map(row => `${row.group_id}/${row.via}`) } finally { db.close() }
    }
    expect(read()).toEqual(['oidc:/corp/research/login', 'oidc:engineering/login'])
    idp.user = { ...idp.user, groups: ['engineering'] }
    await login(config.publicSocket, idp)
    expect(read()).toEqual(['oidc:engineering/login'])
  })
})

describe('/api/admin/groups', () => {
  async function site() {
    const { dir } = await setup()
    const { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test' })
    const box = mailbox()
    const service = await startIdentity(config, { mail: box.mail }); open.push(service)
    let n = 0
    const enroll = async (email: string) => {
      const ip = { 'x-forwarded-for': `198.51.100.${++n}` }
      await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: email.split('@')[0], email, password: PASSWORD, callbackURL: '/account/verified' }, { ...ip, 'x-captcha-response': 'pass-captcha' })
      const verify = linkIn(box.sent.at(-1)!); await call(config.publicSocket, 'GET', verify.pathname + verify.search)
      const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password: PASSWORD }, ip)
      return { cookie: sessionCookie(reply)!, id: (JSON.parse(reply.body) as { user: { id: string } }).user.id }
    }
    const get = (path: string, cookie: string) => call(config.publicSocket, 'GET', `/api/admin${path}`, undefined, { cookie })
    const post = (path: string, body: unknown, cookie: string) => call(config.publicSocket, 'POST', `/api/admin${path}`, body, { cookie, 'x-forwarded-for': '203.0.113.50' })
    const audit = () => {
      const db = new DatabaseSync(config.databaseFile, { readOnly: true })
      try { return db.prepare("SELECT event, detail FROM dsh_audit WHERE event = 'admin-group-change' ORDER BY id").all() as Array<{ event: string; detail: string }> } finally { db.close() }
    }
    const root = await enroll('root@example.test'), member = await enroll('member@example.test')
    return { config, get, post, audit, root, member }
  }

  it('local_groups_are_created_renamed_populated_with_reauth_and_deleted_with_audit', async () => {
    const s = await site()
    expect((await s.get('/groups', s.member.cookie)).status).toBe(403)
    const created = json(await s.post('/groups', { op: 'create', name: '  Pilot readers ' }, s.root.cookie)).group
    expect(created).toMatchObject({ source: 'local', displayName: 'Pilot readers', members: 0 })
    expect((await s.post('/groups', { op: 'create', name: 'bad\u0007name' }, s.root.cookie)).status).toBe(400)
    expect(json(await s.post('/groups', { op: 'rename', id: created.id, name: 'Pilot' }, s.root.cookie)).group.displayName).toBe('Pilot')
    // Adding a member needs the password again.
    const noPass = await s.post('/groups/members', { op: 'add', groupId: created.id, userId: s.member.id }, s.root.cookie)
    expect(noPass.status).toBe(401)
    expect(json(noPass)).toMatchObject({ code: 'reauth-required', method: 'password' })
    expect(json(await s.post('/groups/members', { op: 'add', groupId: created.id, userId: s.member.id, password: PASSWORD }, s.root.cookie)).changed).toBe(true)
    const listed = json(await s.get('/groups', s.root.cookie)).groups
    expect(listed).toEqual([expect.objectContaining({ id: created.id, members: 1 })])
    expect(json(await s.get(`/groups/members?group=${encodeURIComponent(created.id)}`, s.root.cookie)).members).toEqual([{ userId: s.member.id, email: 'member@example.test', name: 'member' }])
    const users = json(await s.get('/users', s.root.cookie)).users as Array<{ id: string; groups: string[] }>
    expect(users.find(user => user.id === s.member.id)!.groups).toEqual([created.id])
    expect((await s.post('/groups', { op: 'delete', id: created.id, password: PASSWORD }, s.root.cookie)).status).toBe(200)
    expect(json(await s.get('/groups', s.root.cookie)).groups).toEqual([])
    expect(s.audit().map(row => row.detail.replace(/local:[0-9a-f-]+/, 'local:ID'))).toEqual([
      'by=root@example.test op=create group=local:ID', 'by=root@example.test op=rename group=local:ID',
      'by=root@example.test op=member-add group=local:ID', 'by=root@example.test op=delete group=local:ID members=1'])
  })

  it('synced_groups_take_an_alias_but_no_local_membership', async () => {
    const s = await site()
    const db = await openIdentityDatabase(s.config.databaseFile)
    try { db.groups.syncUser(s.member.id, 'wecom', ['42'], 'login', Date.now()) } finally { db.close() }
    expect(json(await s.post('/groups', { op: 'alias', id: 'wecom:42', name: '研发部' }, s.root.cookie)).group).toMatchObject({ displayName: '研发部', externalId: '42' })
    expect((await s.post('/groups', { op: 'rename', id: 'wecom:42', name: 'x' }, s.root.cookie)).status).toBe(409)
    expect((await s.post('/groups', { op: 'delete', id: 'wecom:42', password: PASSWORD }, s.root.cookie)).status).toBe(409)
    expect((await s.post('/groups/members', { op: 'add', groupId: 'wecom:42', userId: s.root.id, password: PASSWORD }, s.root.cookie)).status).toBe(409)
    expect((await s.post('/groups', { op: 'alias', id: 'wecom:42', name: null }, s.root.cookie)).status).toBe(200)
    expect((await s.post('/groups', { op: 'alias', id: 'nope:1', name: 'x' }, s.root.cookie)).status).toBe(404)
  })
})
