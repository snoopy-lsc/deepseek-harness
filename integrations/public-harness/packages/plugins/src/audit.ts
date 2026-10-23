/** `plugin_audit_outbox` writers (drained like `kb_audit_outbox`). Detail never holds bytes or tokens. */

import type { PluginsDbHandle } from './migrate.ts'

export interface PluginAuditWrite {
  readonly at: number
  readonly event: string
  readonly outcome: string
  readonly userId?: string | null
  readonly actor: string
  /** JSON-serialisable object; stringified for storage. Never put artifact bytes or tokens here. */
  readonly detail: unknown
}

export interface PluginAuditRow {
  readonly id: number
  readonly at: number
  readonly event: string
  readonly outcome: string
  readonly userId: string | null
  readonly actor: string
  readonly detail: string
}

/** Append one outbox row; returns the new `id`. */
export function writeAuditOutbox(store: PluginsDbHandle, entry: PluginAuditWrite): number {
  const detail = typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)
  store.db.prepare(
    `INSERT INTO plugin_audit_outbox (at, event, outcome, user_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entry.at, entry.event, entry.outcome, entry.userId ?? null, entry.actor, detail)
  const row = store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }
  return Number(row.id)
}

/** Pending outbox rows, oldest first (drain order). */
export function listPendingAudit(store: PluginsDbHandle, limit = 500): PluginAuditRow[] {
  const rows = store.db.prepare(
    `SELECT id, at, event, outcome, user_id, actor, detail FROM plugin_audit_outbox ORDER BY id LIMIT ?`,
  ).all(limit) as Array<{
    id: number | bigint
    at: number | bigint
    event: string
    outcome: string
    user_id: string | null
    actor: string
    detail: string
  }>
  return rows.map(r => ({
    id: Number(r.id),
    at: Number(r.at),
    event: r.event,
    outcome: r.outcome,
    userId: r.user_id,
    actor: r.actor,
    detail: r.detail,
  }))
}

/** Acknowledge drained rows up to and including `upToId`. */
export function ackAuditOutbox(store: PluginsDbHandle, upToId: number): number {
  const result = store.db.prepare('DELETE FROM plugin_audit_outbox WHERE id <= ?').run(upToId)
  return Number(result.changes ?? 0)
}
