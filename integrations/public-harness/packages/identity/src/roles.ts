/** Administrator role: the server alone decides it. Sources, strongest first: `DSH_ADMIN_EMAILS` (configuration, never changed from the UI),
 * emergency accounts, and grants an administrator made in the admin console (stored in `dsh_role_grant`). */
import type { IdentityConfig } from './config.ts'
import type { IdentityDatabase } from './database.ts'

/** Roles the identity service assigns. */
export type AccountRole = 'admin' | 'member'
/** Why an account is an administrator. */
export type AdminSource = 'config' | 'emergency' | 'grant'

/** Role lookups and grants over the identity database. */
export interface Roles {
  source(userId: string, email: string): AdminSource | undefined
  role(userId: string, email: string): AccountRole
  /** Grant (true) or remove (false) a console grant; false when nothing changed. */
  setGrant(userId: string, admin: boolean, by: string, now: number): boolean
  /** Administrators whose accounts are not disabled. */
  activeAdmins(): string[]
}

/** Open the role table (created on first use) and build the lookups.
 * @param config Identity settings (for `DSH_ADMIN_EMAILS`).
 * @param database Identity database.
 * @returns Role lookups.
 */
export function createRoles(config: IdentityConfig, database: IdentityDatabase): Roles {
  const db = database.db
  db.exec('CREATE TABLE IF NOT EXISTS dsh_role_grant (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role = \'admin\'), granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL)')
  const admins = new Set(config.admins ?? [])
  const grant = db.prepare('INSERT INTO dsh_role_grant (user_id, role, granted_at, granted_by) VALUES (?, \'admin\', ?, ?) ON CONFLICT(user_id) DO NOTHING')
  const revoke = db.prepare('DELETE FROM dsh_role_grant WHERE user_id = ?')
  const granted = db.prepare('SELECT 1 FROM dsh_role_grant WHERE user_id = ?')
  const everyone = db.prepare('SELECT id, email FROM user')
  const source = (userId: string, email: string): AdminSource | undefined => {
    if (admins.has(email.toLowerCase())) return 'config'
    if (database.sso.origin(userId) === 'emergency') return 'emergency'
    return granted.get(userId) === undefined ? undefined : 'grant'
  }
  return {
    source,
    role: (userId, email) => source(userId, email) === undefined ? 'member' : 'admin',
    setGrant: (userId, admin, by, now) => Number((admin ? grant.run(userId, now, by) : revoke.run(userId)).changes) === 1,
    activeAdmins: () => (everyone.all() as Array<{ id: string; email: string }>)
      .filter(user => source(user.id, user.email) !== undefined && database.sso.disabledAt(user.id) === undefined).map(user => user.id),
  }
}
