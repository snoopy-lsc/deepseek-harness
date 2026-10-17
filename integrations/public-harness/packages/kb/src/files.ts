/** Service-side tree operations under `<kbRoot>`: write validated archives as read-only trees, hard-link copies for views, and removal
 * of read-only trees. Only paths the service created are touched; nothing here follows a symbolic link. */
import { chmod, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { TarFile } from './tar.ts'

/** Write files into a new directory, then make files 0444 and directories 0555, and rename it to `target`.
 * @param target Final directory (must not exist).
 * @param files Validated files (relative paths).
 */
export async function writeReadOnlyTree(target: string, files: readonly TarFile[]): Promise<void> {
  const temp = `${dirname(target)}/.tmp-${randomBytes(6).toString('hex')}`
  await mkdir(temp, { recursive: false, mode: 0o755 })
  try {
    const dirs = new Set<string>([temp])
    for (const file of files) {
      const path = join(temp, file.path)
      for (let d = dirname(path); d.length > temp.length && !dirs.has(d); d = dirname(d)) dirs.add(d)
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await writeFile(path, file.data, { mode: 0o444, flag: 'wx' })
      await chmod(path, 0o444)
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await chmod(dir, 0o555)
    await rename(temp, target)
  } catch (error) { await removeTree(temp); throw error }
}

/** Remove a tree that may contain 0555 directories; refuses symbolic links at the top. */
export async function removeTree(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined) return
  if (info.isSymbolicLink() || !info.isDirectory()) { await rm(path, { force: true }); return }
  const open = async (dir: string) => {
    await chmod(dir, 0o755)
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await open(join(dir, entry.name))
  }
  await open(path)
  await rm(path, { recursive: true, force: true })
}

/** Every regular file below `root` (relative paths, sorted). */
export async function listFiles(root: string, prefix = ''): Promise<Array<{ path: string; bytes: number }>> {
  const out: Array<{ path: string; bytes: number }> = []
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...await listFiles(root, rel))
    else if (entry.isFile()) out.push({ path: rel, bytes: (await lstat(join(root, rel))).size })
  }
  return out
}

/** Read the files of a service-written tree back as archive entries. */
export async function readTree(root: string, filter: (path: string) => boolean = () => true): Promise<TarFile[]> {
  const files: TarFile[] = []
  for (const file of await listFiles(root)) if (filter(file.path)) files.push({ path: file.path, data: await readFile(join(root, file.path)) })
  return files
}

/** Build `dest` as a copy of `source` made of hard links (same filesystem); directories end up 0555.
 * @param source A published snapshot.
 * @param dest New directory.
 */
export async function linkTree(source: string, dest: string): Promise<void> {
  await mkdir(dest, { mode: 0o755 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(dest, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) await linkTree(from, to)
    else if (entry.isFile()) await link(from, to)
  }
  await chmod(dest, 0o555)
}
