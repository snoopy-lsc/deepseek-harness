import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ADMIN_ENDPOINTS, csvCell, csvRow, redactSso, SSO_REAUTH_WINDOW_MS } from '../src/admin.ts'
import { startIdentity } from '../src/index.ts'
import type { QuotaAdmin, QuotaLimits } from '../src/quota-account.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0)) await service.close() })
const PASSWORD = 'correct horse battery'

function fakeQuota(): QuotaAdmin & { calls: unknown[] } {
  let limits: QuotaLimits = { configuredDailyTokens: 400000, defaultDailyTokens: 400000, overrides: [], overLimit: { mode: 'block', gracePercent: 10 } }
  const calls: unknown[] = []
  return { calls, limits: async () => limits,
    setDefault: async n => { calls.push(['default', n]); limits = { ...limits, defaultDailyTokens: n ?? 400000, ...n === null ? {} : { defaultOverride: n } }; return limits },
    setUser: async (id, n) => { calls.push(['user', id, n]); limits = { ...limits, overrides: n === null ? [] : [{ userId: id, dailyTokens: n }] }; return limits },
    setOverLimit: async (mode, gracePercent) => { calls.push(['over-limit', mode, gracePercent]); limits = { ...limits, overLimit: { mode, gracePercent } }; return limits } }
}

async function site(options: { quota?: boolean; clock?: () => number } = {}) {
  const { dir } = await setup()
  const { config } = await setup({}, { ...localEnv(dir), DSH_ADMIN_EMAILS: 'root@example.test' })
  const box = mailbox(), quota = fakeQuota()
  const service = await startIdentity(config, { mail: box.mail, ...options.quota === false ? {} : { quota }, ...options.clock ? { clock: options.clock } : {} }); open.push(service)
  let n = 0
  const enroll = async (email: string) => {
    const ip = { 'x-forwarded-for': `198.51.100.${++n}` }
    await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: email.split('@')[0], email, password: PASSWORD, callbackURL: '/account/verified' }, { ...ip, 'x-captcha-response': 'pass-captcha' })
    const verify = linkIn(box.sent.at(-1)!); await call(config.publicSocket, 'GET', verify.pathname + verify.search)
    const reply = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password: PASSWORD }, ip)
    return { cookie: sessionCookie(reply)!, id: (JSON.parse(reply.body) as { user: { id: string } }).user.id, email }
  }
  const get = (path: string, cookie: string) => call(config.publicSocket, 'GET', `/api/admin${path}`, undefined, { cookie })
  const post = (path: string, body: unknown, cookie: string, headers: Record<string, string> = {}) => call(config.publicSocket, 'POST', `/api/admin${path}`, body, { cookie, 'x-forwarded-for': '203.0.113.50', ...headers })
  const audit = () => {
    const db = new DatabaseSync(config.databaseFile, { readOnly: true })
    try { return db.prepare('SELECT event, outcome, user_id, detail FROM dsh_audit ORDER BY id').all() as Array<{ event: string; outcome: string; user_id: string | null; detail: string | null }> } finally { db.close() }
  }
  const sso = (userId: string) => {
    const db = new DatabaseSync(config.databaseFile)
    db.prepare("INSERT INTO dsh_user_origin (user_id, origin) VALUES (?, 'sso') ON CONFLICT(user_id) DO UPDATE SET origin = 'sso'").run(userId)
    db.close()
  }
  const root = await enroll('root@example.test'), member = await enroll('member@example.test')
  return { config, enroll, get, post, audit, root, member, quota, sso }
}
const json = (reply: { body: string }) => JSON.parse(reply.body)

describe('/api/admin', () => {
  it('members_get_403_and_anonymous_401_on_every_admin_endpoint', async () => {
    const s = await site()
    for (const path of ADMIN_ENDPOINTS.GET) {
      expect((await s.get(path, s.member.cookie)).status, `GET ${path}`).toBe(403)
      expect((await s.get(path, 'dsh-account.session_token=forged')).status, `GET ${path}`).toBe(401)
      expect((await s.get(path, s.root.cookie)).status, `admin GET ${path}`).toBe(200)
    }
    for (const path of ADMIN_ENDPOINTS.POST) {
      // A body that would succeed for an administrator; members are refused before it is read.
      const reply = await s.post(path, { userId: s.root.id, id: 'x', role: 'member', dailyTokens: 1, password: PASSWORD }, s.member.cookie)
      expect(reply.status, `POST ${path}`).toBe(403)
      expect(json(reply)).toEqual({ code: 'forbidden' })
      expect((await s.post(path, {}, 'dsh-account.session_token=forged')).status, `POST ${path}`).toBe(401)
    }
    // Only the administrator's own export left a row.
    expect(s.audit().filter(row => row.event.startsWith('admin-')).map(row => row.event)).toEqual(['admin-audit-export'])
  })

  it('writes_need_the_site_origin_and_json', async () => {
    const s = await site()
    expect((await s.post('/invites', {}, s.root.cookie, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await s.post('/invites', 'ttlHours=1', s.root.cookie, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect((await s.post('/nope', {}, s.root.cookie)).status).toBe(404)
  })

  it('invites_are_created_listed_and_revoked_with_audit', async () => {
    const s = await site()
    const invite = json(await s.post('/invites', { ttlHours: 24, note: 'new hire' }, s.root.cookie))
    expect(invite.code).toMatch(/^dshinv-/)
    const listed = json(await s.get('/invites', s.root.cookie)).invites
    expect(listed[0]).toMatchObject({ id: invite.id, note: 'new hire', revokedAt: null })
    expect(JSON.stringify(listed)).not.toContain(invite.code)
    expect((await s.post('/invites/revoke', { id: invite.id }, s.root.cookie)).status).toBe(200)
    expect((await s.post('/invites/revoke', { id: invite.id }, s.root.cookie)).status).toBe(404)
    expect(s.audit().filter(r => r.event.startsWith('admin-')).map(r => [r.event, r.detail])).toEqual([
      ['admin-invite-create', `by=root@example.test invite=${invite.id}`], ['admin-invite-revoke', `by=root@example.test invite=${invite.id}`]])
  })

  it('lists_and_searches_users_with_role_status_provider_and_last_login', async () => {
    const s = await site()
    const all = json(await s.get('/users', s.root.cookie))
    expect(all.total).toBe(2)
    expect(all.users.find((u: { id: string }) => u.id === s.root.id)).toMatchObject({ role: 'admin', roleSource: 'config', status: 'active', provider: 'password', lastLoginAt: expect.any(Number) })
    expect(json(await s.get('/users?q=MEMBER', s.root.cookie)).users.map((u: { email: string }) => u.email)).toEqual(['member@example.test'])
    expect(json(await s.get('/users?role=admin', s.root.cookie)).users).toHaveLength(1)
    expect(json(await s.get('/users?q=%25', s.root.cookie)).users).toHaveLength(0)
  })

  it('disable_needs_the_password_revokes_sessions_and_enable_restores_sign_in', async () => {
    const s = await site()
    const need = await s.post('/users/disable', { userId: s.member.id }, s.root.cookie)
    expect([need.status, json(need)]).toEqual([401, { code: 'reauth-required', method: 'password' }])
    const wrong = await s.post('/users/disable', { userId: s.member.id, password: 'not the password' }, s.root.cookie)
    expect([wrong.status, json(wrong).code]).toEqual([403, 'reauth'])
    expect((await s.post('/users/disable', { userId: s.member.id, password: PASSWORD, reason: 'left' }, s.root.cookie)).status).toBe(200)
    expect((await call(s.config.publicSocket, 'GET', '/account/api/me', undefined, { cookie: s.member.cookie })).status).toBe(401)
    expect(json(await s.get('/users?status=disabled', s.root.cookie)).users).toEqual([expect.objectContaining({ id: s.member.id, disabledReason: 'admin:left', lastLoginAt: expect.any(Number) })])
    expect((await s.post('/users/enable', { userId: s.member.id }, s.root.cookie)).status).toBe(200)
    expect(s.audit().filter(r => r.user_id === s.member.id && r.event !== 'password-change').map(r => [r.event, r.outcome])).toEqual([
      ['sso-disable', 'ok'], ['admin-user-disable', 'ok'], ['sso-enable', 'ok'], ['admin-user-enable', 'ok']])
    expect(s.audit().filter(r => r.event === 'admin-reauth').map(r => r.outcome)).toEqual(['denied'])
  })

  it('the_last_administrator_cannot_be_disabled_or_demoted_and_config_admins_stay', async () => {
    const s = await site()
    const self = await s.post('/users/disable', { userId: s.root.id, password: PASSWORD }, s.root.cookie)
    expect([self.status, json(self).code]).toEqual([409, 'last-admin'])
    expect(json(await s.post('/users/role', { userId: s.root.id, role: 'member', password: PASSWORD }, s.root.cookie)).code).toBe('config-admin')
    expect(json(await s.post('/users/role', { userId: s.member.id, role: 'admin', password: PASSWORD }, s.root.cookie))).toEqual({ role: 'admin', changed: true })
    // The new administrator disables the configured one; the grant is now the only active administrator and cannot remove itself.
    expect((await s.post('/users/disable', { userId: s.root.id, password: PASSWORD }, s.member.cookie)).status).toBe(200)
    const demote = await s.post('/users/role', { userId: s.member.id, role: 'member', password: PASSWORD }, s.member.cookie)
    expect([demote.status, json(demote).code]).toEqual([409, 'last-admin'])
    expect(s.audit().filter(r => r.event === 'admin-role-change').map(r => r.outcome)).toEqual(['ok', 'denied'])
  })

  it('sso_administrators_reauthenticate_by_a_fresh_sign_in', async () => {
    let now = Date.now()
    const s = await site({ clock: () => now })
    s.sso(s.root.id)
    const target = await s.enroll('third@example.test')
    now += SSO_REAUTH_WINDOW_MS + 60_000
    const stale = await s.post('/users/disable', { userId: target.id }, s.root.cookie)
    expect([stale.status, json(stale)]).toEqual([401, { code: 'reauth-required', method: 'sso' }])
    now -= SSO_REAUTH_WINDOW_MS
    expect((await s.post('/users/disable', { userId: target.id }, s.root.cookie)).status).toBe(200)
  })

  it('quota_limits_are_read_and_edited_through_the_ledger_with_reauth_and_audit', async () => {
    const s = await site()
    expect(json(await s.get('/quota', s.root.cookie)).configuredDailyTokens).toBe(400000)
    expect((await s.post('/quota/user', { userId: s.member.id, dailyTokens: 5000 }, s.root.cookie)).status).toBe(401)
    expect(json(await s.post('/quota/user', { userId: s.member.id, dailyTokens: 5000, password: PASSWORD }, s.root.cookie)).overrides).toEqual([{ userId: s.member.id, dailyTokens: 5000 }])
    expect(json(await s.post('/quota/default', { dailyTokens: 100000, password: PASSWORD }, s.root.cookie)).defaultDailyTokens).toBe(100000)
    expect((await s.post('/quota/default', { dailyTokens: -1, password: PASSWORD }, s.root.cookie)).status).toBe(400)
    expect(s.quota.calls).toEqual([['user', s.member.id, 5000], ['default', 100000]])
    expect(s.audit().filter(r => r.event === 'admin-quota-change').map(r => r.detail)).toEqual(['by=root@example.test daily=5000', 'by=root@example.test default=100000'])
  })

  it('the_over_limit_policy_is_set_with_reauth_and_audit_and_rejects_unknown_modes', async () => {
    const s = await site()
    expect((await s.post('/quota/over-limit', { mode: 'grace', gracePercent: 20 }, s.root.cookie)).status).toBe(401)
    expect(json(await s.post('/quota/over-limit', { mode: 'grace', gracePercent: 20, password: PASSWORD }, s.root.cookie)).overLimit).toEqual({ mode: 'grace', gracePercent: 20 })
    expect(json(await s.post('/quota/over-limit', { mode: 'warn', password: PASSWORD }, s.root.cookie)).overLimit).toEqual({ mode: 'warn', gracePercent: 10 })
    for (const bad of [{ mode: 'loose' }, { mode: 'grace', gracePercent: 0 }, { mode: 'grace', gracePercent: 101 }, { mode: 'grace', gracePercent: '5' }]) {
      expect((await s.post('/quota/over-limit', { ...bad, password: PASSWORD }, s.root.cookie)).status).toBe(400)
    }
    expect(s.quota.calls).toEqual([['over-limit', 'grace', 20], ['over-limit', 'warn', 10]])
    expect(s.audit().filter(r => r.event === 'admin-over-limit-change').map(r => r.detail)).toEqual(['by=root@example.test mode=grace grace=20%', 'by=root@example.test mode=warn'])
  })

  it('audit_csv_export_honours_filters_neutralises_formulas_is_audited_and_rate_limited', async () => {
    const s = await site()
    expect((await s.post('/invites', {}, s.root.cookie)).status).toBe(200)
    // Rows whose text a spreadsheet would run as formulas, plus quotes, commas, newlines and Chinese.
    for (const id of ['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', '\tTAB', '\rCR', 'a,"b"\nc', '中文邀请']) {
      const db = new DatabaseSync(s.config.databaseFile)
      db.prepare("INSERT INTO dsh_audit (at, event, outcome, email, detail) VALUES (?, 'sso-login', 'denied', ?, ?)").run(Date.now(), 'x@example.test', id)
      db.close()
    }
    const reply = await s.get('/audit.csv?event=sso-login&outcome=denied', s.root.cookie)
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(reply.headers['content-disposition']).toMatch(/^attachment; filename="audit-\d{8}\.csv"$/)
    expect(reply.headers['x-audit-export-rows']).toBe('8')
    expect(reply.body.startsWith('\uFEFF"id","time (UTC)","event","outcome","email","user id","ip","detail"\r\n')).toBe(true)
    expect(reply.body).toContain('"\'=HYPERLINK(""http://x"")"')
    for (const cell of ['"\'+1"', '"\'-2"', '"\'@SUM(A1)"', '"\'\tTAB"', '"\'\rCR"', '"a,""b""\nc"', '"中文邀请"']) expect(reply.body).toContain(cell)
    expect(reply.body).not.toContain('"admin-invite-create"')
    const exports = s.audit().filter(r => r.event === 'admin-audit-export')
    expect(exports.map(r => r.detail)).toEqual(['by=root@example.test rows=8 event=sso-login outcome=denied q=""'])
    expect((await s.get('/audit.csv', s.member.cookie)).status).toBe(403)
    for (let i = 0; i < 9; i++) expect((await s.get('/audit.csv?q=none', s.root.cookie)).status).toBe(200)
    expect((await s.get('/audit.csv?q=none', s.root.cookie)).status).toBe(429)
  })

  it('csv_cells_quote_everything_and_prefix_formula_starts', () => {
    expect(csvCell(null)).toBe('""')
    expect(csvCell('=1+1')).toBe(`"'=1+1"`)
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell(42)).toBe('"42"')
    expect(csvRow(['-x', 'ok'])).toBe(`"'-x","ok"\r\n`)
  })

  it('quota_endpoints_answer_404_without_a_ledger_and_sso_view_redacts_secrets', async () => {
    const s = await site({ quota: false })
    expect((await s.get('/quota', s.root.cookie)).status).toBe(404)
    const view = json(await s.get('/sso', s.root.cookie))
    expect(view).toMatchObject({ provider: { kind: 'off' }, reconcile: { scheduled: false, last: null }, adminEmails: ['root@example.test'] })
    expect(redactSso({ kind: 'oidc', clientId: 'app', clientSecret: 's3cret', idpCerts: ['a', 'b'], bindPassword: 'pw' }))
      .toEqual({ kind: 'oidc', clientId: 'app', clientSecret: '[redacted]', idpCerts: '2 pinned', bindPassword: '[redacted]' })
  })

  it('profile_role_follows_console_grants', async () => {
    const s = await site()
    await s.post('/users/role', { userId: s.member.id, role: 'admin', password: PASSWORD }, s.root.cookie)
    expect(json(await call(s.config.publicSocket, 'GET', '/account/api/me', undefined, { cookie: s.member.cookie })).role).toBe('admin')
  })
})
