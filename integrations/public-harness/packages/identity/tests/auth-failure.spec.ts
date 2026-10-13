/** Persistent auth-failure counters: sliding window per key, atomic reservation across connections and processes, restart survival and cleanup. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openIdentityDatabase } from '../src/database.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const fresh = async () => { const dir = await mkdtemp(join(tmpdir(), 'dsh-failure-')); dirs.push(dir); return join(dir, 'identity.db') }
const WINDOW = 15 * 60_000
const limits = (user: string, ip: string) => [{ key: `u:${user}|${ip}`, max: 5 }, { key: `u:${user}`, max: 20 }]

describe('auth failure counters', () => {
  it('reservations_count_per_key_and_release_or_clear_on_success', async () => {
    const db = await openIdentityDatabase(await fresh())
    try {
      const held: number[][] = []
      for (let i = 0; i < 5; i++) { const ids = db.sso.reserveAttempt(limits('alice', '192.0.2.1'), WINDOW, 1_000 + i); expect(ids).toHaveLength(2); held.push(ids!) }
      expect(db.sso.reserveAttempt(limits('alice', '192.0.2.1'), WINDOW, 2_000)).toBeUndefined()
      // Another IP still has room: the per-user limit is 20.
      expect(db.sso.reserveAttempt(limits('alice', '192.0.2.2'), WINDOW, 2_000)).toHaveLength(2)
      // An outage releases its reservation; it was never a wrong password.
      db.sso.releaseAttempt(held.pop()!)
      const ok = db.sso.reserveAttempt(limits('alice', '192.0.2.1'), WINDOW, 2_100)!
      // A successful sign-in releases its own reservation and clears the (user, IP) key, leaving the per-user history.
      db.sso.releaseAttempt(ok); db.sso.clearFailures('u:alice|192.0.2.1')
      expect(db.sso.failureCount('u:alice|192.0.2.1', 0)).toBe(0)
      expect(db.sso.failureCount('u:alice', 0)).toBe(5)
      // The window slides: old failures stop counting.
      for (let i = 0; i < 5; i++) db.sso.reserveAttempt(limits('bob', '192.0.2.1'), WINDOW, 10_000)
      expect(db.sso.reserveAttempt(limits('bob', '192.0.2.1'), WINDOW, 10_000 + WINDOW - 1)).toBeUndefined()
      expect(db.sso.reserveAttempt(limits('bob', '192.0.2.1'), WINDOW, 10_000 + WINDOW)).toHaveLength(2)
      // Keys are stored hashed: no username or address in the table.
      const raw = JSON.stringify(db.db.prepare('SELECT * FROM dsh_auth_failure').all())
      expect(raw).not.toContain('alice'); expect(raw).not.toContain('192.0.2')
    } finally { db.close() }
  })

  it('counters_survive_a_restart_and_expired_rows_are_pruned', async () => {
    const file = await fresh()
    let db = await openIdentityDatabase(file)
    for (let i = 0; i < 5; i++) db.sso.reserveAttempt(limits('carol', '198.51.100.9'), WINDOW, 50_000)
    db.consume('login-ip:198.51.100.9', 60_000, 30, 50_000)
    db.close()
    db = await openIdentityDatabase(file)
    try {
      expect(db.sso.reserveAttempt(limits('carol', '198.51.100.9'), WINDOW, 60_000)).toBeUndefined()
      const count = (table: string) => (db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
      expect(count('dsh_auth_failure')).toBe(10)
      expect(count('dsh_rate')).toBe(1)
      db.prune(50_000 + WINDOW + 1, WINDOW)
      expect(count('dsh_auth_failure')).toBe(0)
      // Fixed-window rate rows go once no limit (longest one day) can still read them.
      expect(count('dsh_rate')).toBe(1)
      db.prune(50_000 + 2 * 86_400_000, WINDOW)
      expect(count('dsh_rate')).toBe(0)
    } finally { db.close() }
  })

  it('concurrent_processes_never_admit_more_than_the_limit', async () => {
    const file = await fresh()
    ;(await openIdentityDatabase(file)).close()
    const script = `import { openIdentityDatabase } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/database.ts')).href)}
const db = await openIdentityDatabase(${JSON.stringify(file)}); let n = 0
for (let i = 0; i < 10; i++) if (db.sso.reserveAttempt([{ key: 'u:dave|203.0.113.1', max: 5 }], ${WINDOW}, Date.now()) !== undefined) n++
db.close(); process.stdout.write(String(n))`
    const run = promisify(execFile)
    const results = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: import.meta.dirname })))
    expect(results.reduce((sum, { stdout }) => sum + Number(stdout), 0)).toBe(5)
  }, 60_000)
})
