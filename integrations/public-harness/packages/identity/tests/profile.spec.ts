import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'
const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { for (const service of running.splice(0)) await service.close() })
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOkAAAAASUVORK5CYII='
async function site() {
  const { dir } = await setup(), { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test' }), box = mailbox()
  let service = await startIdentity(config, { mail: box.mail }); running.push(service)
  let n = 0
  const enroll = async (email: string) => {
    const headers = { 'x-forwarded-for': `198.51.100.${++n}`, 'x-captcha-response': 'pass-captcha' }
    await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: email.split('@')[0], email, password: 'correct horse battery', callbackURL: '/account/verified' }, headers)
    const url = linkIn(box.sent.at(-1)!); await call(config.publicSocket, 'GET', url.pathname + url.search)
    const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password: 'correct horse battery' }, headers)
    return { cookie: sessionCookie(reply)!, id: JSON.parse(reply.body).user.id as string }
  }
  const root = await enroll('root@example.test'), member = await enroll('member@example.test'), other = await enroll('other@example.test')
  const request = (path: string, user = member, body?: unknown, headers: Record<string, string> = {}) => call(config.publicSocket, body === undefined ? 'GET' : 'POST', path, body, { cookie: user.cookie, ...headers })
  const sql = <T>(fn: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(config.databaseFile); try { return fn(db) } finally { db.close() } }
  const restart = async () => { await service.close(); running.splice(running.indexOf(service), 1); service = await startIdentity(config, { mail: box.mail }); running.push(service) }
  return { config, root, member, other, request, sql, restart }
}
const own = '/account/api/me/profile', avatar = '/account/api/me/avatar', admin = '/api/admin/users/profile'
const json = (reply: { body: string }) => JSON.parse(reply.body)

describe('private account profiles', () => {
  it('reads defaults and persists only own name and phone with audit metadata', async () => {
    const s = await site()
    expect(json(await s.request(own))).toMatchInlineSnapshot(`
      {
        "avatarUrl": null,
        "department": "",
        "email": "member@example.test",
        "employeeId": "",
        "jobTitle": "",
        "managedBy": "local",
        "name": "member",
        "phone": "",
      }
    `)
    expect(json(await s.request(own, s.member, { name: '  张三  ', phone: ' +86 123 ' }))).toMatchObject({ name: '张三', phone: '+86 123' })
    expect(json(await s.request('/account/api/me'))).toMatchObject({ name: '张三', role: 'member' })
    expect(json(await s.request(own, s.other))).toMatchObject({ name: 'other', phone: '' })
    await s.restart()
    expect(json(await s.request(own))).toMatchObject({ name: '张三', phone: '+86 123' })
    const rows = s.sql(db => db.prepare("SELECT event, user_id, detail FROM dsh_audit WHERE event = 'profile-update'").all())
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ user_id: s.member.id, detail: expect.stringContaining(s.member.id) })
    expect(JSON.stringify(rows)).not.toContain('+86 123'); expect(JSON.stringify(rows)).not.toContain('张三')
  })
  it('preserves compatibility for local name edits and refuses remote avatar URLs on generic auth updates', async () => {
    const s = await site()
    expect(json(await s.request('/api/auth/update-user', s.member, { name: ' New name ' }))).toEqual({ status: true })
    expect(json(await s.request(own))).toMatchObject({ name: 'New name' })
    for (const path of ['/api/auth/update-user', '/api/auth/x/../update-user', '/api/auth/%2e/update-user']) expect((await s.request(path, s.member, { image: 'https://remote.test/avatar.png' })).status).toBe(400)
  })
  it('refuses databases created by a newer profile schema', async () => {
    const s = await site()
    s.sql(db => db.exec('CREATE TABLE IF NOT EXISTS dsh_profile_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT OR REPLACE INTO dsh_profile_schema (id, version) VALUES (1, 2)'))
    await expect(s.restart()).rejects.toThrow('newer')
  })
  it('rolls back profile and avatar writes when the audit row cannot be persisted', async () => {
    const s = await site()
    s.sql(db => db.exec("CREATE TRIGGER reject_profile_audit BEFORE INSERT ON dsh_audit WHEN NEW.event IN ('profile-update', 'avatar-update') BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"))
    expect((await s.request(own, s.member, { name: 'Changed', phone: '123' })).status).toBe(503)
    expect((await s.request(avatar, s.member, { mime: 'image/png', data: PNG })).status).toBe(503)
    expect(json(await s.request(own))).toMatchObject({ name: 'member', phone: '', avatarUrl: null })
  })
  it('rejects forged role, identity, organization fields and invalid text atomically', async () => {
    const s = await site()
    for (const body of [{ role: 'admin' }, { employeeId: 'E' }, { department: 'HR' }, { jobTitle: 'CEO' }, { email: 'root@example.test' }, { userId: s.other.id }, { avatarUrl: 'https://evil.test' }, { name: '' }, { name: 'x'.repeat(101) }, { phone: 'x'.repeat(41) }, { phone: null }, { name: 'a\u0000b' }, [], { name: 'Edited', department: 'HR' }]) {
      expect((await s.request(own, s.member, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(json(await s.request(own))).toMatchObject({ name: 'member', phone: '', department: '' })
  })
  it('authenticates before reading JSON and enforces Origin and content type', async () => {
    const s = await site(), forged = { id: 'forged', cookie: 'dsh-account.session_token=forged' }
    for (const path of [own, avatar]) {
      expect((await s.request(path, forged)).status).toBe(401)
      expect((await s.request(path, forged, 'invalid json')).status).toBe(401)
      expect((await s.request(path, s.member, {}, { origin: 'https://evil.test' })).status).toBe(403)
      expect((await s.request(path, s.member, 'name=a', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415)
    }
  })
  it('allows only administrators to read or edit organization fields and audits actor and target', async () => {
    const s = await site()
    expect((await s.request(`${admin}?userId=${s.other.id}`, s.member)).status).toBe(403)
    expect((await s.request(admin, s.member, { userId: s.other.id, department: 'HR' })).status).toBe(403)
    const reply = await s.request(admin, s.root, { userId: s.member.id, name: 'Ann', phone: '123', employeeId: ' E-42 ', department: ' Research ', jobTitle: ' Engineer ' })
    expect(reply.status).toBe(200)
    expect(json(reply)).toMatchObject({ name: 'Ann', phone: '123', employeeId: 'E-42', department: 'Research', jobTitle: 'Engineer' })
    expect(json(await s.request(`${admin}?userId=${s.member.id}`, s.root))).toEqual(json(reply))
    expect(json(await s.request(own))).toEqual(json(reply))
    await s.restart()
    expect(json(await s.request(own))).toEqual(json(reply))
    expect(json(await s.request('/account/api/me'))).toMatchObject({ role: 'member' })
    expect(json(await s.request(own, s.other))).toMatchObject({ name: 'other', department: '' })
    for (const body of [{ userId: s.member.id, role: 'admin' }, { userId: s.member.id, employeeId: 'x'.repeat(65) }, { userId: s.member.id, department: 'x'.repeat(101) }, { userId: s.member.id, jobTitle: 'x\nCEO' }]) expect((await s.request(admin, s.root, body)).status).toBe(400)
    expect((await s.request(admin, s.root, { userId: 'missing', name: 'X' })).status).toBe(404)
    expect(s.sql(db => db.prepare("SELECT user_id, detail FROM dsh_audit WHERE event = 'admin-profile-update'").all())).toEqual([expect.objectContaining({ user_id: s.member.id, detail: expect.stringContaining(s.root.id) })])
  })
  it('protects SSO names through self, admin and generic auth routes', async () => {
    const s = await site()
    s.sql(db => db.prepare("INSERT INTO dsh_user_origin (user_id, origin) VALUES (?, 'sso') ON CONFLICT(user_id) DO UPDATE SET origin = 'sso'").run(s.member.id))
    expect(json(await s.request(own)).managedBy).toBe('sso')
    for (const [path, user, body] of [[own, s.member, { name: 'Local', phone: '1' }], [admin, s.root, { userId: s.member.id, name: 'Local', department: 'HR' }], ['/api/auth/update-user', s.member, { name: 'Local' }], ['/api/auth/x/../update-user', s.member, { name: 'Local' }], ['/api/auth/%2e/update-user', s.member, { name: 'Local' }]] as const) {
      const reply = await s.request(path, user, body)
      expect(reply.status).toBe(403); expect(json(reply)).toEqual({ code: 'profile-managed' })
    }
    expect([403, 404]).toContain((await s.request('/api/auth/update-user/', s.member, { name: 'Local' })).status)
    expect((await s.request(own, s.member, { phone: '456' })).status).toBe(200)
    expect((await s.request(admin, s.root, { userId: s.member.id, department: 'HR' })).status).toBe(200)
    expect(json(await s.request(own))).toMatchObject({ name: 'member', phone: '456', department: 'HR' })
  })
  it('stores private avatars durably with controlled access and audited removal', async () => {
    const s = await site(), upload = await s.request(avatar, s.member, { mime: 'image/png', data: PNG })
    expect(upload.status).toBe(200)
    const url = json(upload).avatarUrl as string
    expect(url).toContain(`userId=${s.member.id}`); expect(url).toContain('&v=')
    const image = await s.request(url)
    expect(image.status).toBe(200)
    expect(s.sql(db => Buffer.from((db.prepare('SELECT avatar_data FROM dsh_user_profile WHERE user_id = ?').get(s.member.id) as { avatar_data: Uint8Array }).avatar_data))).toEqual(Buffer.from(PNG, 'base64'))
    expect(image.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
    expect((await s.request(avatar)).body).toBe(image.body)
    const head = await call(s.config.publicSocket, 'HEAD', url, undefined, { cookie: s.member.cookie })
    expect(head.status).toBe(200); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(String(Buffer.from(PNG, 'base64').length))
    expect((await s.request(url, s.root)).status).toBe(200)
    expect((await s.request(url, s.other)).status).toBe(403)
    await s.restart()
    expect((await s.request(url)).body).toBe(image.body); expect(json(await s.request(own)).avatarUrl).toBe(url)
    expect(json(await s.request(avatar, s.member, { data: null })).avatarUrl).toBeNull()
    expect((await s.request(url)).status).toBe(404)
    expect(s.sql(db => db.prepare("SELECT event, user_id, detail FROM dsh_audit WHERE event = 'avatar-update'").all())).toEqual([
      expect.objectContaining({ user_id: s.member.id, detail: expect.stringContaining(s.member.id) }), expect.objectContaining({ user_id: s.member.id })])
  })
  it('rejects oversized, noncanonical, mismatched and unsupported avatar payloads', async () => {
    const s = await site()
    for (const body of [{ mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, { mime: 'image/jpeg', data: PNG }, { mime: 'image/png', data: ` ${PNG}` }, { mime: 'image/png', data: 'bad=' }, { mime: 'image/png', data: '' }, { mime: 'image/png', data: Buffer.alloc(512 * 1024 + 1).toString('base64') }, { data: null, userId: s.other.id }, { data: 'https://example.test/a.png' }]) expect([400, 413]).toContain((await s.request(avatar, s.member, body)).status)
    expect(json(await s.request(own)).avatarUrl).toBeNull()
  })
  it('accepts the decoded size limit and supported JPEG and WebP signatures', async () => {
    const s = await site(), maximum = Buffer.alloc(512 * 1024)
    Buffer.from(PNG, 'base64').copy(maximum)
    expect((await s.request(avatar, s.member, { mime: 'image/png', data: maximum.toString('base64') })).status).toBe(200)
    for (const [mime, data] of [['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 16])], ['image/webp', Buffer.from('RIFF0000WEBPVP8 ', 'ascii')]] as const) {
      expect((await s.request(avatar, s.member, { mime, data: data.toString('base64') })).status).toBe(200)
      expect((await s.request(avatar)).headers['content-type']).toBe(mime)
    }
  })
  it('refuses writes with unsupported verbs and rejects unverified or disabled sessions', async () => {
    const s = await site()
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await call(s.config.publicSocket, method, own, { name: 'Wrong verb' }, { cookie: s.member.cookie })).status).toBe(405)
    expect(json(await s.request(own)).name).toBe('member')
    s.sql(db => db.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(s.member.id))
    expect((await s.request(own)).status).toBe(401)
    s.sql(db => { db.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').run(s.member.id); db.prepare('INSERT INTO dsh_user_disabled (user_id, at, reason) VALUES (?, ?, ?)').run(s.member.id, Date.now(), 'disabled') })
    expect((await s.request(own)).status).toBe(401)
    expect((await s.request(avatar)).status).toBe(401)
  })
  it('rate limits avatar updates per authenticated account', async () => {
    const s = await site(), statuses: number[] = []
    for (let n = 0; n < 11; n++) statuses.push((await s.request(avatar, s.member, { data: null })).status)
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200)); expect(statuses[10]).toBe(429)
  })
})
