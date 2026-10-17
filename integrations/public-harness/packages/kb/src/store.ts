/** `kb.sqlite`: knowledge base metadata, share requests, snapshots, publications, scopes, compile jobs, limits, view state, and the
 * principal projection (users and their effective groups) that identity pushes. Identity never opens this file. */
import { DatabaseSync } from 'node:sqlite'

export type KbKind = 'personal' | 'org'
export interface KbRow {
  readonly id: string; readonly kind: KbKind; readonly ownerUserId: string | null; readonly slug: string; readonly title: string; readonly description: string
  readonly bytes: number; readonly pages: number; readonly sources: number; readonly createdAt: number; readonly updatedAt: number; readonly archivedAt: number | null
}
export type RequestState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired'
export interface ShareRequestRow {
  readonly id: string; readonly kbId: string; readonly commitSha: string; readonly treeSha: string; readonly submittedBy: string; readonly submittedAt: number
  readonly note: string; readonly state: RequestState; readonly requestedScope: ScopeEntry[]; readonly decidedBy: string | null; readonly decidedAt: number | null; readonly reason: string | null
}
export interface SnapshotRow {
  readonly id: string; readonly kbId: string; readonly commitSha: string; readonly treeSha: string; readonly requestId: string | null
  readonly bytes: number; readonly files: number; readonly includesRaw: boolean; readonly createdAt: number; readonly createdBy: string
}
export interface PublicationRow { readonly kbId: string; readonly snapshotId: string; readonly state: 'active' | 'revoked'; readonly publishedBy: string; readonly publishedAt: number; readonly revokedBy: string | null; readonly revokedAt: number | null }
export interface ScopeEntry { readonly kind: 'company' | 'group' | 'user'; readonly target: string }
export type JobOp = 'ingest' | 'lint' | 'rebuild'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'over-limit' | 'cancelled'
export interface JobRow {
  readonly id: string; readonly kbId: string; readonly op: JobOp; readonly requestedBy: string; readonly chargedTo: string; readonly baseCommit: string; readonly resultCommit: string | null
  readonly state: JobState; readonly inputTokens: number; readonly outputTokens: number; readonly queuedAt: number; readonly startedAt: number | null; readonly finishedAt: number | null
  readonly error: string | null; readonly report: JobReport | null
}
/** What a finished job reports to the UI. */
export interface JobReport { readonly changed: string[]; readonly lint: string[]; readonly log: string[]; readonly branch?: string; readonly limit?: { name: LimitName; value: number; allowed: number } }
export type LimitName = 'max_kbs' | 'max_bytes' | 'max_pages'
export const LIMIT_NAMES: readonly LimitName[] = ['max_kbs', 'max_bytes', 'max_pages']
export interface LimitRow { readonly scopeType: 'global' | 'group' | 'user'; readonly scopeId: string; readonly name: LimitName; readonly value: number | null; readonly updatedBy: string; readonly updatedAt: number }
export interface PrincipalRow { readonly userId: string; readonly groups: string[]; readonly disabled: boolean; readonly email: string | null; readonly updatedAt: number }
export const DEFAULT_LIMITS: Record<LimitName, number> = { max_kbs: 10, max_bytes: 209_715_200, max_pages: 2000 }

/** Open (and migrate) the store. */
export function openKbStore(file: string) {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS kb (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('personal', 'org')), owner_user_id TEXT,
      slug TEXT NOT NULL CHECK (slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 1 AND 48),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, sources INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
      CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS kb_owner_slug ON kb (coalesce(owner_user_id, ''), slug);
    CREATE TABLE IF NOT EXISTS kb_share_request (
      id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES kb(id), commit_sha TEXT NOT NULL, tree_sha TEXT NOT NULL,
      submitted_by TEXT NOT NULL, submitted_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
      requested_scope TEXT NOT NULL DEFAULT '[]', decided_by TEXT, decided_at INTEGER, reason TEXT) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS kb_one_pending ON kb_share_request (kb_id) WHERE state = 'pending';
    CREATE TABLE IF NOT EXISTS kb_snapshot (
      id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES kb(id), commit_sha TEXT NOT NULL, tree_sha TEXT NOT NULL, request_id TEXT REFERENCES kb_share_request(id),
      bytes INTEGER NOT NULL, files INTEGER NOT NULL, includes_raw INTEGER NOT NULL CHECK (includes_raw IN (0, 1)), created_at INTEGER NOT NULL, created_by TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS kb_publication (
      kb_id TEXT PRIMARY KEY REFERENCES kb(id), snapshot_id TEXT NOT NULL REFERENCES kb_snapshot(id),
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked')), published_by TEXT NOT NULL, published_at INTEGER NOT NULL, revoked_by TEXT, revoked_at INTEGER) STRICT;
    CREATE TABLE IF NOT EXISTS kb_scope (
      kb_id TEXT NOT NULL REFERENCES kb(id), kind TEXT NOT NULL CHECK (kind IN ('company', 'group', 'user')), target TEXT NOT NULL,
      PRIMARY KEY (kb_id, kind, target)) STRICT;
    CREATE TABLE IF NOT EXISTS kb_compile_job (
      id TEXT PRIMARY KEY, kb_id TEXT NOT NULL REFERENCES kb(id), op TEXT NOT NULL CHECK (op IN ('ingest', 'lint', 'rebuild')),
      requested_by TEXT NOT NULL, charged_to TEXT NOT NULL, base_commit TEXT NOT NULL, result_commit TEXT,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'conflict', 'over-limit', 'cancelled')),
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT, report TEXT) STRICT;
    CREATE INDEX IF NOT EXISTS kb_job_kb ON kb_compile_job (kb_id, queued_at);
    CREATE TABLE IF NOT EXISTS dsh_kb_limit (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group', 'user')), scope_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (name IN ('max_kbs', 'max_bytes', 'max_pages')), value INTEGER CHECK (value IS NULL OR value > 0),
      updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (scope_type, scope_id, name),
      CHECK ((scope_type = 'global') = (scope_id = '*'))) STRICT;
    CREATE TABLE IF NOT EXISTS kb_view_state (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, digest TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS kb_audit_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL, user_id TEXT, actor TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS kb_principal (user_id TEXT PRIMARY KEY, groups TEXT NOT NULL DEFAULT '[]', disabled INTEGER NOT NULL DEFAULT 0, email TEXT, updated_at INTEGER NOT NULL) STRICT;`)
  const seed = db.prepare("INSERT OR IGNORE INTO dsh_kb_limit (scope_type, scope_id, name, value, updated_by, updated_at) VALUES ('global', '*', ?, ?, 'seed', ?)")
  for (const name of LIMIT_NAMES) seed.run(name, DEFAULT_LIMITS[name], Date.now())

  const kbView = (r: Record<string, unknown>): KbRow => ({ id: String(r.id), kind: r.kind as KbKind, ownerUserId: r.owner_user_id === null ? null : String(r.owner_user_id), slug: String(r.slug),
    title: String(r.title), description: String(r.description), bytes: Number(r.bytes), pages: Number(r.pages), sources: Number(r.sources), createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at), archivedAt: r.archived_at === null ? null : Number(r.archived_at) })
  const reqView = (r: Record<string, unknown>): ShareRequestRow => ({ id: String(r.id), kbId: String(r.kb_id), commitSha: String(r.commit_sha), treeSha: String(r.tree_sha),
    submittedBy: String(r.submitted_by), submittedAt: Number(r.submitted_at), note: String(r.note), state: r.state as RequestState, requestedScope: JSON.parse(String(r.requested_scope)) as ScopeEntry[],
    decidedBy: r.decided_by === null ? null : String(r.decided_by), decidedAt: r.decided_at === null ? null : Number(r.decided_at), reason: r.reason === null ? null : String(r.reason) })
  const snapView = (r: Record<string, unknown>): SnapshotRow => ({ id: String(r.id), kbId: String(r.kb_id), commitSha: String(r.commit_sha), treeSha: String(r.tree_sha),
    requestId: r.request_id === null ? null : String(r.request_id), bytes: Number(r.bytes), files: Number(r.files), includesRaw: Number(r.includes_raw) === 1, createdAt: Number(r.created_at), createdBy: String(r.created_by) })
  const pubView = (r: Record<string, unknown>): PublicationRow => ({ kbId: String(r.kb_id), snapshotId: String(r.snapshot_id), state: r.state as 'active' | 'revoked', publishedBy: String(r.published_by),
    publishedAt: Number(r.published_at), revokedBy: r.revoked_by === null ? null : String(r.revoked_by), revokedAt: r.revoked_at === null ? null : Number(r.revoked_at) })
  const jobView = (r: Record<string, unknown>): JobRow => ({ id: String(r.id), kbId: String(r.kb_id), op: r.op as JobOp, requestedBy: String(r.requested_by), chargedTo: String(r.charged_to),
    baseCommit: String(r.base_commit), resultCommit: r.result_commit === null ? null : String(r.result_commit), state: r.state as JobState, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
    queuedAt: Number(r.queued_at), startedAt: r.started_at === null ? null : Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    error: r.error === null ? null : String(r.error), report: r.report === null ? null : JSON.parse(String(r.report)) as JobReport })
  const limitView = (r: Record<string, unknown>): LimitRow => ({ scopeType: r.scope_type as LimitRow['scopeType'], scopeId: String(r.scope_id), name: r.name as LimitName,
    value: r.value === null ? null : Number(r.value), updatedBy: String(r.updated_by), updatedAt: Number(r.updated_at) })
  const all = <T>(sql: string, map: (r: Record<string, unknown>) => T) => { const stmt = db.prepare(sql); return (...args: Array<string | number | null>) => (stmt.all(...args) as Array<Record<string, unknown>>).map(map) }
  const one = <T>(sql: string, map: (r: Record<string, unknown>) => T) => { const stmt = db.prepare(sql); return (...args: Array<string | number | null>) => { const r = stmt.get(...args) as Record<string, unknown> | undefined; return r === undefined ? undefined : map(r) } }
  const exec = (sql: string) => { const stmt = db.prepare(sql); return (...args: Array<string | number | null>) => Number(stmt.run(...args).changes) }
  const tx = <T>(work: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const out = work(); db.exec('COMMIT'); return out } catch (error) { db.exec('ROLLBACK'); throw error } }

  const insertKb = exec('INSERT INTO kb (id, kind, owner_user_id, slug, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const setScopeDelete = exec('DELETE FROM kb_scope WHERE kb_id = ?'), setScopeInsert = exec('INSERT OR IGNORE INTO kb_scope (kb_id, kind, target) VALUES (?, ?, ?)')
  const withdrawPending = exec("UPDATE kb_share_request SET state = 'withdrawn', decided_by = ?, decided_at = ? WHERE kb_id = ? AND state = 'pending'")
  const insertRequest = exec('INSERT INTO kb_share_request (id, kb_id, commit_sha, tree_sha, submitted_by, submitted_at, note, state, requested_scope) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', ?)')
  const upsertPublication = exec(`INSERT INTO kb_publication (kb_id, snapshot_id, state, published_by, published_at) VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(kb_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, state = 'active', published_by = excluded.published_by, published_at = excluded.published_at, revoked_by = NULL, revoked_at = NULL`)
  const upsertPrincipal = exec(`INSERT INTO kb_principal (user_id, groups, disabled, email, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET groups = excluded.groups, disabled = excluded.disabled, email = coalesce(excluded.email, email), updated_at = excluded.updated_at`)
  const principalView = (r: Record<string, unknown>): PrincipalRow => ({ userId: String(r.user_id), groups: JSON.parse(String(r.groups)) as string[], disabled: Number(r.disabled) === 1,
    email: r.email === null ? null : String(r.email), updatedAt: Number(r.updated_at) })

  return {
    db, tx, close: () => db.close(),
    kb: {
      insert: (row: { id: string; kind: KbKind; ownerUserId: string | null; slug: string; title: string; description: string }, now: number) =>
        insertKb(row.id, row.kind, row.ownerUserId, row.slug, row.title, row.description, now, now),
      get: one('SELECT * FROM kb WHERE id = ?', kbView),
      byOwner: all('SELECT * FROM kb WHERE owner_user_id = ? ORDER BY created_at', kbView),
      all: all('SELECT * FROM kb ORDER BY kind, created_at', kbView),
      slugTaken: (owner: string | null, slug: string) => db.prepare("SELECT 1 FROM kb WHERE coalesce(owner_user_id, '') = ? AND slug = ?").get(owner ?? '', slug) !== undefined,
      activeCount: (owner: string) => Number((db.prepare("SELECT count(*) AS n FROM kb WHERE owner_user_id = ? AND kind = 'personal' AND archived_at IS NULL").get(owner) as { n: number }).n),
      setStats: exec('UPDATE kb SET bytes = ?, pages = ?, sources = ?, updated_at = ? WHERE id = ?'),
      touch: exec('UPDATE kb SET updated_at = ? WHERE id = ?'),
      archive: exec('UPDATE kb SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL'),
    },
    requests: {
      /** Insert a pending request, withdrawing any pending one of the same KB first (one pending per KB). Returns the withdrawn count. */
      submit: (row: { id: string; kbId: string; commitSha: string; treeSha: string; submittedBy: string; note: string; requestedScope: ScopeEntry[] }, now: number) => tx(() => {
        const withdrawn = withdrawPending(row.submittedBy, now, row.kbId)
        insertRequest(row.id, row.kbId, row.commitSha, row.treeSha, row.submittedBy, now, row.note, JSON.stringify(row.requestedScope))
        return withdrawn
      }),
      get: one('SELECT * FROM kb_share_request WHERE id = ?', reqView),
      pendingOf: one("SELECT * FROM kb_share_request WHERE kb_id = ? AND state = 'pending'", reqView),
      byKb: all('SELECT * FROM kb_share_request WHERE kb_id = ? ORDER BY submitted_at DESC', reqView),
      list: all("SELECT * FROM kb_share_request WHERE (? = '' OR state = ?) ORDER BY submitted_at DESC LIMIT 500", reqView),
      decide: exec("UPDATE kb_share_request SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND state = 'pending'"),
      expire: exec("UPDATE kb_share_request SET state = 'expired', decided_by = 'system', decided_at = ? WHERE state = 'pending' AND submitted_at <= ?"),
      /** Requests whose submission files may be deleted (decided and older than the retention, or approved). */
      purgeable: all("SELECT * FROM kb_share_request WHERE state IN ('rejected', 'withdrawn', 'expired') AND decided_at <= ?", reqView),
    },
    snapshots: {
      insert: exec('INSERT INTO kb_snapshot (id, kb_id, commit_sha, tree_sha, request_id, bytes, files, includes_raw, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      get: one('SELECT * FROM kb_snapshot WHERE id = ?', snapView),
      byKb: all('SELECT * FROM kb_snapshot WHERE kb_id = ? ORDER BY created_at DESC', snapView),
    },
    publications: {
      get: one('SELECT * FROM kb_publication WHERE kb_id = ?', pubView),
      publish: (kbId: string, snapshotId: string, by: string, now: number) => upsertPublication(kbId, snapshotId, by, now),
      revoke: exec("UPDATE kb_publication SET state = 'revoked', revoked_by = ?, revoked_at = ? WHERE kb_id = ? AND state = 'active'"),
      active: all("SELECT * FROM kb_publication WHERE state = 'active'", pubView),
      move: exec('UPDATE kb_publication SET kb_id = ? WHERE kb_id = ?'),
    },
    scopes: {
      get: all('SELECT kind, target FROM kb_scope WHERE kb_id = ? ORDER BY kind, target', r => ({ kind: r.kind as ScopeEntry['kind'], target: String(r.target) })),
      set: (kbId: string, scopes: readonly ScopeEntry[]) => tx(() => { setScopeDelete(kbId); for (const s of scopes) setScopeInsert(kbId, s.kind, s.target) }),
      clear: setScopeDelete,
    },
    jobs: {
      insert: (row: { id: string; kbId: string; op: JobOp; requestedBy: string; chargedTo: string; baseCommit: string }, now: number) =>
        exec("INSERT INTO kb_compile_job (id, kb_id, op, requested_by, charged_to, base_commit, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")(row.id, row.kbId, row.op, row.requestedBy, row.chargedTo, row.baseCommit, now),
      get: one('SELECT * FROM kb_compile_job WHERE id = ?', jobView),
      byKb: all('SELECT * FROM kb_compile_job WHERE kb_id = ? ORDER BY queued_at DESC LIMIT 50', jobView),
      active: one("SELECT * FROM kb_compile_job WHERE kb_id = ? AND state IN ('queued', 'running') ORDER BY queued_at LIMIT 1", jobView),
      queued: all("SELECT * FROM kb_compile_job WHERE state = 'queued' ORDER BY queued_at", jobView),
      running: all("SELECT * FROM kb_compile_job WHERE state = 'running'", jobView),
      start: exec("UPDATE kb_compile_job SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'"),
      finish: (id: string, state: JobState, fields: { resultCommit?: string | null; inputTokens?: number; outputTokens?: number; error?: string | null; report?: JobReport | null }, now: number) =>
        exec('UPDATE kb_compile_job SET state = ?, result_commit = ?, input_tokens = ?, output_tokens = ?, error = ?, report = ?, finished_at = ? WHERE id = ?')(
          state, fields.resultCommit ?? null, fields.inputTokens ?? 0, fields.outputTokens ?? 0, fields.error ?? null, fields.report === undefined || fields.report === null ? null : JSON.stringify(fields.report), now, id),
      recentByUser: (userId: string, since: number) => Number((db.prepare('SELECT count(*) AS n FROM kb_compile_job WHERE requested_by = ? AND queued_at > ?').get(userId, since) as { n: number }).n),
    },
    limits: {
      list: all('SELECT * FROM dsh_kb_limit ORDER BY scope_type, scope_id, name', limitView),
      get: one('SELECT * FROM dsh_kb_limit WHERE scope_type = ? AND scope_id = ? AND name = ?', limitView),
      set: exec(`INSERT INTO dsh_kb_limit (scope_type, scope_id, name, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
      delete: exec("DELETE FROM dsh_kb_limit WHERE scope_type = ? AND scope_id = ? AND name = ? AND scope_type != 'global'"),
    },
    principals: {
      upsert: (row: { userId: string; groups: readonly string[]; disabled: boolean; email?: string | null }, now: number) => upsertPrincipal(row.userId, JSON.stringify([...row.groups].sort()), row.disabled ? 1 : 0, row.email ?? null, now),
      get: one('SELECT * FROM kb_principal WHERE user_id = ?', principalView),
      all: all('SELECT * FROM kb_principal ORDER BY user_id', principalView),
    },
    audit: {
      add: exec('INSERT INTO kb_audit_outbox (at, event, outcome, user_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?)'),
      pending: all('SELECT * FROM kb_audit_outbox ORDER BY id LIMIT 500', r => ({ id: Number(r.id), at: Number(r.at), event: String(r.event), outcome: String(r.outcome),
        userId: r.user_id === null ? null : String(r.user_id), actor: String(r.actor), detail: String(r.detail) })),
      ack: exec('DELETE FROM kb_audit_outbox WHERE id <= ?'),
    },
    views: {
      get: one('SELECT generation, digest, applied_at FROM kb_view_state WHERE user_id = ?', r => ({ generation: Number(r.generation), digest: String(r.digest), appliedAt: Number(r.applied_at) })),
      set: exec(`INSERT INTO kb_view_state (user_id, generation, digest, applied_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET generation = excluded.generation, digest = excluded.digest, applied_at = excluded.applied_at`),
    },
  }
}
export type KbStore = ReturnType<typeof openKbStore>
