/** Artifact mode, digest helpers, and approve-binding compare. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ClosurePackage } from './closure.ts'
import { MirrorError } from './errors.ts'
import { readNpmTarball, stripPackagePrefix, writeNpmTarball } from './tar.ts'

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
  /** Raw closure package tarballs (same order as `closure`); required for bundle mode when closure is non-empty. */
  readonly closureTarballs?: readonly Buffer[]
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/**
 * Repack the plugin as a real npm `.tgz` with the reviewed closure under
 * `node_modules/` and listed in `bundleDependencies` (design § Mirroring step 5).
 * Flat layout is enough for 1A.4; lockfile-driven nest order can land later.
 */
function buildBundleTarball(input: BuildArtifactInput): Buffer {
  if (input.closure.length > 0) {
    if (!input.closureTarballs || input.closureTarballs.length !== input.closure.length) {
      throw new MirrorError('package', 'closure-tarballs')
    }
  }
  const pluginFiles = stripPackagePrefix(readNpmTarball(input.pluginTarball))
  const manifestEntry = pluginFiles.find(f => f.path === 'package.json')
  if (!manifestEntry) throw new MirrorError('package', 'package.json')
  let parsed: unknown
  try { parsed = JSON.parse(manifestEntry.data.toString('utf8')) } catch { throw new MirrorError('package', 'json') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new MirrorError('package', 'json')
  const manifest = { ...(parsed as Record<string, unknown>) }

  const baseFiles = pluginFiles.filter(f => f.path !== 'package.json' && !f.path.startsWith('node_modules/'))
  const packed: { path: string; data: Buffer }[] = []
  const bundledNames: string[] = []
  const exactByName = new Map<string, string>()

  for (let i = 0; i < input.closure.length; i++) {
    const entry = input.closure[i]!
    const tarball = input.closureTarballs![i]!
    verifyIntegrity(tarball, entry.integrity)
    const depFiles = stripPackagePrefix(readNpmTarball(tarball))
    const prefix = `node_modules/${entry.name}`
    for (const file of depFiles) {
      packed.push({ path: `${prefix}/${file.path}`, data: file.data })
    }
    bundledNames.push(entry.name)
    exactByName.set(entry.name, entry.version)
  }

  const dependencies = asStringRecord(manifest.dependencies)
  for (const [name, version] of exactByName) {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) dependencies[name] = version
  }
  const nextManifest: Record<string, unknown> = {
    ...manifest,
    bundleDependencies: bundledNames,
  }
  delete nextManifest.bundledDependencies
  if (Object.keys(dependencies).length > 0) nextManifest.dependencies = dependencies

  packed.push({ path: 'package.json', data: Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8') })
  for (const file of baseFiles) packed.push({ path: file.path, data: file.data })
  packed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return writeNpmTarball(packed)
}

/**
 * Build the pinned artifact bytes.
 * - fallback: the original plugin tarball (reviewed upstream bytes).
 * - bundle: npm pack with reviewed closure under `bundleDependencies` / `node_modules`.
 */
export function buildArtifact(input: BuildArtifactInput): { bytes: Buffer; sha512: string; mode: ArtifactMode } {
  const bytes = input.mode === 'fallback'
    ? input.pluginTarball
    : buildBundleTarball(input)
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new MirrorError('artifact-too-large', String(bytes.length))
  return { bytes, sha512: sha512Hex(bytes), mode: input.mode }
}
