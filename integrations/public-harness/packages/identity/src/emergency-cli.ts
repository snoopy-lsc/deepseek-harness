#!/usr/bin/env node
/** Operator CLI for the administrator emergency password path (decision D6): enroll, revoke and list administrators, and read the audit log.
 * Run as the identity service account so the private database and secret stay owned by it:
 *   sudo -u dsh-identity node lib/emergency-cli.js --config /etc/dsh-public/identity.json enroll --email admin@corp.example
 * Enrollment needs an existing password account with a verified email that is not bound to SSO; the TOTP URI is printed once. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openIdentityDatabase } from './database.ts'
import { readSecret } from './secret.ts'
import { sealSecret } from './sso/emergency.ts'
import { newTotpSecret, otpauthUri } from './sso/totp.ts'

const USAGE = 'usage: dsh-identity-emergency --config <identity.json> (enroll --email ADDRESS | revoke --email ADDRESS | list | audit [--days N])'
const DAY = 86_400_000

/** Run the CLI.
 * @param argv Arguments after the script name.
 * @param write Output sink (stdout by default).
 * @param now Clock for tests.
 * @returns Process exit code.
 */
export async function runEmergencyCli(argv: readonly string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`), now = Date.now): Promise<number> {
  const args = [...argv]
  const take = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (value === undefined) throw new Error(USAGE)
    args.splice(index, 2)
    return value
  }
  const configFile = take('--config')
  if (configFile === undefined || !isAbsolute(configFile)) throw new Error(USAGE)
  const parsed = JSON.parse(await readFile(configFile, 'utf8')) as { databaseFile?: unknown; secretFile?: unknown }
  const file = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value) throw new Error(`configuration has no valid ${field}`)
    return value
  }
  const databaseFile = file(parsed.databaseFile, 'databaseFile')
  const command = args.shift()
  const email = take('--email')?.trim().toLowerCase()
  const days = take('--days')
  if (args.length) throw new Error(USAGE)
  const database = await openIdentityDatabase(databaseFile)
  try {
    const user = (address: string) => database.db.prepare('SELECT id, emailVerified FROM user WHERE email = ?').get(address) as { id: string; emailVerified: number } | undefined
    if (command === 'enroll' && email !== undefined) {
      const found = user(email)
      const password = found !== undefined && database.db.prepare("SELECT 1 FROM account WHERE userId = ? AND providerId = 'credential'").get(found.id) !== undefined
      if (found === undefined || !password || database.sso.origin(found.id) === 'sso') throw new Error('enrollment needs an existing password account that is not bound to SSO')
      if (!found.emailVerified) throw new Error('enrollment needs a verified email')
      const secret = newTotpSecret()
      database.sso.setOrigin(found.id, 'emergency')
      database.sso.enrollEmergency(found.id, sealSecret(secret, await readSecret(file(parsed.secretFile, 'secretFile'))), now())
      database.sso.audit({ event: 'emergency-enroll', outcome: 'ok', userId: found.id, email }, now())
      write('Add this URI to the administrator\'s authenticator app now; it is not shown again:')
      write(otpauthUri(secret, email, 'DeepSeek Harness emergency'))
      return 0
    }
    if (command === 'revoke' && email !== undefined) {
      const found = user(email)
      if (found === undefined || !database.sso.revokeEmergency(found.id)) { write('no enrolled administrator with that email'); return 1 }
      database.sso.audit({ event: 'emergency-revoke', outcome: 'ok', userId: found.id, email }, now())
      write('revoked')
      return 0
    }
    if (command === 'list' && email === undefined) {
      const byId = database.db.prepare('SELECT email FROM user WHERE id = ?')
      for (const row of database.sso.listEmergency()) write(`${(byId.get(row.userId) as { email: string } | undefined)?.email ?? row.userId}\tenrolled ${new Date(row.enrolledAt).toISOString()}`)
      return 0
    }
    if (command === 'audit' && email === undefined) {
      const span = Number(days ?? '30')
      if (!Number.isInteger(span) || span < 1 || span > 365) throw new Error('--days must be 1..365')
      for (const row of database.sso.listAudit(now() - span * DAY)) {
        write([new Date(row.at).toISOString(), row.event, row.outcome, row.email ?? '', row.ip ?? '', row.detail ?? ''].join('\t'))
      }
      return 0
    }
    throw new Error(USAGE)
  } finally { database.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEmergencyCli(process.argv.slice(2)).then(code => { process.exitCode = code }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2
  })
}
