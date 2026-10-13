/** Private SQLite storage: Better Auth tables plus persistent admission counters, consumed one-time tokens, invite codes and SSO tables. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createSsoStore, type SsoStore } from './sso/store.ts'

/** The identity database with the service-owned tables migrated. */
export interface IdentityDatabase {
  readonly db: DatabaseSync
  /** Enterprise SSO bindings, origins, login state, emergency enrollment and audit. */
  readonly sso: SsoStore
  /** Atomically consume one unit of a fixed-window limit; false when the window is exhausted. */
  consume(key: string, windowMs: number, max: number, now?: number): boolean
  /** Record a one-time token; false when it was already consumed. Only a hash is stored. */
  claimToken(kind: string, token: string, now?: number): boolean
  /** Undo a claim whose request did not complete, so a valid token is not burned by a failure. */
  releaseToken(kind: string, token: string): void
  /** Store a new invite (only its hash) and return the code, shown once. */
  mintInvite(ttlMs: number, note?: string, now?: number): { id: string; code: string; expiresAt: number }
  /** Atomically mark an unexpired, unused invite as used by `email`; false for unknown, expired, revoked or used codes. */
  claimInvite(code: string, email: string, now?: number): boolean
  /** Return a claimed invite to unused when the registration it admitted did not complete. */
  releaseInvite(code: string): void
  /** Revoke an unused invite by its ID; false when no unused invite has that ID. */
  revokeInvite(id: string, now?: number): boolean
  /** Invite metadata for operators; never the code. */
  listInvites(): InviteRecord[]
  /** Delete expired auth-failure rows, login state, assertion IDs and fixed-window rate rows no limit can still read (longest window one day). */
  prune(now: number, failureWindowMs: number): void
  close(): void
}

/** Operator view of one invite. */
export interface InviteRecord { readonly id: string; readonly createdAt: number; readonly expiresAt: number; readonly usedAt: number | null; readonly usedBy: string | null; readonly revokedAt: number | null; readonly note: string | null }

/** Invite code shape: `dshinv-` plus 26 base32 characters (130 random bits). */
export const INVITE_CODE = /^dshinv-[a-z2-7]{26}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function newInviteCode(): string {
  const bytes = randomBytes(26)
  return `dshinv-${Array.from(bytes, byte => BASE32[byte & 31]).join('')}`
}
const inviteHash = (code: string) => createHash('sha256').update(`invite\0${code}`).digest('hex')

/** The longest fixed window in use is one day; rows older than this can no longer affect any limit. */
const RATE_RETENTION_MS = 86_400_000

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
    CREATE TABLE IF NOT EXISTS dsh_used_token (hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_invite (hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      used_at INTEGER, used_by TEXT, revoked_at INTEGER, note TEXT);`)
  const read = db.prepare('SELECT window_start, count FROM dsh_rate WHERE key = ?')
  const write = db.prepare('INSERT INTO dsh_rate (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count')
  const claim = db.prepare('INSERT OR IGNORE INTO dsh_used_token (hash, used_at) VALUES (?, ?)')
  const release = db.prepare('DELETE FROM dsh_used_token WHERE hash = ?')
  const insertInvite = db.prepare('INSERT INTO dsh_invite (hash, id, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?)')
  // A single UPDATE with every condition in its WHERE clause is atomic, so two concurrent signups cannot both claim one code.
  const claimInvite = db.prepare('UPDATE dsh_invite SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
  const releaseInvite = db.prepare('UPDATE dsh_invite SET used_at = NULL, used_by = NULL WHERE hash = ?')
  const revokeInvite = db.prepare('UPDATE dsh_invite SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
  const pruneRates = db.prepare('DELETE FROM dsh_rate WHERE window_start <= ?')
  const listInvites = db.prepare('SELECT id, created_at, expires_at, used_at, used_by, revoked_at, note FROM dsh_invite ORDER BY created_at')
  const sso = createSsoStore(db)
  sso.pruneAudit(Date.now())
  return {
    db,
    sso,
    mintInvite(ttlMs, note, now = Date.now()) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) throw new Error('invite lifetime must be at least one minute')
      const code = newInviteCode(), hash = inviteHash(code), id = hash.slice(0, 12)
      insertInvite.run(hash, id, now, now + ttlMs, note ?? null)
      return { id, code, expiresAt: now + ttlMs }
    },
    claimInvite: (code, email, now = Date.now()) => INVITE_CODE.test(code) && Number(claimInvite.run(now, email, inviteHash(code), now).changes) === 1,
    releaseInvite: code => { if (INVITE_CODE.test(code)) releaseInvite.run(inviteHash(code)) },
    revokeInvite: (id, now = Date.now()) => Number(revokeInvite.run(now, id).changes) === 1,
    listInvites: () => (listInvites.all() as Array<Record<string, number | string | null>>).map(row => ({ id: String(row.id), createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at), usedAt: row.used_at === null ? null : Number(row.used_at), usedBy: row.used_by === null ? null : String(row.used_by),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), note: row.note === null ? null : String(row.note) })),
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
    prune(now, failureWindowMs) {
      sso.pruneFailures(now, failureWindowMs)
      pruneRates.run(now - RATE_RETENTION_MS)
    },
    close: () => db.close(),
  }
}
