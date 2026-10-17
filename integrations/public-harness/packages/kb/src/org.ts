/** Org knowledge bases and the System Admin inventory. Org KBs are service-owned repositories under `<kbRoot>/org/<kbId>/`; admins
 * create them, upload sources, edit pages, compile (charged to the KB's own ledger principal `org-kb-<kbId>`), browse the history and
 * publish any commit (rollback). A published personal KB can be converted into an org KB: the org KB starts from the published tree,
 * takes over the scope, and the author's KB becomes private again (the author sees the conversion in the personal center). The
 * inventory lists every KB with share state, scope and over-limit flags; the preview shows one user's effective set. */
import { KbError } from './errors.ts'
import { listFiles, readTree } from './files.ts'
import { ID_PATTERN, newId, slugify } from './ids.ts'
import type { compileJobs } from './jobs.ts'
import { overLimit } from './limits.ts'
import type { KbRoutes } from './server.ts'
import { MAX_SOURCE_BYTES, ORG_ACCOUNT, sourceName, type KbCore } from './service.ts'
import { parseScope, publishSnapshot, scopeDetail } from './share.ts'
import type { KbRow } from './store.ts'
import { readTar, SOURCE_EXTENSIONS, writeTar } from './tar.ts'
import { reconcileViews, visibleEntries } from './views.ts'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const EXPORT_LIMITS = { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, extensions: SOURCE_EXTENSIONS }
const SHA = /^[0-9a-f]{40,64}$/
const PAGE = /^(wiki\/[^/]+\.md|index\.md|schema\.md)$/
const MAX_PAGE = 200 * 1024
const MAX_TEXT = 256 * 1024
/** The quota ledger principal an org KB's compiles are charged to. */
export const orgPrincipal = (kbId: string) => `org-kb-${kbId}`

const title = (value: unknown) => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120 || /[\0-\x1f\x7f]/.test(value)) throw new KbError(400, 'title')
  return value.trim()
}

/** Org and inventory routes. */
export function orgModule(core: KbCore, jobs: ReturnType<typeof compileJobs> | undefined): KbRoutes {
  const { store, clock } = core
  const kbOf = (id: unknown): KbRow => {
    const kb = typeof id === 'string' && ID_PATTERN.kb.test(id) ? store.kb.get(id) : undefined
    if (kb === undefined) throw new KbError(404, 'kb-not-found')
    return kb
  }
  const orgOf = (id: unknown): KbRow => {
    const kb = kbOf(id)
    if (kb.kind !== 'org') throw new KbError(409, 'not-org')
    if (kb.archivedAt !== null) throw new KbError(409, 'archived')
    return kb
  }
  const emailOf = (userId: string | null) => userId === null ? null : store.principals.get(userId)?.email ?? null
  const slugFor = (text: string) => { const base = slugify(text); let slug = base; for (let n = 2; store.kb.slugTaken(null, slug); n++) slug = `${base.slice(0, 44)}-${n}`; return slug }
  const tree = async (kb: KbRow) => core.kbTree(kb)

  const shareOf = (kb: KbRow) => {
    const publication = store.publications.get(kb.id)
    const pending = store.requests.pendingOf(kb.id)
    return {
      state: pending !== undefined ? 'pending' : publication?.state === 'active' ? 'published' : publication?.state === 'revoked' ? 'revoked' : 'private',
      publishedAt: publication?.state === 'active' ? publication.publishedAt : null,
      snapshot: publication?.state === 'active' ? store.snapshots.get(publication.snapshotId) ?? null : null,
      scope: publication?.state === 'active' ? store.scopes.get(kb.id) : [],
      pendingRequest: pending?.id ?? null,
    }
  }
  const overOf = (kb: KbRow) => {
    if (kb.kind !== 'personal') return []
    const limits = core.limitsOf(kb.ownerUserId!)
    const over: Array<{ limit: string; value: number; allowed: number }> = []
    if (overLimit(limits.max_bytes, kb.bytes)) over.push({ limit: 'max_bytes', value: kb.bytes, allowed: limits.max_bytes.value! })
    if (overLimit(limits.max_pages, kb.pages)) over.push({ limit: 'max_pages', value: kb.pages, allowed: limits.max_pages.value! })
    if (kb.archivedAt === null && overLimit(limits.max_kbs, store.kb.activeCount(kb.ownerUserId!))) over.push({ limit: 'max_kbs', value: store.kb.activeCount(kb.ownerUserId!), allowed: limits.max_kbs.value! })
    return over
  }
  const inventoryRow = (kb: KbRow) => ({ ...kb, ownerEmail: emailOf(kb.ownerUserId), share: shareOf(kb), over: overOf(kb),
    convertedTo: store.conversions.from(kb.id)?.toKb ?? null, convertedFrom: store.conversions.to(kb.id)?.fromKb ?? null,
    lastJob: store.jobs.byKb(kb.id)[0] ?? null, chargedTo: kb.kind === 'org' ? orgPrincipal(kb.id) : kb.ownerUserId })

  /** Publish one commit of an org KB as its new snapshot (used by publish and rollback). */
  async function publishCommit(kb: KbRow, commit: string, by: string, includeRaw: boolean) {
    const t = await tree(kb)
    const files = readTar(await core.helper(t, 'archive', { kb: kb.id, rev: commit }), EXPORT_LIMITS).files
    const { tree: treeSha } = await core.helperJson<{ tree: string }>(t, 'head', { kb: kb.id, rev: commit })
    return publishSnapshot(core, kb, files, { commitSha: commit, treeSha, requestId: null, includesRaw: includeRaw, by })
  }

  return {
    'GET /admin/kb': async ({ query }) => {
      const filter = query.get('filter') ?? 'all', kind = query.get('kind') ?? 'all'
      if (!['all', 'over', 'published', 'pending'].includes(filter) || !['all', 'personal', 'org'].includes(kind)) throw new KbError(400, 'filter')
      const rows = store.kb.all().filter(kb => kind === 'all' || kb.kind === kind).map(inventoryRow)
        .filter(row => filter === 'all' || (filter === 'over' ? row.over.length > 0 : row.share.state === filter))
      return { kbs: rows, totals: { all: store.kb.all().length, over: store.kb.all().filter(kb => overOf(kb).length > 0).length } }
    },
    'GET /admin/kb/preview': async ({ query }) => {
      const user = query.get('user') ?? ''
      const principal = store.principals.get(user)
      if (principal === undefined) throw new KbError(404, 'user-not-found')
      return { user: { id: user, email: principal.email, groups: principal.groups, disabled: principal.disabled },
        kbs: visibleEntries(core, user).map(entry => { const kb = store.kb.get(entry.kbId)!; return { id: kb.id, title: kb.title, kind: kb.kind, name: entry.name, path: `~/kb/shared/${entry.name}`,
          scope: store.scopes.get(kb.id) } }) }
    },
    /** Files of a KB the admin may read: org KBs at HEAD (with history), others only from their active publication. */
    'GET /admin/kb/content': async ({ actor, query }) => {
      const kb = kbOf(query.get('kb'))
      const path = query.get('path')
      if (kb.kind === 'org') {
        const t = await tree(kb)
        if (path !== null) {
          const rev = query.get('rev') ?? 'HEAD'
          if (rev !== 'HEAD' && !SHA.test(rev)) throw new KbError(400, 'rev')
          const data = await core.helper(t, 'show', { kb: kb.id, rev, path }).catch(() => { throw new KbError(404, 'file-not-found') })
          return { path, bytes: data.length, text: /\.(md|markdown|txt|html?)$/i.test(path) ? data.subarray(0, MAX_TEXT).toString('utf8') : null }
        }
        const head = await core.helperJson<{ head: string }>(t, 'head', { kb: kb.id })
        const files = readTar(await core.helper(t, 'archive', { kb: kb.id, rev: head.head }), EXPORT_LIMITS).files.map(f => ({ path: f.path, bytes: f.data.length }))
        const { commits } = await core.helperJson<{ commits: Array<{ sha: string; at: number; subject: string }> }>(t, 'log', { kb: kb.id, limit: 50 })
        const published = shareOf(kb).snapshot?.commitSha ?? null
        return { kb: inventoryRow(kb), head: head.head, files, history: commits.map(c => ({ ...c, published: c.sha === published })) }
      }
      const publication = store.publications.get(kb.id)
      // An unshared personal KB: metadata only.
      if (publication?.state !== 'active') return { kb: inventoryRow(kb), files: null, history: null }
      const dir = join(core.root, 'published', kb.id, publication.snapshotId)
      const files = await listFiles(dir)
      if (path === null) return { kb: inventoryRow(kb), files, history: null }
      if (!files.some(f => f.path === path)) throw new KbError(404, 'file-not-found')
      const data = await readFile(join(dir, path))
      core.audit('admin-kb-content-read', actor.email, `kb=${kb.id} snap=${publication.snapshotId} path=${path.slice(0, 200)}`, { userId: kb.ownerUserId })
      return { path, bytes: data.length, text: /\.(md|markdown|txt|html?)$/i.test(path) ? data.subarray(0, MAX_TEXT).toString('utf8') : null }
    },
    'POST /admin/kb/org': async req => {
      const body = await req.json()
      const name = title(body.title)
      const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : ''
      const id = newId('kb')
      store.kb.insert({ id, kind: 'org', ownerUserId: null, slug: slugFor(name), title: name, description }, clock())
      try { await core.helperJson({ userId: ORG_ACCOUNT, account: ORG_ACCOUNT, kbDir: join(core.root, 'org') }, 'init', { kb: id, title: name }) } catch (error) {
        store.db.prepare('DELETE FROM kb WHERE id = ?').run(id)
        throw error
      }
      const kb = await core.refreshStats(store.kb.get(id)!)
      core.audit('admin-kb-org-create', req.actor.email, `kb=${id} charged=${orgPrincipal(id)}`)
      return { kb: inventoryRow(kb) }
    },
    'POST /admin/kb/org/sources': async req => {
      const kb = orgOf(req.query.get('kb'))
      const file = sourceName(req.query.get('name'))
      const data = await req.bytes(MAX_SOURCE_BYTES)
      if (data.length === 0) throw new KbError(400, 'empty')
      const result = await core.helperJson<{ head: string; changed: boolean }>(await tree(kb), 'put', { kb: kb.id, path: `raw/${file}`, message: `Add source raw/${file} (${req.actor.email})` }, data)
      core.audit('admin-kb-org-edit', req.actor.email, `kb=${kb.id} path=raw/${file.slice(0, 180)} commit=${result.head.slice(0, 12)}`)
      return { kb: inventoryRow(await core.refreshStats(kb)), path: `raw/${file}`, changed: result.changed }
    },
    'POST /admin/kb/org/edit': async req => {
      const body = await req.json()
      const kb = orgOf(body.kb)
      if (typeof body.path !== 'string' || !PAGE.test(body.path) || body.path.includes('..')) throw new KbError(400, 'path')
      if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > MAX_PAGE || body.text.includes('\0')) throw new KbError(400, 'text')
      const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 200).replace(/[\r\n]+/g, ' ') : `Edit ${body.path}`
      const result = await core.helperJson<{ head: string; changed: boolean }>(await tree(kb), 'put', { kb: kb.id, path: body.path, pages: true, message: `${message} (${req.actor.email})` }, Buffer.from(body.text, 'utf8'))
      core.audit('admin-kb-org-edit', req.actor.email, `kb=${kb.id} path=${body.path} commit=${result.head.slice(0, 12)}`)
      return { kb: inventoryRow(await core.refreshStats(kb)), head: result.head, changed: result.changed }
    },
    'POST /admin/kb/org/compile': async req => {
      if (jobs === undefined) throw new KbError(503, 'compile-unavailable')
      const body = await req.json()
      const kb = orgOf(body.kb)
      const job = await jobs.request(req.actor, kb, body, orgPrincipal(kb.id))
      core.audit('admin-kb-org-compile', req.actor.email, `kb=${kb.id} job=${job.id} op=${job.op} charged=${orgPrincipal(kb.id)}`)
      return { job }
    },
    /** Publish a commit of an org KB: the current HEAD, or an earlier one (rollback). The scope is required until the KB has one. */
    'POST /admin/kb/org/rollback': async req => {
      const body = await req.json()
      const kb = orgOf(body.kb)
      const t = await tree(kb)
      const head = (await core.helperJson<{ head: string }>(t, 'head', { kb: kb.id })).head
      const commit = body.commit === undefined || body.commit === 'HEAD' ? head : String(body.commit)
      if (!SHA.test(commit)) throw new KbError(400, 'commit')
      const { commits } = await core.helperJson<{ commits: Array<{ sha: string }> }>(t, 'log', { kb: kb.id, limit: 100 })
      if (!commits.some(c => c.sha === commit)) throw new KbError(404, 'commit-not-found')
      const scope = body.scope === undefined ? store.scopes.get(kb.id) : parseScope(core, body.scope)
      if (scope.length === 0) throw new KbError(400, 'scope')
      const snapshotId = await publishCommit(kb, commit, req.actor.email, body.includeRaw === true)
      store.scopes.set(kb.id, scope)
      core.audit('admin-kb-rollback', req.actor.email, `kb=${kb.id} commit=${commit.slice(0, 12)} snap=${snapshotId} head=${commit === head ? 1 : 0} ${scopeDetail(scope)}`)
      const views = await reconcileViews(core)
      return { snapshotId, commit, scope, views: views.length }
    },
    /** Convert a published personal KB into an org KB maintained by admins; the author is notified in the personal center. */
    'POST /admin/kb/convert': async req => {
      const body = await req.json()
      const from = kbOf(body.kb)
      if (from.kind !== 'personal') throw new KbError(409, 'not-personal')
      const publication = store.publications.get(from.id)
      if (publication?.state !== 'active') throw new KbError(409, 'not-published')
      const snapshot = store.snapshots.get(publication.snapshotId)!
      const files = await readTree(join(core.root, 'published', from.id, publication.snapshotId))
      const id = newId('kb')
      store.kb.insert({ id, kind: 'org', ownerUserId: null, slug: slugFor(from.title), title: from.title, description: from.description }, clock())
      const orgTree = { userId: ORG_ACCOUNT, account: ORG_ACCOUNT, kbDir: join(core.root, 'org') }
      try { await core.helperJson(orgTree, 'init', { kb: id, title: from.title, from: 'tar', message: `Convert from personal knowledge base ${from.id} (${snapshot.commitSha.slice(0, 12)})` }, writeTar(files)) } catch (error) {
        store.db.prepare('DELETE FROM kb WHERE id = ?').run(id)
        throw error
      }
      const org = await core.refreshStats(store.kb.get(id)!)
      const scope = store.scopes.get(from.id)
      const head = (await core.helperJson<{ head: string }>(orgTree, 'head', { kb: id })).head
      const snapshotId = await publishCommit(org, head, req.actor.email, snapshot.includesRaw)
      store.tx(() => {
        store.publications.remove(from.id)
        store.scopes.clear(from.id)
        store.conversions.add(from.id, id, req.actor.email, clock())
      })
      store.scopes.set(id, scope)
      core.audit('admin-kb-convert', req.actor.email, `kb=${from.id} org=${id} snap=${snapshotId} ${scopeDetail(scope)}`, { userId: from.ownerUserId })
      const views = await reconcileViews(core)
      return { kb: inventoryRow(store.kb.get(id)!), from: from.id, views: views.length }
    },
  }
}
