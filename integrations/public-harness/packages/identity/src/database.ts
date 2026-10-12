/** Private SQLite storage: Better Auth tables plus persistent admission counters and consumed one-time tokens. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

/** The identity database with the service-owned tables migrated. */
export interface IdentityDatabase {
  readonly db: DatabaseSync
  /** Atomically consume one unit of a fixed-window limit; false when the window is exhausted. */
  consume(key: string, windowMs: number, max: number, now?: number): boolean
  /** Record a one-time token; false when it was already consumed. Only a hash is stored. */
  claimToken(kind: string, token: string, now?: number): boolean
  /** Undo a claim whose request did not complete, so a valid token is not burned by a failure. */
  releaseToken(kind: string, token: string): void
  close(): void
}

const digest = (kind: string, token: string) => createHash('sha256').update(`${kind}\0${token}`).digest('hex')

/** Open (creating 0600 if absent) and migrate the service-owned tables. An existing file must be a private regular file.
 * @param file Absolute database path.
 * @returns Open database.
 */
export async function openIdentityDatabase(file: string): Promise<IdentityDatabase> {
  const existing = await lstat(file).catch(() => undefined)
  if (existing === undefined) await (await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)).close()
  else if (!existing.isFile() || (existing.mode & 0o077) !== 0 || existing.uid !== process.getuid?.()) throw new Error('identity database is not a private regular file')
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS dsh_rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_used_token (hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL);`)
  const read = db.prepare('SELECT window_start, count FROM dsh_rate WHERE key = ?')
  const write = db.prepare('INSERT INTO dsh_rate (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count')
  const claim = db.prepare('INSERT OR IGNORE INTO dsh_used_token (hash, used_at) VALUES (?, ?)')
  const release = db.prepare('DELETE FROM dsh_used_token WHERE hash = ?')
  return {
    db,
    consume(key, windowMs, max, now = Date.now()) {
      // BEGIN IMMEDIATE takes the write lock first, so two processes cannot both read the last free unit.
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = read.get(key) as { window_start: number; count: number } | undefined
        const fresh = row === undefined || now - row.window_start >= windowMs
        const used = fresh ? 0 : row.count
        if (used >= max) { db.exec('COMMIT'); return false }
        write.run(key, fresh ? now : row.window_start, used + 1)
        db.exec('COMMIT')
        return true
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    claimToken: (kind, token, now = Date.now()) => Number(claim.run(digest(kind, token), now).changes) === 1,
    releaseToken: (kind, token) => { release.run(digest(kind, token)) },
    close: () => db.close(),
  }
}
