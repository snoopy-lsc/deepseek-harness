/** Content-addressed artifact store under `store/sha512/<hex>`; never rewrite. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MirrorError } from './errors.ts'
import type { MirrorState } from '../schema.ts'

/** Refuse remirroring when the version is already `ready`. */
export function assertNotReady(mirrorState: MirrorState | string): void {
  if (mirrorState === 'ready') throw new MirrorError('ready-frozen')
}

/** Path of a blob named by its sha512 hex digest. */
export function blobPath(storeRoot: string, sha512: string): string {
  if (!/^[0-9a-f]{128}$/.test(sha512)) throw new MirrorError('package', 'sha512')
  return join(storeRoot, 'sha512', sha512)
}

/**
 * Write `bytes` at `store/sha512/<sha512>`. Existing same-digest content is
 * idempotent; a different payload at the same digest is refused (`blob-immutable`).
 */
export function storeArtifact(storeRoot: string, sha512: string, bytes: Buffer): void {
  const path = blobPath(storeRoot, sha512)
  if (existsSync(path)) {
    const existing = readFileSync(path)
    if (existing.equals(bytes)) return
    throw new MirrorError('blob-immutable', sha512)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, bytes)
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    if (existsSync(path)) {
      const existing = readFileSync(path)
      if (existing.equals(bytes)) return
      throw new MirrorError('blob-immutable', sha512)
    }
    throw error
  }
}

export function readArtifact(storeRoot: string, sha512: string): Buffer {
  return readFileSync(blobPath(storeRoot, sha512))
}
