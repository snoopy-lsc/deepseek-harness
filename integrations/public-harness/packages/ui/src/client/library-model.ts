/** Pure filtering and directory projection for the library's own file lists. */
import type { KbContent } from './kb-api.ts'

const searchText = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()

/** Search actual title and description fields while retaining the original items.
 * @param items - Personal or shared knowledge bases.
 * @param query - User-entered search text.
 * @returns Matching knowledge bases in their original order.
 */
export function filterLibraries<Item extends { readonly title: string; readonly description?: string }>(items: readonly Item[], query: string): readonly Item[] {
  const needle = searchText(query)
  return needle === '' ? items : items.filter(item => searchText(`${item.title}\n${item.description ?? ''}`).includes(needle))
}

/** An immediate directory or file; directories aggregate all their descendants. */
export type LibraryEntry = { readonly kind: 'directory'; readonly name: string; readonly path: string; readonly bytes: number; readonly count: number }
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly bytes: number }

/** Project immediate children, or matching descendant file paths when searching.
 * @param files - Server-listed files.
 * @param directory - Relative directory, or empty for the knowledge-base root.
 * @param query - Search text within that directory.
 * @returns Directories first, then files, each ordered by name.
 */
export function browseEntries(files: KbContent['files'], directory: string, query: string): readonly LibraryEntry[] {
  const prefix = directory === '' ? '' : `${directory}/`, needle = searchText(query)
  const entries = new Map<string, LibraryEntry>()
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const relative = file.path.slice(prefix.length)
    if (relative === '') continue
    if (needle !== '') {
      if (searchText(file.path).includes(needle)) entries.set(file.path, { kind: 'file', path: file.path, name: relative, bytes: file.bytes })
      continue
    }
    const slash = relative.indexOf('/')
    if (slash === -1) entries.set(file.path, { kind: 'file', path: file.path, name: relative, bytes: file.bytes })
    else {
      const name = relative.slice(0, slash), path = `${prefix}${name}`, previous = entries.get(path)
      entries.set(path, { kind: 'directory', name, path, bytes: (previous?.bytes ?? 0) + file.bytes, count: (previous?.kind === 'directory' ? previous.count : 0) + 1 })
    }
  }
  return [...entries.values()].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1) || left.name.localeCompare(right.name))
}

/** Check the user-selectable format and upload size before sending the source.
 * @param file - Selected local file name and size.
 * @returns A localized failure key when unsupported or larger than 25 MiB.
 */
export function sourceFileError(file: { readonly name: string; readonly size: number }): 'kb_err_source_name' | 'kb_err_too_large' | undefined {
  if (!/\.(?:md|markdown|txt|pdf|docx|html|htm)$/i.test(file.name)) return 'kb_err_source_name'
  return file.size > 25 * 1024 * 1024 ? 'kb_err_too_large' : undefined
}
