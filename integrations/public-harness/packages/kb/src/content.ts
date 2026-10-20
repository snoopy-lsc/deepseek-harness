/** Authenticated browser previews: owners read committed personal files; everyone else reads only the current visible publication. */
import { isUtf8 } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { KbError } from './errors.ts'
import { listFiles } from './files.ts'
import { ID_PATTERN } from './ids.ts'
import type { KbRoutes } from './server.ts'
import type { KbCore } from './service.ts'
import { readTar, safeRelativePath, SOURCE_EXTENSIONS, TarError } from './tar.ts'
import { visibleEntries } from './views.ts'

const MAX_TEXT = 256 * 1024
const TEXT = /\.(md|markdown|txt|html?)$/i
const SOURCE = new Set<string>(SOURCE_EXTENSIONS)
const approved = (path: string) => SOURCE.has(path.slice(path.lastIndexOf('.')).toLowerCase())

function pathOf(value: string): string {
  try {
    if (safeRelativePath(value) !== value || value.startsWith('-') || value.split('/').includes('.git')) throw new TarError('path')
  } catch (error) { if (error instanceof TarError) throw new KbError(400, 'path'); throw error }
  return value
}
function browseable(path: string): boolean {
  try { return pathOf(path) === path && approved(path) } catch (error) { if (error instanceof KbError) return false; throw error }
}
function preview(path: string, data: Buffer) {
  const textual = TEXT.test(path) && !data.includes(0) && isUtf8(data)
  const text = textual ? new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, MAX_TEXT), { stream: data.length > MAX_TEXT }) : null
  return { path, bytes: data.length, text, truncated: textual && data.length > MAX_TEXT }
}

/** Build member content routes; admin roles grant no extra access through these routes.
 * @param core Knowledge base metadata, helpers and publication storage.
 * @returns Routes serving bounded text as JSON with explicit binary and truncation fields.
 */
export function contentModule(core: KbCore): KbRoutes {
  const { store } = core
  return {
    'GET /me/kb/content': async ({ actor, query }) => {
      if ([...query.keys()].some(key => key !== 'kb' && key !== 'path') || query.getAll('kb').length !== 1 || query.getAll('path').length > 1) throw new KbError(400, 'query')
      const id = query.get('kb') ?? ''
      const kb = ID_PATTERN.kb.test(id) ? store.kb.get(id) : undefined
      if (kb === undefined) throw new KbError(404, 'kb-not-found')
      const enabled = () => { const principal = store.principals.get(actor.userId); return principal !== undefined && !principal.disabled }
      const owner = kb.kind === 'personal' && kb.ownerUserId === actor.userId
      const visible = () => visibleEntries(core, actor.userId).find(entry => entry.kbId === kb.id)
      const publication = owner ? undefined : visible()
      if (!enabled() || !owner && publication === undefined) throw new KbError(404, 'kb-not-found')
      const requested = query.get('path')
      const path = requested === null ? null : pathOf(requested)
      let result: unknown, revision: string
      if (owner) {
        const tree = await core.tree(actor.userId)
        const head = await core.helperJson<{ head: string }>(tree, 'head', { kb: kb.id })
        revision = head.head
        const archive = await core.helper(tree, 'archive', { kb: kb.id, rev: revision })
        let files
        try { files = readTar(archive).files.filter(file => browseable(file.path)) }
        catch (error) { if (error instanceof TarError) throw new KbError(409, 'unsafe-tree'); throw error }
        if (path === null) result = { files: files.map(file => ({ path: file.path, bytes: file.data.length })), revision, readOnly: kb.archivedAt !== null }
        else {
          const file = files.find(file => file.path === path)
          if (file === undefined) throw new KbError(404, 'file-not-found')
          result = preview(path, file.data)
        }
      } else {
        revision = publication!.snapshotId
        const dir = join(core.root, 'published', kb.id, revision)
        const directory = await lstat(dir)
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new KbError(409, 'unsafe-tree')
        const files = (await listFiles(dir)).filter(file => browseable(file.path))
        if (path === null) result = { files, revision, readOnly: true }
        else {
          if (!files.some(file => file.path === path)) throw new KbError(404, 'file-not-found')
          const handle = await open(join(dir, path), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            if (!(await handle.stat()).isFile()) throw new KbError(404, 'file-not-found')
            result = preview(path, await handle.readFile())
          } finally { await handle.close() }
        }
      }
      // Revocation, scope changes and account disable can happen while files or a helper are being read.
      if (!enabled() || !owner && visible()?.snapshotId !== revision) throw new KbError(404, 'kb-not-found')
      core.audit('kb-content-read', actor.email, `kb=${kb.id} revision=${revision} kind=${path === null ? 'list' : 'file'}`, { userId: actor.userId })
      return result
    },
  }
}
