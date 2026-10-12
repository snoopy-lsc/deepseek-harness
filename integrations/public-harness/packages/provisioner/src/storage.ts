/** Per-account private storage layout, creation, ownership checks, and purge. */
import { chmod, chown, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { AccountIdentity } from './accounts.ts'
import { isDerivedAccountName } from './accounts.ts'

/** Every path derived from one account name; none comes from a caller. */
export interface StorageLayout {
  readonly root: string
  /** Mounted as the instance's private `DSH_HOME`. */
  readonly home: string
  /** Mounted as the instance's private Git workspace. */
  readonly workspace: string
  readonly cache: string
  readonly tmp: string
  /** Mounted for the private launch-token channel. */
  readonly ctl: string
  /** Rootless Podman graph and runtime state; never mounted into the instance. */
  readonly podman: string
  /** The router-facing socket for this account. */
  readonly socketPath: string
}

/** An existing path is owned by someone else or is not a real directory. */
export class StorageOwnershipError extends Error {
  override readonly name = 'StorageOwnershipError'
  constructor(reason: string) { super(`storage ownership: ${reason}`) }
}

/** Derive the complete layout from an account name. */
export function layoutFor(paths: { readonly storageRoot: string; readonly socketDir: string }, account: string): StorageLayout {
  if (!isDerivedAccountName(account)) throw new Error('layout requires a derived account name')
  const root = join(paths.storageRoot, 'users', account)
  return { root, home: join(root, 'home'), workspace: join(root, 'workspace'), cache: join(root, 'cache'), tmp: join(root, 'tmp'), ctl: join(root, 'ctl'),
    podman: join(root, 'podman'), socketPath: join(paths.socketDir, `${account}.sock`) }
}

/** Select native root control storage while retaining the shared private data layout.
 * @param paths Common deployment paths.
 * @param account Derived account name.
 * @param kind Explicit runtime selection.
 * @returns Layout with native control files outside all user-writable directories.
 */
export function layoutForRuntime(paths: { readonly storageRoot: string; readonly socketDir: string; readonly stateDir: string },
  account: string, kind: 'systemd' | 'podman-gvisor'): StorageLayout {
  const layout = layoutFor(paths, account)
  return kind === 'systemd' ? { ...layout, ctl: join(paths.stateDir, 'runtime', account) } : layout
}

/** Ownership changes are injected so tests can run unprivileged. */
export interface Ownership { chown(path: string, uid: number, gid: number): Promise<void> }

/** Production ownership uses the real `chown`. */
export const hostOwnership: Ownership = { chown: (path, uid, gid) => chown(path, uid, gid) }

async function ensureOwnedDirectory(path: string, identity: AccountIdentity, ownership: Ownership): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing === undefined) {
    await mkdir(path, { mode: 0o700 })
    await ownership.chown(path, identity.uid, identity.gid)
    await chmod(path, 0o700)
    return
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new StorageOwnershipError('not a real directory')
  if (existing.uid !== identity.uid) throw new StorageOwnershipError('directory owner differs')
  if ((existing.mode & 0o077) !== 0) await chmod(path, 0o700)
}

/** Create the account's private tree, refusing pre-existing paths with the wrong owner or type. */
export async function ensureStorage(paths: { readonly storageRoot: string }, layout: StorageLayout,
  identity: AccountIdentity, ownership: Ownership, kind: 'systemd' | 'podman-gvisor'): Promise<void> {
  if (kind === 'systemd') throw new StorageOwnershipError('native storage requires descriptor-based provider preparation')
  const users = join(paths.storageRoot, 'users')
  await mkdir(users, { recursive: true, mode: 0o711 })
  const parent = await lstat(users)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
    throw new StorageOwnershipError('users directory is unsafe')
  }
  for (const path of [layout.root, layout.home, layout.workspace, layout.cache, layout.tmp, layout.ctl, ...(kind === 'podman-gvisor' ? [layout.podman] : [])]) {
    await ensureOwnedDirectory(path, identity, ownership)
  }
}

/** Remove an account's whole tree. Only a derived layout beneath the storage root is accepted. */
export async function removeStorage(paths: { readonly storageRoot: string }, layout: StorageLayout): Promise<void> {
  const base = resolve(paths.storageRoot, 'users') + sep
  const target = resolve(layout.root)
  if (!target.startsWith(base) || !isDerivedAccountName(target.slice(base.length))) throw new Error('refusing to purge an unexpected path')
  const entry = await lstat(target).catch(() => undefined)
  if (entry === undefined) return
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new StorageOwnershipError('purge target is not a real directory')
  await rm(target, { recursive: true, force: true })
}

/** List derived account directory names currently present (used by reconcile sweeps). */
export async function listAccountDirectories(paths: { readonly storageRoot: string }): Promise<string[]> {
  const entries = await readdir(join(paths.storageRoot, 'users')).catch(() => [] as string[])
  return entries.filter(isDerivedAccountName)
}
