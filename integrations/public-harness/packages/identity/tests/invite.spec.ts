/** Invite-only registration (`DSH_CAPTCHA_PROVIDER=none`): storage, single use, expiry, revocation, the service gate and the operator CLI. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { INVITE_CODE, openIdentityDatabase } from '../src/database.ts'
import { startIdentity } from '../src/index.ts'
import { runInviteCli } from '../src/invite-cli.ts'
import { call, mailbox, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0)) await service.close() })
const HOUR = 3_600_000
const signup = (socket: string, email: string, invite?: string, password = 'correct horse battery') =>
  call(socket, 'POST', '/api/auth/sign-up/email', { name: 'A', email, password, callbackURL: '/account/verified' },
    { 'x-forwarded-for': '203.0.113.7', ...invite === undefined ? {} : { 'x-invite-code': invite } })

describe('invite storage', () => {
  it('invite_is_single_use_and_expires', async () => {
    const { config } = await setup()
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      const now = 1_000_000_000_000
      const a = db.mintInvite(HOUR, 'wave 1', now)
      expect(a.code).toMatch(INVITE_CODE)
      expect(db.claimInvite(a.code, 'x@example.test', now + 1)).toBe(true)
      expect(db.claimInvite(a.code, 'y@example.test', now + 2)).toBe(false)
      db.releaseInvite(a.code)
      expect(db.claimInvite(a.code, 'y@example.test', now + 3)).toBe(true)
      const b = db.mintInvite(HOUR, undefined, now)
      expect(db.claimInvite(b.code, 'z@example.test', now + HOUR)).toBe(false)
      const c = db.mintInvite(HOUR, undefined, now)
      expect(db.revokeInvite(c.id, now)).toBe(true)
      expect(db.revokeInvite(c.id, now)).toBe(false)
      expect(db.claimInvite(c.code, 'z@example.test', now + 1)).toBe(false)
      expect(db.claimInvite('dshinv-' + 'a'.repeat(26), 'z@example.test', now)).toBe(false)
      expect(() => db.mintInvite(1000)).toThrow(/minute/)
      expect(db.listInvites().map(row => [row.id, row.usedBy, row.revokedAt !== null])).toEqual([[a.id, 'y@example.test', false], [b.id, null, false], [c.id, null, true]])
      // Only hashes are stored.
      const raw = new DatabaseSync(config.databaseFile)
      const dump = JSON.stringify(raw.prepare('SELECT * FROM dsh_invite').all())
      raw.close()
      for (const invite of [a, b, c]) expect(dump).not.toContain(invite.code)
    } finally { db.close() }
  })

  it('concurrent_claims_admit_one', async () => {
    const { config } = await setup()
    const one = await openIdentityDatabase(config.databaseFile), two = await openIdentityDatabase(config.databaseFile)
    try {
      const { code } = one.mintInvite(HOUR)
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => (i % 2 ? one : two).claimInvite(code, `u${i}@example.test`))))
      expect(results.filter(Boolean)).toHaveLength(1)
    } finally { one.close(); two.close() }
  })
})

describe('invite-only registration', () => {
  async function start() {
    const { config } = await setup({ enrollmentOpen: false }, { DSH_CAPTCHA_PROVIDER: 'none', DSH_CAPTCHA_TEST_TOKEN: undefined })
    const box = mailbox()
    const service = await startIdentity(config, { mail: box.mail }); open.push(service)
    const db = await openIdentityDatabase(config.databaseFile)
    const mint = () => { const invite = db.mintInvite(HOUR); return invite.code }
    open.push({ close: async () => db.close() })
    return { config, box, mint, db }
  }

  it('requires_a_valid_unused_invite', async () => {
    const { config, box, mint, db } = await start()
    expect((await signup(config.publicSocket, 'a@example.test')).status).toBe(403)
    expect((await signup(config.publicSocket, 'a@example.test', 'dshinv-' + 'b'.repeat(26))).status).toBe(403)
    // A CAPTCHA token is no substitute for an invite.
    expect((await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'A', email: 'a@example.test', password: 'correct horse battery' },
      { 'x-captcha-response': 'pass-captcha' })).status).toBe(403)
    const code = mint()
    expect((await signup(config.publicSocket, 'a@example.test', code)).status).toBe(200)
    expect(box.sent).toHaveLength(1)
    expect((await signup(config.publicSocket, 'b@example.test', code)).status).toBe(403)
    expect(db.listInvites()[0]!.usedBy).toBe('a@example.test')
  })

  it('failed_registration_returns_the_invite', async () => {
    const { config, mint } = await start()
    const code = mint()
    // Better Auth rejects the short password; the invite stays usable.
    expect((await signup(config.publicSocket, 'c@example.test', code, 'short')).status).toBe(400)
    expect((await signup(config.publicSocket, 'c@example.test', code)).status).toBe(200)
  })

  it('register_page_asks_for_the_invite', async () => {
    const { config } = await start()
    const page = await call(config.publicSocket, 'GET', '/account/register?lang=en')
    expect(page.body).toContain('name="invite"')
    expect(page.body).toContain('Registration is by invitation')
    expect(page.headers['content-security-policy']).not.toMatch(/https:/)
    // Password reset needs no CAPTCHA in invite mode but stays rate limited.
    expect((await call(config.publicSocket, 'POST', '/api/auth/request-password-reset', { email: 'nobody@example.test', redirectTo: '/account/reset' },
      { 'x-forwarded-for': '203.0.113.8' })).status).toBe(200)
  })
})

describe('invite CLI', () => {
  it('mints_lists_and_revokes', async () => {
    const { dir, config } = await setup()
    const file = join(dir, 'identity.json')
    await writeFile(file, JSON.stringify({ databaseFile: config.databaseFile }))
    const lines: string[] = []
    const now = () => Date.UTC(2026, 9, 13)
    expect(await runInviteCli(['--config', file, 'mint', '--count', '2', '--ttl-hours', '24', '--note', 'beta'], line => lines.push(line), now)).toBe(0)
    expect(lines).toHaveLength(2)
    const [code, id] = lines[0]!.split('\t') as [string, string]
    expect(code).toMatch(INVITE_CODE)
    expect(lines[0]).toContain('expires 2026-10-14T00:00:00.000Z')
    lines.length = 0
    expect(await runInviteCli(['--config', file, 'revoke', id], line => lines.push(line), now)).toBe(0)
    expect(await runInviteCli(['--config', file, 'revoke', id], line => lines.push(line), now)).toBe(1)
    lines.length = 0
    expect(await runInviteCli(['--config', file, 'list'], line => lines.push(line), now)).toBe(0)
    expect(lines[0]).toMatch(new RegExp(`^${id}\\t2026-10-14T00:00:00.000Z\\trevoked\\tbeta$`))
    expect(lines[1]).toMatch(/\tunused\tbeta$/)
    expect(lines.join('\n')).not.toContain(code)
    await expect(runInviteCli(['--config', file, 'mint', '--count', '0'])).rejects.toThrow(/count/)
    await expect(runInviteCli(['mint'])).rejects.toThrow(/usage/)
    await expect(runInviteCli(['--config', file, 'explode'])).rejects.toThrow(/usage/)
  })
})
