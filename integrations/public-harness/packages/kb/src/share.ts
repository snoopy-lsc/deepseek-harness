/** Sharing: the author requests review of a pinned commit, an administrator approves it with a scope (and whether `raw/` is included),
 * rejects it with a reason, changes the scope or revokes it; pending requests expire. Approval writes an immutable snapshot under
 * `published/<kbId>/<snapshotId>/` (files 0444, directories 0555) and rebuilds the views of every user whose visible set changed. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KbError } from './errors.ts'
import { listFiles, readTree, removeTree, writeReadOnlyTree } from './files.ts'
import { ID_PATTERN, newId } from './ids.ts'
import type { KbRoutes } from './server.ts'
import type { Actor, KbCore } from './service.ts'
import type { KbRow, ScopeEntry } from './store.ts'
import { readTar, SOURCE_EXTENSIONS, type TarFile } from './tar.ts'
import { reconcileViews, visibleEntries } from './views.ts'

/** Pending requests expire after this long (default 30 days). */
export const REQUEST_TTL_MS = 30 * 24 * 3_600_000
const EXPORT_LIMITS = { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, extensions: SOURCE_EXTENSIONS }
const GROUP_ID = /^(oidc|saml|ldap|wecom|dingtalk|local):[^\0\r\n]{1,512}$/
const MAX_TEXT = 256 * 1024

/** Validate an admin-chosen scope: the company, groups by source-prefixed ID, or known users. */
export function parseScope(core: KbCore, raw: unknown): ScopeEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) throw new KbError(400, 'scope')
  const out = new Map<string, ScopeEntry>()
  for (const item of raw) {
    const entry = item as Record<string, unknown>
    if (entry.kind === 'company') out.set('company:*', { kind: 'company', target: '*' })
    else if (entry.kind === 'group' && typeof entry.target === 'string' && GROUP_ID.test(entry.target)) out.set(`group:${entry.target}`, { kind: 'group', target: entry.target })
    else if (entry.kind === 'user' && typeof entry.target === 'string' && core.store.principals.get(entry.target) !== undefined) out.set(`user:${entry.target}`, { kind: 'user', target: entry.target })
    else throw new KbError(400, 'scope')
  }
  return [...out.values()]
}
export const scopeDetail = (scope: readonly ScopeEntry[]) => scope.some(s => s.kind === 'company') ? 'scope=company'
  : `scope=groups:${scope.filter(s => s.kind === 'group').length},users:${scope.filter(s => s.kind === 'user').length}`

/** Write a snapshot and make it the KB's active publication. Used by approvals and by org KBs.
 * @returns Snapshot ID.
 */
export async function publishSnapshot(core: KbCore, kb: KbRow, files: readonly TarFile[], meta: { commitSha: string; treeSha: string; requestId: string | null; includesRaw: boolean; by: string }): Promise<string> {
  const { store, root, clock } = core
  const id = newId('snap')
  const kept = files.filter(file => meta.includesRaw || !file.path.startsWith('raw/'))
  await mkdir(join(root, 'published', kb.id), { recursive: true, mode: 0o755 })
  await writeReadOnlyTree(join(root, 'published', kb.id, id), kept)
  store.tx(() => {
    store.snapshots.insert(id, kb.id, meta.commitSha, meta.treeSha, meta.requestId, kept.reduce((n, f) => n + f.data.length, 0), kept.length, meta.includesRaw ? 1 : 0, clock(), meta.by)
    store.publications.publish(kb.id, id, meta.by, clock())
  })
  return id
}

/** Share operations and routes. */
export function shareModule(core: KbCore, options: { requestTtlMs?: number } = {}) {
  const { store, root, clock } = core
  const ttl = options.requestTtlMs ?? REQUEST_TTL_MS
  const submissionDir = (requestId: string) => join(root, 'submissions', requestId)
  const request = (id: unknown) => {
    const row = typeof id === 'string' && ID_PATTERN.req.test(id) ? store.requests.get(id) : undefined
    if (row === undefined) throw new KbError(404, 'request-not-found')
    return row
  }
  const pendingRequest = (id: unknown) => {
    const row = request(id)
    if (row.state !== 'pending') throw new KbError(409, 'not-pending')
    return row
  }
  const published = (id: unknown) => {
    const kb = typeof id === 'string' && ID_PATTERN.kb.test(id) ? store.kb.get(id) : undefined
    if (kb === undefined) throw new KbError(404, 'kb-not-found')
    return kb
  }
  const emailOf = (userId: string | null) => userId === null ? null : store.principals.get(userId)?.email ?? null

  async function submit(actor: Actor, body: Record<string, unknown>) {
    const kb = core.ownKb(actor.userId, body.kb)
    if (kb.archivedAt !== null) throw new KbError(409, 'archived')
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
    const tree = await core.tree(actor.userId)
    // Pin HEAD, committing the work tree first when it is dirty.
    await core.helperJson(tree, 'commit', { kb: kb.id, message: 'Commit before share request' })
    const head = await core.helperJson<{ head: string; tree: string }>(tree, 'head', { kb: kb.id })
    const files = readTar(await core.helper(tree, 'archive', { kb: kb.id, rev: head.head }), EXPORT_LIMITS).files
    const id = newId('req')
    await writeReadOnlyTree(submissionDir(id), files)
    const before = store.requests.pendingOf(kb.id)
    store.requests.submit({ id, kbId: kb.id, commitSha: head.head, treeSha: head.tree, submittedBy: actor.userId, note, requestedScope: [] }, clock())
    if (before !== undefined) await removeTree(submissionDir(before.id))
    core.audit('kb-share-request', actor.email, `kb=${kb.id} req=${id} commit=${head.head.slice(0, 12)} files=${files.length}`, { userId: actor.userId })
    return store.requests.get(id)!
  }
  async function withdraw(actor: Actor, body: Record<string, unknown>) {
    const kb = core.ownKb(actor.userId, body.kb)
    const pending = store.requests.pendingOf(kb.id)
    if (pending === undefined) throw new KbError(409, 'not-pending')
    store.requests.decide('withdrawn', actor.userId, clock(), null, pending.id)
    await removeTree(submissionDir(pending.id))
    core.audit('kb-share-withdraw', actor.email, `kb=${kb.id} req=${pending.id}`, { userId: actor.userId })
    return { withdrawn: pending.id }
  }
  /** Expire old pending requests and delete the submissions of decided ones. */
  async function sweep() {
    const now = clock()
    store.requests.expire(now, now - ttl)
    for (const row of store.requests.purgeable(now)) await removeTree(submissionDir(row.id))
  }
  const requestView = (row: ReturnType<typeof request>) => {
    const kb = store.kb.get(row.kbId)!
    const publication = store.publications.get(kb.id)
    return { ...row, kb: { id: kb.id, title: kb.title, kind: kb.kind, ownerUserId: kb.ownerUserId, ownerEmail: emailOf(kb.ownerUserId) },
      submittedByEmail: emailOf(row.submittedBy), current: publication?.state === 'active' ? { snapshotId: publication.snapshotId, publishedAt: publication.publishedAt, scope: store.scopes.get(kb.id) } : null }
  }

  const routes: KbRoutes = {
    'POST /me/kb/share': async req => ({ request: await submit(req.actor, await req.json()) }),
    'POST /me/kb/share/withdraw': async req => withdraw(req.actor, await req.json()),
    'GET /me/kb/shared': async ({ actor }) => ({
      kbs: visibleEntries(core, actor.userId).map(entry => {
        const kb = store.kb.get(entry.kbId)!
        return { id: kb.id, title: kb.title, kind: kb.kind, owner: emailOf(kb.ownerUserId), publishedAt: store.publications.get(kb.id)!.publishedAt, path: `~/kb/shared/${entry.name}` }
      }),
    }),
    'GET /admin/kb/requests': async ({ query }) => {
      await sweep()
      const state = query.get('state') ?? 'pending'
      if (!['pending', 'approved', 'rejected', 'withdrawn', 'expired', 'all'].includes(state)) throw new KbError(400, 'state')
      const rows = store.requests.list(state === 'all' ? '' : state, state === 'all' ? '' : state)
      return { requests: await Promise.all(rows.map(async row => {
        const files = row.state === 'pending' ? await listFiles(submissionDir(row.id)).catch(() => []) : []
        return { ...requestView(row), files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }
      })) }
    },
    'GET /admin/kb/requests/content': async ({ actor, query }) => {
      const row = pendingRequest(query.get('id'))
      const dir = submissionDir(row.id)
      const current = store.publications.get(row.kbId)
      const previousDir = current?.state === 'active' ? join(root, 'published', row.kbId, current.snapshotId) : undefined
      const path = query.get('path')
      if (path !== null) {
        const files = await listFiles(dir)
        if (!files.some(f => f.path === path)) throw new KbError(404, 'file-not-found')
        const data = await readFile(join(dir, path))
        const before = previousDir === undefined ? null : await readFile(join(previousDir, path)).catch(() => null)
        core.audit('admin-kb-content-read', actor.email, `kb=${row.kbId} req=${row.id} path=${path.slice(0, 200)}`, { userId: store.kb.get(row.kbId)!.ownerUserId })
        const text = (b: Buffer | null) => b === null ? null : /\.(md|markdown|txt|html?)$/i.test(path) ? b.subarray(0, MAX_TEXT).toString('utf8') : null
        return { path, bytes: data.length, text: text(data), previous: text(before), binary: text(data) === null }
      }
      const files = await listFiles(dir)
      const previous = previousDir === undefined ? new Map<string, number>() : new Map((await listFiles(previousDir)).map(f => [f.path, f.bytes]))
      const sameAs = async (p: string) => previousDir !== undefined && Buffer.compare(await readFile(join(dir, p)), await readFile(join(previousDir, p)).catch(() => Buffer.alloc(0))) === 0
      const list = await Promise.all(files.map(async f => ({ path: f.path, bytes: f.bytes, status: !previous.has(f.path) ? 'added' : await sameAs(f.path) ? 'same' : 'changed' })))
      const removed = [...previous.keys()].filter(p => !files.some(f => f.path === p))
      const log = await readFile(join(dir, 'log.md'), 'utf8').catch(() => '')
      const jobs = store.jobs.byKb(row.kbId).slice(0, 5).map(job => ({ id: job.id, op: job.op, state: job.state, finishedAt: job.finishedAt, lint: job.report?.lint.length ?? 0 }))
      return { request: requestView(row), files: list, removed, log: log.slice(-8000), jobs }
    },
    'POST /admin/kb/requests/approve': async req => {
      const body = await req.json()
      const row = pendingRequest(body.id)
      const kb = store.kb.get(row.kbId)!
      const scope = parseScope(core, body.scope)
      const includesRaw = body.includeRaw === true
      const files = await readTree(submissionDir(row.id))
      const snapshotId = await publishSnapshot(core, kb, files, { commitSha: row.commitSha, treeSha: row.treeSha, requestId: row.id, includesRaw, by: req.actor.email })
      store.scopes.set(kb.id, scope)
      store.requests.decide('approved', req.actor.userId, clock(), null, row.id)
      await removeTree(submissionDir(row.id))
      core.audit('admin-kb-approve', req.actor.email, `kb=${kb.id} req=${row.id} snap=${snapshotId} ${scopeDetail(scope)} raw=${includesRaw ? 1 : 0}`, { userId: kb.ownerUserId })
      const views = await reconcileViews(core)
      return { snapshotId, scope, views: views.length }
    },
    'POST /admin/kb/requests/reject': async req => {
      const body = await req.json()
      const row = pendingRequest(body.id)
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (reason.length === 0 || reason.length > 500) throw new KbError(400, 'reason')
      store.requests.decide('rejected', req.actor.userId, clock(), reason, row.id)
      await removeTree(submissionDir(row.id))
      core.audit('admin-kb-reject', req.actor.email, `kb=${row.kbId} req=${row.id}`, { userId: store.kb.get(row.kbId)!.ownerUserId })
      return { rejected: row.id }
    },
    'POST /admin/kb/scope': async req => {
      const body = await req.json()
      const kb = published(body.kb)
      if (store.publications.get(kb.id)?.state !== 'active') throw new KbError(409, 'not-published')
      const scope = parseScope(core, body.scope)
      store.scopes.set(kb.id, scope)
      core.audit('admin-kb-scope-change', req.actor.email, `kb=${kb.id} ${scopeDetail(scope)}`, { userId: kb.ownerUserId })
      const views = await reconcileViews(core)
      return { scope, views: views.length }
    },
    'POST /admin/kb/revoke': async req => {
      const body = await req.json()
      const kb = published(body.kb)
      if (store.publications.revoke(req.actor.email, clock(), kb.id) === 0) throw new KbError(409, 'not-published')
      core.audit('admin-kb-revoke', req.actor.email, `kb=${kb.id}`, { userId: kb.ownerUserId })
      const views = await reconcileViews(core)
      return { revoked: kb.id, views: views.length }
    },
  }
  return { routes, submit, withdraw, sweep }
}
