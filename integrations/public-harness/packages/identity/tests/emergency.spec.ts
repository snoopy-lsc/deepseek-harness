/** Administrator emergency password (D6): source allow-list, TOTP second factor, replay protection, audit retention and the operator CLI. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'
import { runEmergencyCli } from '../src/emergency-cli.ts'
import { startIdentity } from '../src/index.ts'
import { openSecret, sealSecret } from '../src/sso/emergency.ts'
import { AUDIT_RETENTION_MS } from '../src/sso/store.ts'
import { totp } from '../src/sso/totp.ts'
import { call, linkIn, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0)) await item.close() })
const ADMIN = { 'x-forwarded-for': '198.51.100.20' }, OUTSIDE = { 'x-forwarded-for': '203.0.113.9' }
const PASSWORD = 'correct horse battery staple'
const env = (extra: Record<string, string> = {}) => ({ DSH_CAPTCHA_PROVIDER: 'none', DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: 'http://127.0.0.1:9', DSH_OIDC_CLIENT_ID: 'harness-test',
  DSH_OIDC_CLIENT_SECRET: 'mock-idp-test-only-value', DSH_SSO_ALLOWED_GROUPS: 'engineering', DSH_SSO_EMERGENCY_ALLOWED_IPS: '198.51.100.0/24', ...extra })

async function start(extra: Record<string, string> = {}) {
  const { dir, config } = await setup({}, env(extra)), box = mailbox()
  let offset = 0
  const clock = () => Date.now() + offset
  const service = await startIdentity(config, { mail: box.mail, clock }); open.push(service)
  const file = join(dir, 'identity.json')
  await writeFile(file, JSON.stringify({ databaseFile: config.databaseFile, secretFile: config.secretFile }))
  return { config, box, file, clock, advance: (ms: number) => { offset += ms } }
}
/** Register a contractor-style password account through an invite and verify its email. */
async function account(config: Awaited<ReturnType<typeof start>>['config'], box: ReturnType<typeof mailbox>, email: string, verify = true) {
  const db = await openIdentityDatabase(config.databaseFile)
  const { code } = db.mintInvite(3_600_000); db.close()
  expect((await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'Admin', email, password: PASSWORD, callbackURL: '/account/verified' },
    { ...ADMIN, 'x-invite-code': code })).status).toBe(200)
  if (verify) { const link = linkIn(box.sent.at(-1)!); expect((await call(config.publicSocket, 'GET', link.pathname + link.search)).status).toBeLessThan(400) }
}
async function enroll(file: string, email: string) {
  const lines: string[] = []
  expect(await runEmergencyCli(['--config', file, 'enroll', '--email', email], line => lines.push(line))).toBe(0)
  const uri = new URL(lines.find(line => line.startsWith('otpauth://'))!)
  const base32 = uri.searchParams.get('secret')!
  let bits = '', bytes: number[] = []
  for (const ch of base32) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0')
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
const emergency = (socket: string, body: Record<string, unknown>, headers: Record<string, string> = ADMIN) => call(socket, 'POST', '/api/auth/emergency/sign-in', body, headers)
const code = (secret: Buffer, now: number) => totp(secret, Math.floor(now / 30_000))

describe('emergency password path', () => {
  it('enrolled_admin_signs_in_from_an_allowed_address_with_a_fresh_code', async () => {
    const { config, box, file, clock, advance } = await start()
    await account(config, box, 'admin@corp.example')
    const secret = await enroll(file, 'admin@corp.example')
    const ok = await emergency(config.publicSocket, { email: 'admin@corp.example', password: PASSWORD, code: code(secret, clock()) })
    expect(ok.status).toBe(200)
    const cookie = sessionCookie(ok)!
    expect((await call(config.sessionSocket, 'POST', '/internal/session', { cookie })).status).toBe(200)
    // The same code cannot be replayed, even inside its time window.
    const replay = await emergency(config.publicSocket, { email: 'admin@corp.example', password: PASSWORD, code: code(secret, clock()) })
    expect(replay.status).toBe(403)
    advance(30_000)
    expect((await emergency(config.publicSocket, { email: 'admin@corp.example', password: PASSWORD, code: code(secret, clock()) })).status).toBe(200)
    // The ordinary password form refuses the administrator.
    const plain = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'admin@corp.example', password: PASSWORD }, ADMIN)
    expect(plain.status).toBe(403)
    expect(JSON.parse(plain.body).code).toBe('sso-only')
  })

  it('every_failed_gate_is_refused_alike_and_audited', async () => {
    const { config, box, file, clock, advance } = await start()
    await account(config, box, 'admin@corp.example')
    await account(config, box, 'contractor@corp.example')
    await account(config, box, 'unverified@corp.example', false)
    const secret = await enroll(file, 'admin@corp.example')
    const fresh = () => code(secret, clock())
    const attempts: Array<[() => Record<string, unknown>, Record<string, string>, string]> = [
      [() => ({ email: 'admin@corp.example', password: PASSWORD, code: fresh() }), OUTSIDE, 'ip'],
      [() => ({ email: 'admin@corp.example', password: PASSWORD }), ADMIN, 'totp'],
      [() => ({ email: 'admin@corp.example', password: PASSWORD, code: fresh() === '000000' ? '111111' : '000000' }), ADMIN, 'totp'],
      [() => ({ email: 'contractor@corp.example', password: PASSWORD, code: '123456' }), ADMIN, 'not-enrolled'],
      [() => ({ email: 'nobody@corp.example', password: PASSWORD, code: '123456' }), ADMIN, 'not-enrolled'],
      [() => ({ email: 'admin@corp.example', password: 'a wrong but long password', code: fresh() }), ADMIN, 'password'],
    ]
    for (const [body, headers, detail] of attempts) {
      const reply = await emergency(config.publicSocket, body(), headers)
      expect(reply.status, detail).toBe(403)
      expect(JSON.parse(reply.body).code).toBe('emergency-denied')
      expect(sessionCookie(reply)).toBeUndefined()
      advance(30_000)
    }
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      const rows = db.sso.listAudit(0).filter(row => row.event === 'emergency-sign-in')
      expect(rows.map(row => [row.outcome, row.detail])).toEqual(attempts.map(([, , detail]) => ['denied', detail]))
      expect(rows[0]!.ip).toBe('203.0.113.9')
      expect(JSON.stringify(rows)).not.toContain(PASSWORD)
    } finally { db.close() }
    // An unverified email cannot be enrolled (D4).
    await expect(runEmergencyCli(['--config', file, 'enroll', '--email', 'unverified@corp.example'], () => {})).rejects.toThrow(/verified/)
  })

  it('disabled_without_an_address_list', async () => {
    const { config } = await start({ DSH_SSO_EMERGENCY_ALLOWED_IPS: '' })
    expect((await emergency(config.publicSocket, { email: 'a@corp.example', password: PASSWORD, code: '123456' })).status).toBe(404)
  })

  it('cli_refuses_sso_accounts_lists_revokes_and_prints_audit', async () => {
    const { config, box, file } = await start()
    await account(config, box, 'admin@corp.example')
    const db = await openIdentityDatabase(config.databaseFile)
    const ssoUser = 'sso-user-1'
    db.db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(ssoUser, 'E', 'employee@corp.example', new Date().toISOString(), new Date().toISOString())
    db.sso.setOrigin(ssoUser, 'sso'); db.close()
    await expect(runEmergencyCli(['--config', file, 'enroll', '--email', 'employee@corp.example'], () => {})).rejects.toThrow(/password account/)
    await enroll(file, 'admin@corp.example')
    const lines: string[] = []
    expect(await runEmergencyCli(['--config', file, 'list'], line => lines.push(line))).toBe(0)
    expect(lines.join('\n')).toContain('admin@corp.example')
    lines.length = 0
    expect(await runEmergencyCli(['--config', file, 'audit', '--days', '30'], line => lines.push(line))).toBe(0)
    expect(lines.join('\n')).toMatch(/emergency-enroll\tok/)
    expect(await runEmergencyCli(['--config', file, 'revoke', '--email', 'admin@corp.example'], () => {})).toBe(0)
    expect((await emergency(config.publicSocket, { email: 'admin@corp.example', password: PASSWORD, code: '123456' })).status).toBe(403)
    await expect(runEmergencyCli(['--config', file, 'explode'], () => {})).rejects.toThrow(/usage/)
    await expect(runEmergencyCli(['--config', file, 'audit', '--days', '400'], () => {})).rejects.toThrow(/days/)
  })

  it('sealed_secrets_need_the_service_secret_and_audit_rows_expire', async () => {
    const sealed = sealSecret(Buffer.from('12345678901234567890'), 'x'.repeat(48))
    expect(sealed).not.toContain('12345678901234567890')
    expect(openSecret(sealed, 'x'.repeat(48)).toString()).toBe('12345678901234567890')
    expect(() => openSecret(sealed, 'y'.repeat(48))).toThrow()
    const { config } = await setup()
    const db = await openIdentityDatabase(config.databaseFile)
    try {
      db.sso.audit({ event: 'emergency-sign-in', outcome: 'denied' }, Date.now() - AUDIT_RETENTION_MS - 1000)
      db.sso.pruneAudit(Date.now())
      expect(db.sso.listAudit(0)).toHaveLength(0)
    } finally { db.close() }
  })
})
