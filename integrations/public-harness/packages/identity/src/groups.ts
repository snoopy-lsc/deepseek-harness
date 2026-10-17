/** Persisted directory groups and departments, plus administrator-managed local groups.
 *
 * SSO sign-in and directory reconciliation replace one user's rows for their source; local groups are only changed by administrators.
 * Group IDs carry their source (`oidc:`, `saml:`, `ldap:`, `wecom:`, `dingtalk:`, `local:`) so values from different sources never collide.
 * `display_name` is presentation only and never used for authorization. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Where a group comes from. */
export type GroupSource = 'oidc' | 'saml' | 'ldap' | 'wecom' | 'dingtalk' | 'local'
export const GROUP_SOURCES: readonly GroupSource[] = ['oidc', 'saml', 'ldap', 'wecom', 'dingtalk', 'local']
/** How a membership row was written. */
export type MembershipVia = 'login' | 'reconcile' | 'local'

/** One group as administrators see it. */
export interface GroupRecord {
  readonly id: string
  readonly source: GroupSource
  readonly externalId: string
  readonly displayName: string | null
  readonly parentId: string | null
  readonly members: number
  readonly updatedAt: number
}

/** Group persistence. */
export interface GroupStore {
  /** Replace the user's memberships from one directory source (login or reconciliation); local memberships are untouched.
   * @returns true when the set changed. */
  syncUser(userId: string, source: Exclude<GroupSource, 'local'>, externalIds: readonly string[], via: Exclude<MembershipVia, 'local'>, now: number): boolean
  /** Every group with its member count, ordered by source then name. */
  list(): GroupRecord[]
  get(id: string): GroupRecord | undefined
  /** Direct memberships of one user. */
  groupsOf(userId: string): string[]
  /** Direct memberships plus every ancestor department (parent chain). */
  effectiveGroupsOf(userId: string): string[]
  /** Members of a group, optionally including members of descendant groups. */
  membersOf(groupId: string, descendants?: boolean): string[]
  /** All users with at least one membership. */
  usersWithGroups(): string[]
  createLocal(displayName: string, now: number): GroupRecord
  /** Rename a local group or set the alias of a synced one. */
  setDisplayName(id: string, displayName: string | null, now: number): boolean
  deleteLocal(id: string): boolean
  addLocalMember(groupId: string, userId: string, now: number): boolean
  removeLocalMember(groupId: string, userId: string): boolean
  /** Called with the affected user IDs after any membership or group change (for the KB service's projection). */
  subscribe(listener: (userIds: readonly string[]) => void): () => void
}

/** Validate one external group value before it becomes part of an ID. */
export function validExternalId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)
}

/** Open the group tables (created on first use).
 * @param db Identity database.
 * @returns Store.
 */
export function createGroupStore(db: DatabaseSync): GroupStore {
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_group (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('oidc', 'saml', 'ldap', 'wecom', 'dingtalk', 'local')),
      external_id TEXT NOT NULL,
      display_name TEXT,
      parent_id TEXT REFERENCES dsh_group(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (source, external_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dsh_user_group (
      user_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES dsh_group(id),
      via TEXT NOT NULL CHECK (via IN ('login', 'reconcile', 'local')),
      refreshed_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, group_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS dsh_user_group_group ON dsh_user_group (group_id);`)
  const upsertGroup = db.prepare(`INSERT INTO dsh_group (id, source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
  const sourceRows = db.prepare('SELECT g.id FROM dsh_user_group m JOIN dsh_group g ON g.id = m.group_id WHERE m.user_id = ? AND g.source = ?')
  const deleteMembership = db.prepare('DELETE FROM dsh_user_group WHERE user_id = ? AND group_id = ?')
  const insertMembership = db.prepare(`INSERT INTO dsh_user_group (user_id, group_id, via, refreshed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, group_id) DO UPDATE SET via = excluded.via, refreshed_at = excluded.refreshed_at`)
  const listAll = db.prepare(`SELECT g.id, g.source, g.external_id, g.display_name, g.parent_id, g.updated_at, count(m.user_id) AS members
    FROM dsh_group g LEFT JOIN dsh_user_group m ON m.group_id = g.id GROUP BY g.id ORDER BY g.source, coalesce(g.display_name, g.external_id)`)
  const one = db.prepare(`SELECT g.id, g.source, g.external_id, g.display_name, g.parent_id, g.updated_at, (SELECT count(*) FROM dsh_user_group m WHERE m.group_id = g.id) AS members
    FROM dsh_group g WHERE g.id = ?`)
  const of = db.prepare('SELECT group_id FROM dsh_user_group WHERE user_id = ? ORDER BY group_id')
  const parents = db.prepare('SELECT id, parent_id FROM dsh_group WHERE parent_id IS NOT NULL')
  const members = db.prepare('SELECT user_id FROM dsh_user_group WHERE group_id = ? ORDER BY user_id')
  const users = db.prepare('SELECT DISTINCT user_id FROM dsh_user_group ORDER BY user_id')
  const rename = db.prepare('UPDATE dsh_group SET display_name = ?, updated_at = ? WHERE id = ?')
  const dropMembers = db.prepare('DELETE FROM dsh_user_group WHERE group_id = ?')
  const dropGroup = db.prepare("DELETE FROM dsh_group WHERE id = ? AND source = 'local'")
  const unparent = db.prepare('UPDATE dsh_group SET parent_id = NULL WHERE parent_id = ?')
  const view = (row: Record<string, unknown>): GroupRecord => ({ id: String(row.id), source: row.source as GroupSource, externalId: String(row.external_id),
    displayName: row.display_name === null ? null : String(row.display_name), parentId: row.parent_id === null ? null : String(row.parent_id),
    members: Number(row.members), updatedAt: Number(row.updated_at) })
  const tx = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const out = work(); db.exec('COMMIT'); return out } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const listeners = new Set<(userIds: readonly string[]) => void>()
  const notify = (userIds: readonly string[]) => { if (userIds.length) for (const fn of listeners) { try { fn(userIds) } catch { /* a listener never breaks sign-in */ } } }
  const parentMap = () => new Map((parents.all() as Array<{ id: string; parent_id: string }>).map(row => [row.id, row.parent_id]))
  const store: GroupStore = {
    syncUser(userId, source, externalIds, via, now) {
      const wanted = new Set(externalIds.filter(validExternalId).map(value => `${source}:${value}`))
      const changed = tx(() => {
        const current = new Set((sourceRows.all(userId, source) as Array<{ id: string }>).map(row => row.id))
        let changed = false
        for (const id of current) if (!wanted.has(id)) { deleteMembership.run(userId, id); changed = true }
        for (const id of wanted) {
          upsertGroup.run(id, source, id.slice(source.length + 1), now, now)
          if (!current.has(id)) changed = true
          insertMembership.run(userId, id, via, now)
        }
        return changed
      })
      if (changed) notify([userId])
      return changed
    },
    list: () => (listAll.all() as Array<Record<string, unknown>>).map(view),
    get(id) { const row = one.get(id) as Record<string, unknown> | undefined; return row === undefined ? undefined : view(row) },
    groupsOf: userId => (of.all(userId) as Array<{ group_id: string }>).map(row => row.group_id),
    effectiveGroupsOf(userId) {
      const map = parentMap(), out = new Set<string>()
      for (const id of store.groupsOf(userId)) {
        let cursor: string | undefined = id
        // The parent chain is bounded by the number of groups, so a corrupted cycle cannot loop forever.
        for (let hops = 0; cursor !== undefined && !out.has(cursor) && hops <= map.size + 1; hops++) { out.add(cursor); cursor = map.get(cursor) }
      }
      return [...out].sort()
    },
    membersOf(groupId, descendants = false) {
      const ids = new Set([groupId])
      if (descendants) {
        const map = parentMap()
        let grew = true
        while (grew) { grew = false; for (const [child, parent] of map) if (ids.has(parent) && !ids.has(child)) { ids.add(child); grew = true } }
      }
      const out = new Set<string>()
      for (const id of ids) for (const row of members.all(id) as Array<{ user_id: string }>) out.add(row.user_id)
      return [...out].sort()
    },
    usersWithGroups: () => (users.all() as Array<{ user_id: string }>).map(row => row.user_id),
    createLocal(displayName, now) {
      const id = `local:${randomUUID()}`
      tx(() => { upsertGroup.run(id, 'local', id.slice(6), now, now); rename.run(displayName, now, id) })
      return store.get(id)!
    },
    setDisplayName: (id, displayName, now) => Number(rename.run(displayName, now, id).changes) > 0,
    deleteLocal(id) {
      if (store.get(id)?.source !== 'local') return false
      const affected = store.membersOf(id)
      const done = tx(() => { dropMembers.run(id); unparent.run(id); return Number(dropGroup.run(id).changes) > 0 })
      if (done) notify(affected)
      return done
    },
    addLocalMember(groupId, userId, now) {
      if (store.get(groupId)?.source !== 'local') return false
      insertMembership.run(userId, groupId, 'local', now); notify([userId]); return true
    },
    removeLocalMember(groupId, userId) {
      if (store.get(groupId)?.source !== 'local') return false
      const done = Number(deleteMembership.run(userId, groupId).changes) > 0
      if (done) notify([userId])
      return done
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return store
}
