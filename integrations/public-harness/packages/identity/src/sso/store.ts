/** SSO tables: `(provider, subject)` bindings, account origins, single-use login state, emergency enrollment and the audit log. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** How an account came to exist; decides which sign-in paths it may use. */
export type AccountOrigin = 'sso' | 'invite' | 'emergency'
/** Login state lifetime between `/sso/start` and `/sso/callback`. */
export const STATE_TTL_MS = 10 * 60_000
/** Audit retention (decision D6): one year. */
export const AUDIT_RETENTION_MS = 365 * 86_400_000

/** One audit entry; never holds passwords, codes or tokens. */
export interface AuditEvent {
  readonly event: 'sso-sign-in' | 'emergency-sign-in' | 'emergency-enroll' | 'emergency-revoke' | 'sso-disable' | 'sso-enable' | 'sso-reconcile'
    | 'password-change' | 'session-revoke' | 'sessions-revoke-others'
    | 'admin-invite-create' | 'admin-invite-revoke' | 'admin-user-disable' | 'admin-user-enable' | 'admin-role-change' | 'admin-quota-change' | 'admin-reauth'
  readonly outcome: 'ok' | 'denied' | 'error'
  readonly userId?: string
  readonly email?: string
  readonly ip?: string
  readonly detail?: string
}
/** A stored audit row. */
export interface AuditRow extends AuditEvent { readonly at: number }

/** A binding or origin change that would break D2/D3. */
export class SsoBindingError extends Error {
  override readonly name = 'SsoBindingError'
  constructor(readonly code: 'origin' | 'conflict') { super(`sso binding refused: ${code}`) }
}

/** One `(provider, subject)` binding with its last successful sign-in (undefined until the first sign-in after this column existed). */
export interface SsoLink { readonly provider: string; readonly subject: string; readonly userId: string; readonly createdAt: number; readonly lastLoginAt: number | undefined }
const link = (row: Record<string, unknown>): SsoLink => ({ provider: String(row.provider), subject: String(row.subject), userId: String(row.user_id),
  createdAt: Number(row.created_at), lastLoginAt: row.last_login_at === null ? undefined : Number(row.last_login_at) })
/** A deprovisioned account. */
export interface DisabledAccount { readonly userId: string; readonly at: number; readonly reason: string }

/** Saved login state for one browser. */
export interface LoginState { readonly nonce: string; readonly verifier: string; readonly returnTo: string }

/** Service-owned SSO storage. */
export interface SsoStore {
  /** Save login state under the hash of its `state` value. */
  saveState(state: string, record: LoginState & { readonly browser: string }, now: number): void
  /** Consume login state once; a wrong browser or an expired row also consumes it and returns undefined. */
  takeState(state: string, browser: string, now: number): LoginState | undefined
  /** Record a SAML assertion ID until it expires; false when it was already used (replay). */
  useAssertion(id: string, expiresAt: number, now: number): boolean
  /** The user bound to a provider subject. */
  findSubject(provider: string, subject: string): string | undefined
  /** Bind a subject to an SSO-origin user; one subject per user per provider, never an invite or emergency account. */
  bindSubject(provider: string, subject: string, userId: string, now: number): void
  /** The recorded origin of an account. */
  origin(userId: string): AccountOrigin | undefined
  /** Record an origin; SSO accounts never change origin and other accounts never become SSO accounts. */
  setOrigin(userId: string, origin: AccountOrigin): void
  /** Store an emergency administrator's sealed TOTP secret. */
  enrollEmergency(userId: string, sealedSecret: string, now: number): void
  /** The sealed TOTP secret of an enrolled administrator. */
  emergencySecret(userId: string): string | undefined
  /** Remove an emergency enrollment. */
  revokeEmergency(userId: string): boolean
  /** Enrolled administrators. */
  listEmergency(): Array<{ userId: string; enrolledAt: number }>
  /** Mark a TOTP step used; false when it, or a later step, was already used. */
  useTotpStep(userId: string, step: number): boolean
  /** Append an audit row and drop rows past retention. */
  audit(event: AuditEvent, now: number): void
  /** Audit rows at or after `since`, oldest first. */
  listAudit(since: number): AuditRow[]
  /** Drop audit rows older than the retention period. */
  pruneAudit(now: number): void
  /** Atomically check every limit (failures in the last `windowMs` per key) and, when all have room, record one pending failure per key.
   * Returns the row IDs to release when the attempt turns out not to be a failure, or undefined when any key is at its limit. */
  reserveAttempt(limits: ReadonlyArray<{ readonly key: string; readonly max: number }>, windowMs: number, now: number): number[] | undefined
  /** Remove reserved failure rows (successful sign-in, or an outage that says nothing about the password). */
  releaseAttempt(ids: readonly number[]): void
  /** Forget every recorded failure of one key. */
  clearFailures(key: string): void
  /** Failures of one key at or after `since`. */
  failureCount(key: string, since: number): number
  /** Delete failure rows older than the window, expired login state and expired assertion IDs. */
  pruneFailures(now: number, windowMs: number): void
  /** Bindings of one provider, oldest first. */
  listLinks(provider: string): SsoLink[]
  /** Every binding of one account, oldest first. */
  linksOf(userId: string): SsoLink[]
  /** Record a successful sign-in of a bound subject. */
  touchLogin(provider: string, subject: string, now: number): void
  /** The disable record of an account, if any. */
  disabledAt(userId: string): DisabledAccount | undefined
  /** In one transaction: mark the account disabled, delete all its Better Auth sessions and write an `sso-disable` audit row.
   * Returns false (and changes nothing) when it was already disabled. */
  disableUser(userId: string, reason: string, now: number, email?: string): boolean
  /** Lift a disable; existing sessions are not restored. Returns false when the account was not disabled. */
  enableUser(userId: string, now: number, email?: string): boolean
  /** Every disabled account, oldest first. */
  listDisabled(): DisabledAccount[]
}

const hash = (value: string) => createHash('sha256').update(`sso-state\0${value}`).digest('hex')

/** Migrate and wrap the SSO tables.
 * @param db Open identity database.
 * @returns Store.
 */
export function createSsoStore(db: DatabaseSync): SsoStore {
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_sso_link (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subject), UNIQUE (provider, user_id));
    CREATE TABLE IF NOT EXISTS dsh_user_origin (user_id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK (origin IN ('sso', 'invite', 'emergency')));
    CREATE TABLE IF NOT EXISTS dsh_sso_state (hash TEXT PRIMARY KEY, browser TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_emergency (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1, enrolled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL,
      user_id TEXT, email TEXT, ip TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS dsh_audit_at ON dsh_audit (at);
    CREATE TABLE IF NOT EXISTS dsh_sso_assertion (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_auth_failure (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS dsh_auth_failure_key ON dsh_auth_failure (key, at);
    CREATE INDEX IF NOT EXISTS dsh_auth_failure_at ON dsh_auth_failure (at);
    CREATE TABLE IF NOT EXISTS dsh_user_disabled (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL);`)
  // Added after the first release: older databases get the column in place; existing rows start without a last sign-in.
  if (!(db.prepare('PRAGMA table_info(dsh_sso_link)').all() as Array<{ name: string }>).some(column => column.name === 'last_login_at')) {
    db.exec('ALTER TABLE dsh_sso_link ADD COLUMN last_login_at INTEGER')
  }
  const insertState = db.prepare('INSERT INTO dsh_sso_state (hash, browser, nonce, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
  const takeState = db.prepare('DELETE FROM dsh_sso_state WHERE hash = ? RETURNING browser, nonce, verifier, return_to, expires_at')
  const dropExpired = db.prepare('DELETE FROM dsh_sso_state WHERE expires_at <= ?')
  const insertAssertion = db.prepare('INSERT INTO dsh_sso_assertion (hash, expires_at) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING')
  const dropAssertions = db.prepare('DELETE FROM dsh_sso_assertion WHERE expires_at <= ?')
  const findSubject = db.prepare('SELECT user_id FROM dsh_sso_link WHERE provider = ? AND subject = ?')
  const insertLink = db.prepare('INSERT INTO dsh_sso_link (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
  const readOrigin = db.prepare('SELECT origin FROM dsh_user_origin WHERE user_id = ?')
  const writeOrigin = db.prepare('INSERT INTO dsh_user_origin (user_id, origin) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET origin = excluded.origin')
  const enroll = db.prepare('INSERT INTO dsh_emergency (user_id, secret, enrolled_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, last_step = -1, enrolled_at = excluded.enrolled_at')
  const secret = db.prepare('SELECT secret FROM dsh_emergency WHERE user_id = ?')
  const revoke = db.prepare('DELETE FROM dsh_emergency WHERE user_id = ?')
  const listEmergency = db.prepare('SELECT user_id, enrolled_at FROM dsh_emergency ORDER BY enrolled_at')
  // Conditional UPDATE: a step is accepted once, and never after a later step, so a captured code cannot be replayed.
  const useStep = db.prepare('UPDATE dsh_emergency SET last_step = ? WHERE user_id = ? AND last_step < ?')
  const insertAudit = db.prepare('INSERT INTO dsh_audit (at, event, outcome, user_id, email, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const prune = db.prepare('DELETE FROM dsh_audit WHERE at < ?')
  const listAudit = db.prepare('SELECT at, event, outcome, user_id, email, ip, detail FROM dsh_audit WHERE at >= ? ORDER BY at, id')
  const countFailures = db.prepare('SELECT count(*) AS n FROM dsh_auth_failure WHERE key = ? AND at > ?')
  const countSince = db.prepare('SELECT count(*) AS n FROM dsh_auth_failure WHERE key = ? AND at >= ?')
  const insertFailure = db.prepare('INSERT INTO dsh_auth_failure (key, at) VALUES (?, ?)')
  const deleteFailure = db.prepare('DELETE FROM dsh_auth_failure WHERE id = ?')
  const clearFailures = db.prepare('DELETE FROM dsh_auth_failure WHERE key = ?')
  const pruneFailures = db.prepare('DELETE FROM dsh_auth_failure WHERE at <= ?')
  const listLinks = db.prepare('SELECT provider, subject, user_id, created_at, last_login_at FROM dsh_sso_link WHERE provider = ? ORDER BY created_at, user_id')
  const linksOf = db.prepare('SELECT provider, subject, user_id, created_at, last_login_at FROM dsh_sso_link WHERE user_id = ? ORDER BY created_at, provider')
  const touchLogin = db.prepare('UPDATE dsh_sso_link SET last_login_at = ? WHERE provider = ? AND subject = ?')
  const readDisabled = db.prepare('SELECT user_id, at, reason FROM dsh_user_disabled WHERE user_id = ?')
  const insertDisabled = db.prepare('INSERT INTO dsh_user_disabled (user_id, at, reason) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING')
  const deleteDisabled = db.prepare('DELETE FROM dsh_user_disabled WHERE user_id = ?')
  const listDisabled = db.prepare('SELECT user_id, at, reason FROM dsh_user_disabled ORDER BY at, user_id')
  // Better Auth's own session table: deleting the rows revokes the sessions on the next lookup, because the cookie cache is off.
  // Prepared on first use: the table is created by Better Auth's migration, after this store.
  let dropSessions: ReturnType<DatabaseSync['prepare']> | undefined
  const disabledRow = (row: Record<string, unknown> | undefined): DisabledAccount | undefined => row === undefined ? undefined : { userId: String(row.user_id), at: Number(row.at), reason: String(row.reason) }
  // Usernames and addresses are personal data; only a keyed hash is stored.
  const failureKey = (key: string) => createHash('sha256').update(`auth-failure\0${key}`).digest('hex')
  const origin = (userId: string) => (readOrigin.get(userId) as { origin: AccountOrigin } | undefined)?.origin
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const store: SsoStore = {
    saveState(state, record, now) {
      dropExpired.run(now)
      insertState.run(hash(state), record.browser, record.nonce, record.verifier, record.returnTo, now + STATE_TTL_MS)
    },
    takeState(state, browser, now) {
      const row = takeState.get(hash(state)) as { browser: string; nonce: string; verifier: string; return_to: string; expires_at: number } | undefined
      if (row === undefined || row.browser !== browser || row.expires_at <= now) return undefined
      return { nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to }
    },
    useAssertion(id, expiresAt, now) {
      dropAssertions.run(now)
      return Number(insertAssertion.run(createHash('sha256').update(`saml-assertion\0${id}`).digest('hex'), Math.max(expiresAt, now + 60_000)).changes) === 1
    },
    findSubject: (provider, subject) => (findSubject.get(provider, subject) as { user_id: string } | undefined)?.user_id,
    bindSubject(provider, subject, userId, now) {
      transaction(() => {
        // D3: only accounts created by SSO can carry an enterprise subject; invite and emergency accounts never can.
        if (origin(userId) !== 'sso') throw new SsoBindingError('origin')
        try { insertLink.run(provider, subject, userId, now) } catch { throw new SsoBindingError('conflict') }
      })
    },
    origin,
    setOrigin(userId, next) {
      transaction(() => {
        const current = origin(userId)
        if (current !== undefined && current !== next && (current === 'sso' || next === 'sso')) throw new SsoBindingError('origin')
        writeOrigin.run(userId, next)
      })
    },
    enrollEmergency: (userId, sealedSecret, now) => { enroll.run(userId, sealedSecret, now) },
    emergencySecret: userId => (secret.get(userId) as { secret: string } | undefined)?.secret,
    revokeEmergency: userId => Number(revoke.run(userId).changes) === 1,
    listEmergency: () => (listEmergency.all() as Array<{ user_id: string; enrolled_at: number }>).map(row => ({ userId: row.user_id, enrolledAt: Number(row.enrolled_at) })),
    useTotpStep: (userId, step) => Number(useStep.run(step, userId, step).changes) === 1,
    audit(event, now) {
      insertAudit.run(now, event.event, event.outcome, event.userId ?? null, event.email ?? null, event.ip ?? null, event.detail ?? null)
      store.pruneAudit(now)
    },
    listAudit: since => (listAudit.all(since) as Array<Record<string, string | number | null>>).map(row => ({
      at: Number(row.at), event: row.event as AuditEvent['event'], outcome: row.outcome as AuditEvent['outcome'],
      ...row.user_id === null ? {} : { userId: String(row.user_id) }, ...row.email === null ? {} : { email: String(row.email) },
      ...row.ip === null ? {} : { ip: String(row.ip) }, ...row.detail === null ? {} : { detail: String(row.detail) } })),
    pruneAudit: now => { prune.run(now - AUDIT_RETENTION_MS) },
    reserveAttempt(limits, windowMs, now) {
      // BEGIN IMMEDIATE takes the write lock before counting, so concurrent attempts (other requests or processes) cannot all see the last free slot.
      return transaction(() => {
        const keys = limits.map(limit => ({ key: failureKey(limit.key), max: limit.max }))
        if (keys.some(limit => (countFailures.get(limit.key, now - windowMs) as { n: number }).n >= limit.max)) return undefined
        return keys.map(limit => Number(insertFailure.run(limit.key, now).lastInsertRowid))
      })
    },
    releaseAttempt(ids) { transaction(() => { for (const id of ids) deleteFailure.run(id) }) },
    clearFailures: key => { clearFailures.run(failureKey(key)) },
    failureCount: (key, since) => (countSince.get(failureKey(key), since) as { n: number }).n,
    pruneFailures(now, windowMs) {
      pruneFailures.run(now - windowMs); dropExpired.run(now); dropAssertions.run(now)
    },
    linksOf: userId => (linksOf.all(userId) as Array<Record<string, unknown>>).map(link),
    listLinks: provider => (listLinks.all(provider) as Array<Record<string, unknown>>).map(row => ({ provider: String(row.provider), subject: String(row.subject), userId: String(row.user_id),
      createdAt: Number(row.created_at), lastLoginAt: row.last_login_at === null ? undefined : Number(row.last_login_at) })),
    touchLogin: (provider, subject, now) => { touchLogin.run(now, provider, subject) },
    disabledAt: userId => disabledRow(readDisabled.get(userId) as Record<string, unknown> | undefined),
    disableUser(userId, reason, now, email) {
      return transaction(() => {
        if (Number(insertDisabled.run(userId, now, reason).changes) !== 1) return false
        dropSessions ??= db.prepare('DELETE FROM session WHERE userId = ?')
        dropSessions.run(userId)
        insertAudit.run(now, 'sso-disable', 'ok', userId, email ?? null, null, reason)
        return true
      })
    },
    enableUser(userId, now, email) {
      return transaction(() => {
        if (Number(deleteDisabled.run(userId).changes) !== 1) return false
        insertAudit.run(now, 'sso-enable', 'ok', userId, email ?? null, null, null)
        return true
      })
    },
    listDisabled: () => (listDisabled.all() as Array<Record<string, unknown>>).map(row => disabledRow(row)!),
  }
  return store
}
