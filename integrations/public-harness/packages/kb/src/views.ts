/** Per-user views: `<kbRoot>/views/<account>/<name>/` holds hard-linked copies of the published snapshots whose scope includes the user
 * (company, one of the user's effective groups, or the user). The view directory itself is fixed, because the instance binds it; each
 * entry is built next to it under a dot name and renamed into place, and entries that are no longer visible are removed at once.
 * What was applied is kept in `<kbRoot>/views/.state/<account>.json` and `kb_view_state`. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KbCore } from './service.ts'
import type { KbRow } from './store.ts'
import { linkTree, removeTree } from './files.ts'

export interface ViewEntry { readonly name: string; readonly kbId: string; readonly snapshotId: string }

/** KBs one user may read now, with stable entry names.
 * @param core Service core.
 * @param userId The user.
 * @returns Entries sorted by name.
 */
export function visibleEntries(core: KbCore, userId: string): ViewEntry[] {
  const { store } = core
  const principal = store.principals.get(userId)
  if (principal === undefined || principal.disabled) return []
  const groups = new Set(principal.groups)
  const visible: Array<{ kb: KbRow; snapshotId: string }> = []
  for (const publication of store.publications.active()) {
    const kb = store.kb.get(publication.kbId)
    if (kb === undefined) continue
    const scopes = store.scopes.get(kb.id)
    if (scopes.some(s => s.kind === 'company' || (s.kind === 'group' && groups.has(s.target)) || (s.kind === 'user' && s.target === userId))) visible.push({ kb, snapshotId: publication.snapshotId })
  }
  visible.sort((a, b) => a.kb.id.localeCompare(b.kb.id))
  const taken = new Set<string>()
  return visible.map(({ kb, snapshotId }) => {
    let name = kb.slug
    if (taken.has(name)) name = `${kb.slug.slice(0, 40)}-${kb.id.slice(3, 9)}`
    taken.add(name)
    return { name, kbId: kb.id, snapshotId }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
const digestOf = (entries: readonly ViewEntry[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')

/** Bring one user's view up to date (no-op when nothing changed).
 * @param core Service core.
 * @param userId The user.
 * @param force Rebuild even when the stored digest matches.
 * @returns True when the view changed.
 */
export async function applyView(core: KbCore, userId: string, force = false): Promise<boolean> {
  const { store, root } = core
  const tree = await core.users(userId)
  if (tree === undefined) return false
  const entries = visibleEntries(core, userId)
  const digest = digestOf(entries)
  const state = store.views.get(userId)
  const dir = join(root, 'views', tree.account), stateDir = join(root, 'views', '.state'), stateFile = join(stateDir, `${tree.account}.json`)
  const existing = await lstat(dir).catch(() => undefined)
  if (!force && existing !== undefined && state?.digest === digest) return false
  if (existing === undefined) await mkdir(dir, { mode: 0o755 })
  else if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('view is not a directory')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const applied = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as Record<string, string>
  const wanted = new Map(entries.map(entry => [entry.name, entry]))
  let changed = state !== undefined && state.digest !== digest
  const trash = async (name: string) => {
    const path = join(dir, name), aside = join(dir, `.old-${randomBytes(6).toString('hex')}`)
    if (await lstat(path).catch(() => undefined) === undefined) return
    await rename(path, aside)
    await removeTree(aside)
  }
  // Remove first: revocation takes effect before anything new is linked.
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) { if (name.startsWith('.old-') || name.startsWith('.next-')) await removeTree(join(dir, name)); continue }
    if (!wanted.has(name)) { await trash(name); delete applied[name]; changed = true }
  }
  for (const entry of entries) {
    if (!force && applied[entry.name] === `${entry.kbId}/${entry.snapshotId}` && await lstat(join(dir, entry.name)).catch(() => undefined) !== undefined) continue
    const next = join(dir, `.next-${randomBytes(6).toString('hex')}`)
    await linkTree(join(root, 'published', entry.kbId, entry.snapshotId), next)
    await trash(entry.name)
    await rename(next, join(dir, entry.name))
    applied[entry.name] = `${entry.kbId}/${entry.snapshotId}`
    changed = true
  }
  await writeFile(stateFile, JSON.stringify(applied), { mode: 0o600 })
  const generation = (state?.generation ?? 0) + 1
  store.views.set(userId, generation, digest, core.clock())
  // A first, empty view is bookkeeping, not a change of what the user can read.
  if (changed) core.audit('kb-view-apply', 'system', `user=${userId} entries=${entries.length} generation=${generation}`, { userId })
  return changed
}

/** Re-apply every user's view whose visible set changed (or only `userIds`).
 * @param core Service core.
 * @param userIds Users to check; every known principal by default.
 * @returns Users whose view changed.
 */
export function reconcileViews(core: KbCore, userIds?: readonly string[]): Promise<string[]> {
  // One rebuild at a time per service: approvals, scope changes and group pushes can overlap.
  const run = (locks.get(core) ?? Promise.resolve()).then(() => reconcileNow(core, userIds))
  locks.set(core, run.catch(() => []))
  return run
}
const locks = new WeakMap<KbCore, Promise<unknown>>()
async function reconcileNow(core: KbCore, userIds?: readonly string[]): Promise<string[]> {
  const changed: string[] = []
  for (const userId of userIds ?? core.store.principals.all().map(p => p.userId)) {
    try { if (await applyView(core, userId)) changed.push(userId) } catch (error) { core.log(`kb: view for ${userId} failed: ${(error as Error).message}`) }
  }
  return changed
}
