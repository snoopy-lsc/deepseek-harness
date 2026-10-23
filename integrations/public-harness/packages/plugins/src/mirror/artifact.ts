/** Artifact mode, digest helpers, and approve-binding compare. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ClosurePackage } from './closure.ts'
import { MirrorError } from './errors.ts'

export type ArtifactMode = 'bundle' | 'fallback'

/** 200 MiB design cap for one version's artifact. */
export const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024

/** Hex sha512 of bytes (store key / artifact_sha512). */
export function sha512Hex(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('hex')
}

/** npm-style `sha512-<base64>` integrity string. */
export function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** Verify bytes against an npm integrity string (`sha512-…`). */
export function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity)
  if (!match) throw new MirrorError('integrity', 'format')
  const algo = match[1]!
  const expected = Buffer.from(match[2]!, 'base64')
  const actual = createHash(algo).update(bytes).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new MirrorError('integrity')
  }
}

/**
 * Bundle when the closure has no install scripts (P0.3: nested bundled scripts
 * do not run under pnpm; phase 1 only bundles script-free closures).
 */
export function chooseArtifactMode(closure: readonly ClosurePackage[]): ArtifactMode {
  for (const entry of closure) {
    if (entry.installScript !== null && entry.installScript !== '') return 'fallback'
    if (entry.installScripts && entry.installScripts.length > 0) return 'fallback'
  }
  return 'bundle'
}

/**
 * Approve-binding helper (1C will call this): 409 `artifact-mismatch` when the
 * digest shown on the review page differs from the stored artifact.
 */
export function compareExpectedArtifactSha512(expected: string, stored: string): void {
  if (typeof expected !== 'string' || typeof stored !== 'string') throw new MirrorError('artifact-mismatch')
  if (!/^[0-9a-f]{128}$/.test(expected) || !/^[0-9a-f]{128}$/.test(stored)) throw new MirrorError('artifact-mismatch')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new MirrorError('artifact-mismatch')
}

export interface BuildArtifactInput {
  readonly mode: ArtifactMode
  readonly pluginTarball: Buffer
  readonly closure: readonly ClosurePackage[]
  /** Optional raw closure tarballs (same order as `closure`); used for provenance pinning. */
  readonly closureTarballs?: readonly Buffer[]
}

/**
 * Build the pinned artifact bytes.
 * - fallback: the original plugin tarball (reviewed upstream bytes).
 * - bundle: deterministic envelope with mode, plugin digest, and closure pins
 *   (full `bundleDependencies` layout lands when fetch handlers pack for serve;
 *   digest stability is what approve binds to).
 */
export function buildArtifact(input: BuildArtifactInput): { bytes: Buffer; sha512: string; mode: ArtifactMode } {
  let bytes: Buffer
  if (input.mode === 'fallback') {
    bytes = input.pluginTarball
  } else {
    const pins = input.closure.map((entry, i) => ({
      name: entry.name,
      version: entry.version,
      integrity: entry.integrity,
      sha512: input.closureTarballs?.[i] ? sha512Hex(input.closureTarballs[i]!) : null,
    }))
    const header = Buffer.from(JSON.stringify({
      dshArtifact: 1,
      mode: 'bundle',
      pluginSha512: sha512Hex(input.pluginTarball),
      closure: pins,
    }), 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(header.length, 0)
    bytes = Buffer.concat([Buffer.from('DSHB'), len, header, input.pluginTarball])
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new MirrorError('artifact-too-large', String(bytes.length))
  return { bytes, sha512: sha512Hex(bytes), mode: input.mode }
}
