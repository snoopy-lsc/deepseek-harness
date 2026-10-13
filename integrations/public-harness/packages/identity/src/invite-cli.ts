#!/usr/bin/env node
/** Operator CLI for invite-only registration (`DSH_CAPTCHA_PROVIDER=none`): mint, list and revoke invite codes.
 * Run as the identity service account so the private database stays owned by it:
 *   sudo -u dsh-identity node lib/invite-cli.js --config /etc/dsh-public/identity.json mint --ttl-hours 72 --count 5 --note "beta wave 1"
 * Codes are printed once and only their SHA-256 hash is stored. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openIdentityDatabase } from './database.ts'

const USAGE = 'usage: dsh-identity-invite --config <identity.json> (mint [--ttl-hours N] [--count N] [--note TEXT] | list | revoke <id>)'

/** Run the CLI.
 * @param argv Arguments after the script name.
 * @param write Output sink (stdout by default).
 * @param now Clock for tests.
 * @returns Process exit code.
 */
export async function runInviteCli(argv: readonly string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`), now = Date.now): Promise<number> {
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
  const databaseFile = (JSON.parse(await readFile(configFile, 'utf8')) as { databaseFile?: unknown }).databaseFile
  if (typeof databaseFile !== 'string' || !isAbsolute(databaseFile) || normalize(databaseFile) !== databaseFile) throw new Error('configuration has no valid databaseFile')
  const command = args.shift()
  const database = await openIdentityDatabase(databaseFile)
  try {
    if (command === 'mint') {
      const hours = Number(take('--ttl-hours') ?? '72'), count = Number(take('--count') ?? '1'), note = take('--note')
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 90) throw new Error('--ttl-hours must be 1..2160')
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--count must be 1..100')
      if (note !== undefined && (note.length > 200 || /[\r\n\0]/.test(note))) throw new Error('--note must be one line of at most 200 characters')
      if (args.length) throw new Error(USAGE)
      for (let i = 0; i < count; i++) {
        const invite = database.mintInvite(hours * 3_600_000, note, now())
        write(`${invite.code}\t${invite.id}\texpires ${new Date(invite.expiresAt).toISOString()}`)
      }
      return 0
    }
    if (command === 'list' && !args.length) {
      for (const row of database.listInvites()) {
        const state = row.revokedAt !== null ? 'revoked' : row.usedAt !== null ? `used ${new Date(row.usedAt).toISOString()} by ${row.usedBy ?? ''}` : row.expiresAt <= now() ? 'expired' : 'unused'
        write(`${row.id}\t${new Date(row.expiresAt).toISOString()}\t${state}${row.note === null ? '' : `\t${row.note}`}`)
      }
      return 0
    }
    if (command === 'revoke' && args.length === 1 && /^[0-9a-f]{12}$/.test(args[0]!)) {
      if (!database.revokeInvite(args[0]!, now())) { write('no unused invite with that id'); return 1 }
      write('revoked')
      return 0
    }
    throw new Error(USAGE)
  } finally { database.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInviteCli(process.argv.slice(2)).then(code => { process.exitCode = code }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2
  })
}
