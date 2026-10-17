/** The knowledge base service core: personal knowledge bases (create, list, upload, archive), limits and usage, the principal projection
 * and the audit outbox. Compile, share and org operations live in their own modules and use this core. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { KbError } from './errors.ts'
import { newId, ID_PATTERN, slugify } from './ids.ts'
import { atLimit, effectiveLimits, overLimit, type EffectiveLimits } from './limits.ts'
import type { HelperRunner, UserTree, UserTrees } from './runner.ts'
import type { KbRow, KbStore, LimitName } from './store.ts'
import { SOURCE_EXTENSIONS } from './tar.ts'

/** Who is asking, as identity asserted it over the private socket. */
export interface Actor { readonly userId: string; readonly email: string; readonly role: 'admin' | 'member' }

/** Collaborators shared by every module. */
export interface KbCore {
  readonly store: KbStore
  readonly root: string
  readonly users: UserTrees
  readonly runner: HelperRunner
  readonly clock: () => number
  readonly log: (line: string) => void
  /** Queue an audit row for identity; `detail` carries IDs and counts only. */
  audit(event: string, actor: string, detail: string, options?: { userId?: string | null; outcome?: 'ok' | 'denied' | 'error' }): void
  tree(userId: string): Promise<UserTree>
  /** Where a KB lives: the author's tree for personal KBs, the service-owned `<kbRoot>/org` tree for org KBs. */
  kbTree(kb: KbRow): Promise<UserTree>
  helper(tree: UserTree, op: Parameters<HelperRunner['run']>[1], args: Record<string, unknown>, input?: Buffer): Promise<Buffer>
  helperJson<T>(tree: UserTree, op: Parameters<HelperRunner['run']>[1], args: Record<string, unknown>, input?: Buffer): Promise<T>
  limitsOf(userId: string): EffectiveLimits
  /** The personal KB `id` owned by `userId` (404 otherwise, including other users' KBs). */
  ownKb(userId: string, id: unknown): KbRow
  /** Re-measure a KB from its HEAD and store the numbers. */
  refreshStats(kb: KbRow): Promise<KbRow>
  /** 409 `kb-limit` when growing this KB is not allowed (already above max_bytes or max_pages). */
  assertGrowth(kb: KbRow, extraBytes?: number): void
}

/** Upload size cap per source (the reverse proxy and identity enforce the same). */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const TITLE = (value: unknown): string => {
  if (typeof value !== 'string') throw new KbError(400, 'body')
  const title = value.trim()
  if (title.length === 0 || title.length > 120 || /[\0-\x1f\x7f]/.test(title)) throw new KbError(400, 'title')
  return title
}
const DESCRIPTION = (value: unknown): string => {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 500 || /[\0\x7f]/.test(value)) throw new KbError(400, 'description')
  return value.trim()
}
/** A safe source file name: a single path segment of letters, digits, CJK, space, dot, hyphen and underscore, with an accepted extension. */
export function sourceName(raw: unknown): string {
  if (typeof raw !== 'string') throw new KbError(400, 'name')
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ')
  const lower = name.toLowerCase(), dot = lower.lastIndexOf('.')
  if (name.length === 0 || Buffer.byteLength(name) > 180 || !/^[\p{L}\p{N} ._-]+$/u.test(name) || name.startsWith('.') || name.includes('..')
    || dot <= 0 || !(SOURCE_EXTENSIONS as readonly string[]).includes(lower.slice(dot))) throw new KbError(400, 'source-name')
  return name
}

/** Build the core.
 * @param options Store, KB root, user trees, helper runner and clock.
 * @returns Core.
 */
/** Account name of the service-owned org tree (never a user account: user IDs cannot start with a dot). */
export const ORG_ACCOUNT = '.org'

export function createCore(options: { store: KbStore; root: string; users: UserTrees; runner: HelperRunner; orgRunner?: HelperRunner; clock?: () => number; log?: (line: string) => void }): KbCore {
  const { store, root, users, runner } = options
  // Org KBs belong to the service account, so their helper runs without switching users.
  const orgRunner = options.orgRunner ?? runner
  const orgTree: UserTree = { userId: ORG_ACCOUNT, account: ORG_ACCOUNT, kbDir: join(root, 'org') }
  const clock = options.clock ?? Date.now
  const log = options.log ?? (() => {})
  const core: KbCore = {
    store, root, users, runner, clock, log,
    audit(event, actor, detail, extra = {}) { store.audit.add(clock(), event, extra.outcome ?? 'ok', extra.userId ?? null, actor, detail) },
    async tree(userId) {
      const tree = await users(userId)
      if (tree === undefined) throw new KbError(409, 'no-account')
      return tree
    },
    async kbTree(kb) { return kb.kind === 'org' ? orgTree : core.tree(kb.ownerUserId!) },
    helper: async (tree, op, args, input) => {
      try { return await (tree.account === ORG_ACCOUNT ? orgRunner : runner).run(tree, op, args, input) } catch (error) {
        log(`kb: helper ${op} failed for ${tree.account}: ${(error as { detail?: string }).detail ?? (error as Error).message}`)
        throw new KbError(502, 'helper-failed')
      }
    },
    async helperJson(tree, op, args, input) { return JSON.parse((await core.helper(tree, op, args, input)).toString('utf8')) },
    limitsOf(userId) { return effectiveLimits(store.limits.list(), userId, store.principals.get(userId)?.groups ?? []) },
    ownKb(userId, id) {
      const kb = typeof id === 'string' && ID_PATTERN.kb.test(id) ? store.kb.get(id) : undefined
      if (kb === undefined || kb.kind !== 'personal' || kb.ownerUserId !== userId) throw new KbError(404, 'kb-not-found')
      return kb
    },
    async refreshStats(kb) {
      const stats = await core.helperJson<{ bytes: number; pages: number; sources: number }>(await core.kbTree(kb), 'stats', { kb: kb.id })
      store.kb.setStats(stats.bytes, stats.pages, stats.sources, clock(), kb.id)
      return store.kb.get(kb.id)!
    },
    assertGrowth(kb, extraBytes = 0) {
      if (kb.kind !== 'personal') return
      const limits = core.limitsOf(kb.ownerUserId!)
      if (extraBytes > 0 ? overLimit(limits.max_bytes, kb.bytes + extraBytes) : overLimit(limits.max_bytes, kb.bytes)) {
        throw new KbError(409, 'kb-limit', { limit: 'max_bytes', value: kb.bytes + extraBytes, allowed: limits.max_bytes.value })
      }
      if (extraBytes === 0 && overLimit(limits.max_pages, kb.pages)) throw new KbError(409, 'kb-limit', { limit: 'max_pages', value: kb.pages, allowed: limits.max_pages.value })
    },
  }
  return core
}

/** Usage against each limit for one user; `over` lists every limit currently exceeded (by any KB for the per-KB limits). */
export function usageOf(core: KbCore, userId: string) {
  const limits = core.limitsOf(userId)
  const mine = core.store.kb.byOwner(userId).filter(kb => kb.archivedAt === null)
  const over: Array<{ limit: LimitName; kbId?: string; value: number; allowed: number }> = []
  if (overLimit(limits.max_kbs, mine.length)) over.push({ limit: 'max_kbs', value: mine.length, allowed: limits.max_kbs.value! })
  for (const kb of mine) {
    if (overLimit(limits.max_bytes, kb.bytes)) over.push({ limit: 'max_bytes', kbId: kb.id, value: kb.bytes, allowed: limits.max_bytes.value! })
    if (overLimit(limits.max_pages, kb.pages)) over.push({ limit: 'max_pages', kbId: kb.id, value: kb.pages, allowed: limits.max_pages.value! })
  }
  return { limits, usage: { kbs: mine.length, maxBytes: Math.max(0, ...mine.map(kb => kb.bytes)), maxPages: Math.max(0, ...mine.map(kb => kb.pages)) }, over }
}

/** Personal knowledge base operations. */
export function personalOps(core: KbCore) {
  const { store, clock } = core
  return {
    async create(actor: Actor, body: Record<string, unknown>) {
      const title = TITLE(body.title), description = DESCRIPTION(body.description)
      const tree = await core.tree(actor.userId)
      const limits = core.limitsOf(actor.userId)
      const count = store.kb.activeCount(actor.userId)
      if (atLimit(limits.max_kbs, count)) throw new KbError(409, 'kb-limit', { limit: 'max_kbs', value: count, allowed: limits.max_kbs.value })
      const id = newId('kb'), base = slugify(title)
      let slug = base
      for (let n = 2; store.kb.slugTaken(actor.userId, slug); n++) slug = `${base.slice(0, 44)}-${n}`
      store.kb.insert({ id, kind: 'personal', ownerUserId: actor.userId, slug, title, description }, clock())
      try { await core.helperJson(tree, 'init', { kb: id, title }) } catch (error) {
        store.db.prepare('DELETE FROM kb WHERE id = ?').run(id)
        throw error
      }
      const kb = await core.refreshStats(store.kb.get(id)!)
      core.audit('kb-create', actor.email, `kb=${id}`, { userId: actor.userId })
      return kb
    },
    async archive(actor: Actor, body: Record<string, unknown>) {
      const kb = core.ownKb(actor.userId, body.kb)
      if (kb.archivedAt !== null) throw new KbError(409, 'archived')
      if (store.publications.get(kb.id)?.state === 'active') throw new KbError(409, 'published')
      if (store.requests.pendingOf(kb.id) !== undefined) throw new KbError(409, 'pending')
      store.kb.archive(clock(), clock(), kb.id)
      core.audit('kb-archive', actor.email, `kb=${kb.id}`, { userId: actor.userId })
      return store.kb.get(kb.id)!
    },
    async upload(actor: Actor, kbId: unknown, name: unknown, data: Buffer) {
      const kb = core.ownKb(actor.userId, kbId)
      if (kb.archivedAt !== null) throw new KbError(409, 'archived')
      const file = sourceName(name)
      if (data.length === 0) throw new KbError(400, 'empty')
      if (data.length > MAX_SOURCE_BYTES) throw new KbError(413, 'too-large')
      core.assertGrowth(await core.refreshStats(kb), data.length)
      const tree = await core.tree(actor.userId)
      const result = await core.helperJson<{ head: string; changed: boolean }>(tree, 'put', { kb: kb.id, path: `raw/${file}`, message: `Add source raw/${file}` }, data)
      return { kb: await core.refreshStats(store.kb.get(kb.id)!), path: `raw/${file}`, changed: result.changed }
    },
  }
}

/** Make sure the KB root has its fixed subdirectories (service-owned, 0750). */
export async function prepareRoot(root: string): Promise<void> {
  for (const name of ['', 'org', 'submissions', 'published', 'views', 'jobs', 'templates']) await mkdir(join(root, name), { recursive: true, mode: 0o750 })
}
