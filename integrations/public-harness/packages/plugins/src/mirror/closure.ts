/** Static SemVer scan and lockfile closure validation (before / after pnpm). */
import { MirrorError } from './errors.ts'
import type { InstallScriptKind } from './scripts.ts'

/** One reviewed closure package (lockfile row + script flag). */
export interface ClosurePackage {
  readonly name: string
  readonly version: string
  readonly integrity: string
  /** Null when no install script; otherwise the primary kind string. */
  readonly installScript: string | null
  readonly installScripts?: readonly InstallScriptKind[]
}

/** Exact SemVer 2.0.0 core + optional prerelease + build (lockfile versions). */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** npm `sha512-<base64>` (and rarely sha1/sha256) integrity strings. */
const INTEGRITY = /^(sha512|sha256|sha1)-[A-Za-z0-9+/=]+$/

const NON_SEMVER_PREFIX =
  /^(?:git\+|git:\/\/|ssh:\/\/|https?:\/\/|file:|link:|workspace:|npm:|github:|gist:|bitbucket:|gitlab:)/i

/**
 * True when a dependency specifier is a SemVer range (or exact version), not a
 * git / URL / file / link / workspace / alias source.
 */
export function isSemVerRangeSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed.length === 0 || trimmed.length > 2000) return false
  if (NON_SEMVER_PREFIX.test(trimmed)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false // other protocols
  if (trimmed.includes('://')) return false
  return true
}

/** Refuse non-SemVer dependency specs before any network / pnpm work. */
export function refuseNonSemVerDeps(deps: Readonly<Record<string, string>>): void {
  for (const [name, spec] of Object.entries(deps)) {
    if (!isSemVerRangeSpec(spec)) throw new MirrorError('closure-source', `${name}@${spec}`)
  }
}

/** Validate lockfile-style closure rows: exact SemVer + integrity. */
export function validateClosureEntries(entries: readonly ClosurePackage[]): void {
  for (const entry of entries) {
    if (!EXACT_SEMVER.test(entry.version)) throw new MirrorError('closure-source', `${entry.name}@${entry.version}`)
    if (!INTEGRITY.test(entry.integrity)) throw new MirrorError('closure-source', `${entry.name} integrity`)
  }
}

export function isExactSemVer(version: string): boolean {
  return EXACT_SEMVER.test(version)
}
