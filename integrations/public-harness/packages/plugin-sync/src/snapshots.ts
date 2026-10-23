/**
 * Profile snapshots under `~/.dsh-market/snapshots/<op>/`.
 * Tenant reads use O_NOFOLLOW + regular-file + ≤4 MiB (design § Tenant files).
 * Queued user/admin restore is stubbed here; execute at reconcile start in 1D.6.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { marketDir, snapshotsDir } from './oplog.ts'

export const MAX_TENANT_FILE_BYTES = 4 * 1024 * 1024
export const MAX_SNAPSHOTS = 5

export const PROFILE_MANIFEST = 'package.json'
export const PROFILE_LOCKFILE = 'pnpm-lock.yaml'

export type RestoreQueueReason = 'user' | 'admin'

export interface QueuedRestore {
  readonly snapshotId: string
  readonly reason: RestoreQueueReason
  readonly at: number
}

export interface SnapshotHashes {
  readonly manifestSha256: string
  readonly lockSha256: string | null
}

function errno(code: string, message: string, path?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  if (path !== undefined) err.path = path
  return err
}

export function hashBytesSha256(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function restoreQueuePath(home: string): string {
  return join(marketDir(home), 'restore-queue.jsonl')
}

/**
 * Open a tenant-controlled path with O_NOFOLLOW; accept only regular files ≤ 4 MiB.
 * Symlinks fail closed (ELOOP). Missing files surface as ENOENT from open/lstat.
 */
export async function readTenantFile(path: string): Promise<Buffer> {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    throw error
  }
  if (entry.isSymbolicLink()) {
    throw errno('ELOOP', `refusing symlink at ${path}`, path)
  }
  if (!entry.isFile()) {
    throw errno('EINVAL', `not a regular file: ${path}`, path)
  }
  if (entry.size > MAX_TENANT_FILE_BYTES) {
    throw errno('EFBIG', `tenant file exceeds ${MAX_TENANT_FILE_BYTES} bytes: ${path}`, path)
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) {
      throw errno('EINVAL', `not a regular file after open: ${path}`, path)
    }
    if (info.size > MAX_TENANT_FILE_BYTES) {
      throw errno('EFBIG', `tenant file exceeds ${MAX_TENANT_FILE_BYTES} bytes: ${path}`, path)
    }
    const buf = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await file.read(buf, offset, buf.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_TENANT_FILE_BYTES) {
      throw errno('EFBIG', `tenant file exceeds ${MAX_TENANT_FILE_BYTES} bytes: ${path}`, path)
    }
    return buf.subarray(0, offset)
  } finally {
    await file.close()
  }
}

async function writeAtomicFile(path: string, bytes: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
  await rename(tmp, path)
}

async function readSnapshotCreatedAt(dir: string, fallbackMs: number): Promise<number> {
  try {
    const raw = await readFile(join(dir, 'meta.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { at?: unknown }).at === 'number') {
      return (parsed as { at: number }).at
    }
  } catch {
    // fall through to directory mtime
  }
  return fallbackMs
}

export async function listSnapshotIds(home: string): Promise<string[]> {
  const root = snapshotsDir(home)
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const withAt: { id: string; at: number }[] = []
  for (const id of names) {
    if (id.startsWith('.')) continue
    const dir = join(root, id)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory()) continue
      const at = await readSnapshotCreatedAt(dir, st.mtimeMs)
      withAt.push({ id, at })
    } catch {
      // skip vanished entries
    }
  }
  withAt.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
  return withAt.map((e) => e.id)
}

/** Drop oldest snapshot directories so at most MAX_SNAPSHOTS remain. */
export async function rotateSnapshots(home: string): Promise<void> {
  const ids = await listSnapshotIds(home)
  for (const id of ids.slice(MAX_SNAPSHOTS)) {
    await rm(join(snapshotsDir(home), id), { recursive: true, force: true })
  }
}

/**
 * Copy profile `package.json` + `pnpm-lock.yaml` into `snapshots/<opId>/`.
 * Lockfile may be absent (ENOENT); package.json must be readable as a tenant file.
 * Rotates so only the last five snapshot dirs are kept.
 */
export async function writeProfileSnapshot(
  home: string,
  profileDir: string,
  opId: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(opId)) {
    throw errno('EINVAL', `invalid snapshot opId: ${opId}`)
  }
  const pkgBytes = await readTenantFile(join(profileDir, PROFILE_MANIFEST))
  let lockBytes: Buffer | null = null
  try {
    lockBytes = await readTenantFile(join(profileDir, PROFILE_LOCKFILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const root = snapshotsDir(home)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dest = join(root, opId)
  // Refuse to overwrite an existing snapshot id.
  await mkdir(dest, { recursive: false, mode: 0o700 })
  try {
    await writeAtomicFile(join(dest, PROFILE_MANIFEST), pkgBytes)
    if (lockBytes !== null) {
      await writeAtomicFile(join(dest, PROFILE_LOCKFILE), lockBytes)
    }
    await writeAtomicFile(
      join(dest, 'meta.json'),
      Buffer.from(`${JSON.stringify({ at: Date.now() })}\n`, 'utf8'),
    )
  } catch (error) {
    await rm(dest, { recursive: true, force: true })
    throw error
  }
  await rotateSnapshots(home)
  return dest
}

/** Restore both profile files from a prior snapshot (missing lock in snap → leave/remove?). */
export async function restoreSnapshotFiles(
  home: string,
  profileDir: string,
  opId: string,
): Promise<void> {
  const snap = join(snapshotsDir(home), opId)
  const pkgBytes = await readTenantFile(join(snap, PROFILE_MANIFEST))
  let lockBytes: Buffer | null = null
  try {
    lockBytes = await readTenantFile(join(snap, PROFILE_LOCKFILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(join(profileDir, PROFILE_MANIFEST), pkgBytes)
  if (lockBytes !== null) {
    await writeAtomicFile(join(profileDir, PROFILE_LOCKFILE), lockBytes)
  }
}

/** Hash helpers for later server `plugin_profile_snapshot` (hashes only; no server write API). */
export async function snapshotHashes(home: string, opId: string): Promise<SnapshotHashes> {
  const snap = join(snapshotsDir(home), opId)
  const pkg = await readTenantFile(join(snap, PROFILE_MANIFEST))
  let lockSha256: string | null = null
  try {
    const lock = await readTenantFile(join(snap, PROFILE_LOCKFILE))
    lockSha256 = hashBytesSha256(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { manifestSha256: hashBytesSha256(pkg), lockSha256 }
}

/**
 * Queue a user/admin restore for the next reconcile start (never mid-run).
 * Stub only — 1D.6 executes the queue.
 */
export async function queueRestore(
  home: string,
  entry: QueuedRestore,
): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(entry.snapshotId)) {
    throw errno('EINVAL', `invalid snapshotId: ${entry.snapshotId}`)
  }
  if (entry.reason !== 'user' && entry.reason !== 'admin') {
    throw errno('EINVAL', `invalid restore reason: ${String(entry.reason)}`)
  }
  await mkdir(marketDir(home), { recursive: true, mode: 0o700 })
  const line = JSON.stringify({
    snapshotId: entry.snapshotId,
    reason: entry.reason,
    at: entry.at,
  })
  await appendFile(restoreQueuePath(home), `${line}\n`, { mode: 0o600 })
}

/** Read queued restores (1D.6 will consume / execute at reconcile start). */
export async function listQueuedRestores(home: string): Promise<QueuedRestore[]> {
  let text: string
  try {
    text = await readFile(restoreQueuePath(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: QueuedRestore[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) continue
      const row = parsed as Record<string, unknown>
      if (typeof row.snapshotId !== 'string' || typeof row.at !== 'number') continue
      if (row.reason !== 'user' && row.reason !== 'admin') continue
      out.push({ snapshotId: row.snapshotId, reason: row.reason, at: row.at })
    } catch {
      // skip corrupt
    }
  }
  return out
}
