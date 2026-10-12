/** Native root writes use held directory descriptors; user trees are never traversed for ownership changes. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, type FileHandle } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { RuntimeInstance } from '@public-harness/contracts'
import type { AccountIdentity } from '@public-harness/provisioner/accounts'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { NativeHostError, type SystemdConfig } from './config.ts'
import { ensureNativeAccount } from './accounts.ts'
import { applyDiskLimits } from './limits.ts'
import { renderAppArmor } from './apparmor.ts'
import { renderUnit } from './units.ts'

/** Open the exact directory entry without following its final component.
 * @param path Path anchored by a trusted parent; production callers retain the parent handle.
 * @returns Caller-owned handle; rejects links and non-directories before any write.
 */
export async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  try { return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
  catch (cause) { throw new NativeHostError('unsafe-path', 'open-directory', cause) }
}
function entry(parent: FileHandle, name: string): string {
  if (process.platform !== 'linux' || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
    throw new NativeHostError('unsafe-path', 'descriptor-path')
  }
  return `/proc/self/fd/${parent.fd}/${name}`
}
async function rootDirectory(handle: FileHandle): Promise<void> {
  const s = await handle.stat()
  if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022) !== 0) throw new NativeHostError('unsafe-path', 'root-directory')
}
async function openRootDirectory(path: string): Promise<FileHandle> {
  let handle = await openDirectoryNoFollow('/')
  try {
    await rootDirectory(handle)
    for (const component of path.split('/').filter(Boolean)) {
      const next = await openDirectoryNoFollow(entry(handle, component))
      await handle.close(); handle = next
      await rootDirectory(handle)
    }
    return handle
  } catch (cause) { await handle.close(); throw cause }
}

/** Create or reopen one child through a held trusted parent, never modifying descendants.
 * @param parent Caller-owned directory handle whose entry cannot be replaced by the tenant.
 * @param name Single server-derived component.
 * @param identity Required numeric owner; existing mismatches reject without chown.
 * @param mode Exact top-level permissions.
 * @returns Caller-owned child handle; partially created directories remain for reconciliation on failure.
 */
export async function ensureDirectoryAt(parent: FileHandle, name: string, identity: AccountIdentity, mode: number): Promise<FileHandle> {
  const path = entry(parent, name)
  let created = false
  try { await mkdir(path, { mode }); created = true }
  catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw new NativeHostError('unsafe-path', 'create-directory', cause) }
  const child = await openDirectoryNoFollow(path)
  try {
    const s = await child.stat()
    if (created) { await child.chown(identity.uid, identity.gid); await child.chmod(mode) }
    else if (s.uid !== identity.uid || s.gid !== identity.gid || (s.mode & 0o777) !== mode) throw new NativeHostError('unsafe-path', 'directory-owner-or-mode')
    return child
  } catch (cause) { await child.close(); throw cause }
}

async function validateAncestors(path: string): Promise<void> {
  const s = await lstat(path)
  if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0) throw new NativeHostError('unsafe-path', 'asset-owner-or-mode')
  if (path !== '/') await validateAncestors(dirname(path))
}

async function validateOriginalAncestors(path: string): Promise<void> {
  if (path !== '/') await validateOriginalAncestors(dirname(path))
  const info = await lstat(path)
  if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0)) throw new NativeHostError('unsafe-path', 'asset-source-ancestor')
  if (info.isSymbolicLink()) await validateAncestors(await realpath(path))
}

/** Resolve immutable links only inside explicitly allowed trees.
 * @param path Asset entry, possibly a symlink.
 * @param roots Canonical immutable trees declared by the caller.
 * @returns Canonical target; this function performs path containment only, not ownership validation.
 */
export async function resolveImmutablePath(path: string, roots: readonly string[]): Promise<string> {
  try {
    const target = await realpath(path)
    if (!roots.some(root => target === root || target.startsWith(`${root}/`))) throw new NativeHostError('unsafe-path', 'asset-link-escape')
    return target
  } catch (cause) {
    if (cause instanceof NativeHostError) throw cause
    throw new NativeHostError('unsafe-path', 'asset-link-resolution', cause)
  }
}

/** Verify complete immutable trees, including in-tree link targets, before privileged preparation.
 * @param paths Files or directories whose owner, ancestors and descendants must be trusted.
 * @param roots Permitted canonical link targets; defaults to the supplied immutable trees.
 * @returns Resolves after uid 0/non-writable checks; rejects dangling links, escapes and unsafe ownership.
 */
export async function validateRootAssets(paths: readonly string[], roots: readonly string[] = paths): Promise<void> {
  const visited = new Set<string>()
  async function visit(path: string): Promise<void> {
    await validateOriginalAncestors(path)
    const target = await resolveImmutablePath(path, roots)
    await validateAncestors(target)
    // A link's own parent must be immutable even when its target is trusted.
    const parent = await realpath(dirname(path)); await validateAncestors(parent)
    const original = await lstat(path)
    if (original.uid !== 0) throw new NativeHostError('unsafe-path', 'asset-link-owner')
    if (visited.has(target)) return
    visited.add(target)
    const s = await lstat(target)
    if (s.isDirectory()) for (const name of await readdir(target)) await visit(join(target, name))
    else if (!s.isFile()) throw new NativeHostError('unsafe-path', 'asset-type')
  }
  try { for (const path of paths) await visit(path) }
  catch (cause) {
    if (cause instanceof NativeHostError) throw cause
    throw new NativeHostError('unsafe-path', 'immutable-assets', cause)
  }
}

/** Check configured commands and release assets before the first native account or storage effect.
 * @param config Resolved deployment values.
 * @returns Resolves after read-only checks; startup must reject on failure.
 */
export async function validateNativeAssets(config: SystemdConfig): Promise<void> {
  await validateRootAssets([config.paths.release, config.paths.toolchain])
  await validateRootAssets(Object.values(config.tools), [config.paths.toolchain, '/usr', '/bin', '/sbin'])
  await validateRootAssets([config.paths.dsh, config.paths.launchPatch], [config.paths.release])
}

/** Prepare root management directories and quota-backed user directories without entering user trees.
 * @param instance Server-assigned paths and identity.
 * @param config Validated native deployment.
 * @returns Resolves after directory preparation; no process or policy is activated.
 */
export async function prepareNativeStorage(instance: RuntimeInstance, config: SystemdConfig): Promise<void> {
  const storage = await openRootDirectory(config.paths.storageRoot)
  let state: FileHandle | undefined
  try {
    state = await openRootDirectory(config.paths.stateDir)
    const mount = await openRootDirectory(config.paths.quotaMount)
    try { if ((await storage.stat()).dev !== (await mount.stat()).dev) throw new NativeHostError('unsafe-path', 'quota-filesystem') }
    finally { await mount.close() }
    const users = await ensureDirectoryAt(storage, 'users', { uid: 0, gid: 0 }, 0o711)
    try {
      const root = await ensureDirectoryAt(users, instance.account, { uid: 0, gid: 0 }, 0o711)
      try {
        for (const path of [instance.home, instance.workspace, instance.cache, instance.tmp]) {
          const name = relative(`${config.paths.storageRoot}/users/${instance.account}`, path)
          const child = await ensureDirectoryAt(root, name, instance, 0o700)
          try { if ((await child.stat()).dev !== (await storage.stat()).dev) throw new NativeHostError('unsafe-path', 'user-filesystem') }
          finally { await child.close() }
        }
      } finally { await root.close() }
    } finally { await users.close() }
    const runtime = await ensureDirectoryAt(state, 'runtime', { uid: 0, gid: 0 }, 0o700)
    try { const control = await ensureDirectoryAt(runtime, instance.account, { uid: 0, gid: 0 }, 0o700); await control.close() }
    finally { await runtime.close() }
  } finally { await storage.close(); await state?.close() }
}

/** Atomically publish generated management text under a held root directory.
 * @param directory Root-owned control directory with trusted ancestors.
 * @param name Server-derived single file name.
 * @param text Generated text; never tenant input.
 * @returns Resolves after syncing and replacement; stale exclusive staging files reject for reconciliation.
 */
export async function writeControlFile(directory: string, name: string, text: string): Promise<void> {
  const parent = await openRootDirectory(directory)
  try {
    const pending = entry(parent, `${name}.pending`), target = entry(parent, name)
    const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(text); await file.sync() } finally { await file.close() }
    await rename(pending, target); await parent.sync()
  } catch (cause) { throw new NativeHostError('unsafe-path', 'control-file', cause) }
  finally { await parent.close() }
}

/** Prepare native storage, hard quotas and management files; leaves all execution stopped.
 * @param instance Fully allocated native instance.
 * @param config Resolved root deployment configuration.
 * @param runner Privileged command adapter.
 * @returns Resolves after preparatory effects, not active enforcement; callers retain allocation on failure and verify Linux policy before starting.
 */
export async function prepareHost(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void> {
  if (instance.runtime.kind !== 'systemd') throw new NativeHostError('invalid-config', 'runtime-selection')
  await validateNativeAssets(config)
  const identity = await ensureNativeAccount(instance.userId, config, runner)
  if (identity.uid !== instance.uid || identity.gid !== instance.gid) throw new NativeHostError('account-conflict', 'allocated-identity')
  await applyDiskLimits(instance, config, runner)
  await prepareNativeStorage(instance, config)
  await writeControlFile(instance.controlDir, instance.runtime.unit, renderUnit(instance, config))
  await writeControlFile(instance.controlDir, `${instance.account}.apparmor`, renderAppArmor(instance, config))
}
