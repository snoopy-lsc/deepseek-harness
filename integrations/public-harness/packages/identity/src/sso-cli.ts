#!/usr/bin/env node
/** Operator CLI for SSO account deprovisioning: disable (revokes every session at once), enable and list disabled accounts.
 * Run as the identity service account so the private database stays owned by it:
 *   sudo -u dsh-identity node lib/sso-cli.js --config /etc/dsh-public/identity.json disable --email alice@corp.example --reason offboarded
 * Only SSO accounts can be disabled here; invite and emergency accounts are managed with their own tools. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openIdentityDatabase } from './database.ts'

const USAGE = 'usage: dsh-identity-sso --config <identity.json> (disable --email ADDRESS [--reason TEXT] | enable --email ADDRESS | list-disabled)'

/** Run the CLI.
 * @param argv Arguments after the script name.
 * @param write Output sink (stdout by default).
 * @param now Clock for tests.
 * @returns Process exit code.
 */
export async function runSsoCli(argv: readonly string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`), now = Date.now): Promise<number> {
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
  const parsed = JSON.parse(await readFile(configFile, 'utf8')) as { databaseFile?: unknown }
  const databaseFile = parsed.databaseFile
  if (typeof databaseFile !== 'string' || !isAbsolute(databaseFile) || normalize(databaseFile) !== databaseFile) throw new Error('configuration has no valid databaseFile')
  const command = args.shift()
  const email = take('--email')?.trim().toLowerCase()
  const reason = take('--reason')
  if (args.length || (reason !== undefined && !/^[\x20-\x7e]{1,128}$/.test(reason))) throw new Error(USAGE)
  const database = await openIdentityDatabase(databaseFile)
  try {
    const user = (address: string) => (database.db.prepare('SELECT id FROM user WHERE email = ?').get(address) as { id: string } | undefined)?.id
    if ((command === 'disable' || command === 'enable') && email !== undefined && (command === 'disable' || reason === undefined)) {
      const id = user(email)
      if (id === undefined || database.sso.origin(id) !== 'sso') { write('no SSO account with that email'); return 1 }
      if (command === 'disable') {
        write(database.sso.disableUser(id, `cli${reason === undefined ? '' : `: ${reason}`}`, now(), email) ? 'disabled; every session was revoked' : 'already disabled')
      } else write(database.sso.enableUser(id, now(), email) ? 'enabled; the user can sign in again' : 'not disabled')
      return 0
    }
    if (command === 'list-disabled' && email === undefined && reason === undefined) {
      const byId = database.db.prepare('SELECT email FROM user WHERE id = ?')
      for (const row of database.sso.listDisabled()) write(`${(byId.get(row.userId) as { email: string } | undefined)?.email ?? row.userId}\t${new Date(row.at).toISOString()}\t${row.reason}`)
      return 0
    }
    throw new Error(USAGE)
  } finally { database.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSsoCli(process.argv.slice(2)).then(code => { process.exitCode = code }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2
  })
}
