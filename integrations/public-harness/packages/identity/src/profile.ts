/** Private profile extensions and avatar bytes; Better Auth remains the owner of names and email addresses. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { IdentityDatabase } from './database.ts'
import { MeError } from './me-error.ts'

/** Complete profile read by personal settings and the administrator user editor. */
export interface AccountProfile {
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly employeeId: string
  readonly department: string
  readonly jobTitle: string
  readonly avatarUrl: string | null
  readonly managedBy: 'local' | 'sso'
}
/** Editable profile text; omitted fields preserve their stored values. */
export interface ProfilePatch { name?: string; phone?: string; employeeId?: string; department?: string; jobTitle?: string }
/** Validated, private image bytes. */
export interface ProfileAvatar { readonly mime: 'image/png' | 'image/jpeg' | 'image/webp'; readonly data: Buffer }
/** Profile writes and their audit row commit together; failures roll back both. */
export interface Profiles {
  /** Read current names, email and extension fields; missing accounts throw 404.
   * @param userId Existing account.
   * @returns Complete profile with a private avatar URL when stored.
   */
  read(userId: string): AccountProfile
  /** Commit validated text and its audit together; SSO names throw 403 without edits.
   * @param userId Existing account.
   * @param patch Validated fields; omitted fields stay unchanged.
   * @param audit Audit insert participating in the same transaction.
   * @returns Complete committed profile.
   */
  update(userId: string, patch: ProfilePatch, audit: () => void): AccountProfile
  /** Read private bytes after the caller authorizes access.
   * @param userId Authorized account.
   * @returns Stored avatar, or undefined when absent.
   */
  avatar(userId: string): ProfileAvatar | undefined
  /** Commit validated image bytes or removal with its audit; failures leave both unchanged.
   * @param userId Existing account.
   * @param avatar Validated image, or null for removal.
   * @param audit Audit insert participating in the same transaction.
   * @returns Complete committed profile.
   */
  setAvatar(userId: string, avatar: ProfileAvatar | null, audit: () => void): AccountProfile
}
const SCHEMA_VERSION = 1
const MAX_AVATAR = 512 * 1024
/** Maximum JSON bytes for a base64 image and its envelope. */
export const AVATAR_BODY_LIMIT = Math.ceil(MAX_AVATAR / 3) * 4 + 1024
const LENGTHS = { name: 100, phone: 40, employeeId: 64, department: 100, jobTitle: 100 } as const

/** Validate allowed profile fields; organization fields require the administrator route.
 * @param body Parsed request object.
 * @param admin Whether the request comes from an administrator.
 * @returns Trimmed edits with omitted fields preserved.
 */
export function profilePatch(body: Record<string, unknown>, admin: boolean): ProfilePatch {
  const allowed: readonly string[] = admin ? ['userId', ...Object.keys(LENGTHS)] : ['name', 'phone']
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new MeError(400, 'body')
  const patch: ProfilePatch = {}
  for (const field of Object.keys(LENGTHS) as Array<keyof typeof LENGTHS>) {
    if (!Object.hasOwn(body, field)) continue
    const value = body[field]
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new MeError(400, 'body')
    const trimmed = value.trim()
    if (trimmed.length > LENGTHS[field] || field === 'name' && trimmed.length === 0) throw new MeError(400, 'body')
    patch[field] = trimmed
  }
  return patch
}

/** Validate canonical base64, decoded size, declared media type and image signature; null removes the image.
 * @param body Parsed avatar request.
 * @returns Private image bytes or removal.
 */
export function profileAvatar(body: Record<string, unknown>): ProfileAvatar | null {
  if (body.data === null && Object.keys(body).length === 1) return null
  if (Object.keys(body).some(key => key !== 'mime' && key !== 'data')) throw new MeError(400, 'body')
  const { mime, data } = body
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp' || typeof data !== 'string' || data.length === 0) throw new MeError(400, 'avatar')
  if (data.length > Math.ceil(MAX_AVATAR / 3) * 4) throw new MeError(413, 'body-too-large')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new MeError(400, 'avatar')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_AVATAR) throw new MeError(413, 'body-too-large')
  if (bytes.toString('base64') !== data) throw new MeError(400, 'avatar')
  const signature = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!signature) throw new MeError(400, 'avatar')
  return { mime, data: bytes }
}

/** Add the private extension table without changing existing identity tables.
 * @param db Open identity database, before Better Auth migration.
 */
export function migrateProfiles(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS dsh_profile_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
    const version = db.prepare('SELECT version FROM dsh_profile_schema WHERE id = 1').get() as { version: number } | undefined
    if (version !== undefined && version.version > SCHEMA_VERSION) throw new Error('identity profile database uses a newer schema version')
    if ((version?.version ?? 0) < 1) {
      db.exec(`CREATE TABLE IF NOT EXISTS dsh_user_profile (user_id TEXT PRIMARY KEY,
        phone TEXT NOT NULL DEFAULT '', employee_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '',
        avatar_mime TEXT, avatar_data BLOB, avatar_version TEXT)`)
      db.prepare('INSERT INTO dsh_profile_schema (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(SCHEMA_VERSION)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** Read and update profiles after Better Auth has created its user table.
 * @param database Identity database owning profile extensions, origins and audit rows.
 * @returns Synchronous profile storage.
 */
export function createProfiles(database: IdentityDatabase): Profiles {
  const db = database.db
  const user = db.prepare('SELECT name, email FROM user WHERE id = ?')
  const extension = db.prepare('SELECT phone, employee_id, department, job_title, avatar_version FROM dsh_user_profile WHERE user_id = ?')
  const image = db.prepare('SELECT avatar_mime, avatar_data FROM dsh_user_profile WHERE user_id = ?')
  const ensure = db.prepare('INSERT OR IGNORE INTO dsh_user_profile (user_id) VALUES (?)')
  const rename = db.prepare('UPDATE user SET name = ?, updatedAt = ? WHERE id = ?')
  const text = {
    phone: db.prepare('UPDATE dsh_user_profile SET phone = ? WHERE user_id = ?'),
    employeeId: db.prepare('UPDATE dsh_user_profile SET employee_id = ? WHERE user_id = ?'),
    department: db.prepare('UPDATE dsh_user_profile SET department = ? WHERE user_id = ?'),
    jobTitle: db.prepare('UPDATE dsh_user_profile SET job_title = ? WHERE user_id = ?'),
  }
  const putImage = db.prepare('UPDATE dsh_user_profile SET avatar_mime = ?, avatar_data = ?, avatar_version = ? WHERE user_id = ?')
  const read = (id: string): AccountProfile => {
    const owner = user.get(id) as { name: string; email: string } | undefined
    if (owner === undefined) throw new MeError(404, 'user-not-found')
    const row = extension.get(id) as { phone: string; employee_id: string; department: string; job_title: string; avatar_version: string | null } | undefined
    return { name: owner.name, email: owner.email, phone: row?.phone ?? '', employeeId: row?.employee_id ?? '', department: row?.department ?? '', jobTitle: row?.job_title ?? '',
      avatarUrl: row?.avatar_version ? `/account/api/me/avatar?userId=${encodeURIComponent(id)}&v=${row.avatar_version}` : null,
      managedBy: database.sso.origin(id) === 'sso' ? 'sso' : 'local' }
  }
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return {
    read,
    update: (id, patch, audit) => transaction(() => {
      const existing = read(id)
      if (existing.managedBy === 'sso' && patch.name !== undefined) throw new MeError(403, 'profile-managed')
      ensure.run(id)
      if (patch.name !== undefined) rename.run(patch.name, Date.now(), id)
      for (const field of Object.keys(text) as Array<keyof typeof text>) if (patch[field] !== undefined) text[field].run(patch[field], id)
      audit()
      return read(id)
    }),
    avatar(id) {
      const row = image.get(id) as { avatar_mime: ProfileAvatar['mime'] | null; avatar_data: Uint8Array | null } | undefined
      return row?.avatar_mime && row.avatar_data ? { mime: row.avatar_mime, data: Buffer.from(row.avatar_data) } : undefined
    },
    setAvatar: (id, avatar, audit) => transaction(() => {
      read(id); ensure.run(id)
      putImage.run(avatar?.mime ?? null, avatar?.data ?? null, avatar === null ? null : createHash('sha256').update(avatar.data).digest('hex'), id)
      audit()
      return read(id)
    }),
  }
}
