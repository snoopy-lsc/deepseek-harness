/** Plugin market mirror pipeline: resolve → closure → scripts → artifact → store. */
import type { ClosurePackage } from './closure.ts'
import { validateClosureEntries } from './closure.ts'
import { buildArtifact, chooseArtifactMode, verifyIntegrity } from './artifact.ts'
import { MirrorError } from './errors.ts'
import { resolveUpload, resolveNpmVersion, type ResolvedPackage } from './resolve.ts'
import { assertNotReady, storeArtifact } from './store.ts'
import type { MirrorState } from '../schema.ts'

export { MirrorError, type MirrorErrorCode } from './errors.ts'
export {
  refuseNonSemVerDeps,
  validateClosureEntries,
  isSemVerRangeSpec,
  isExactSemVer,
  type ClosurePackage,
} from './closure.ts'
export {
  detectInstallScripts,
  primaryInstallScript,
  type InstallScriptKind,
  type PackageManifest,
} from './scripts.ts'
export {
  sha512Hex,
  sha512Integrity,
  verifyIntegrity,
  chooseArtifactMode,
  compareExpectedArtifactSha512,
  buildArtifact,
  MAX_ARTIFACT_BYTES,
  type ArtifactMode,
  type BuildArtifactInput,
} from './artifact.ts'
export { assertNotReady, storeArtifact, readArtifact, blobPath } from './store.ts'
export {
  resolveUpload,
  resolveNpmVersion,
  type ResolvedPackage,
  type Packument,
  type PackumentVersion,
  type ResolveNpmOptions,
} from './resolve.ts'
export { readNpmTarball, readUstar, stripPackagePrefix, MAX_UPLOAD_ENTRIES, MAX_UNPACKED_BYTES } from './tar.ts'

export type MirrorSource =
  | { readonly type: 'upload'; readonly tarball: Buffer }
  | { readonly type: 'resolved'; readonly package: ResolvedPackage }
  | {
      readonly type: 'npm'
      readonly packument: import('./resolve.ts').Packument
      readonly version: string
      readonly registryHost: string
      readonly fetchTarball: (url: string) => Promise<Buffer>
      readonly requireCompanyScope?: boolean
    }

export interface MirrorVersionInput {
  readonly source: MirrorSource
  readonly storeRoot: string
  /** Injected closure (from lockfile parse / fixtures). Live pnpm is optional/serial elsewhere. */
  readonly closure: readonly ClosurePackage[]
  /** Fetch each closure tarball to verify integrity; defaults to no-op when integrity already trusted. */
  readonly fetchClosureTarball?: (entry: ClosurePackage) => Promise<Buffer>
  /** Current `plugin_version.mirror_state`; `ready` refuses remirror. */
  readonly mirrorState?: MirrorState | string
}

export interface MirrorVersionResult {
  readonly artifactSha512: string
  readonly mode: 'bundle' | 'fallback'
  readonly closure: readonly ClosurePackage[]
  readonly name: string
  readonly version: string
  readonly upstreamIntegrity: string | null
  readonly sizeBytes: number
}

async function resolveSource(source: MirrorSource): Promise<ResolvedPackage> {
  switch (source.type) {
    case 'upload':
      return resolveUpload(source.tarball)
    case 'resolved':
      return source.package
    case 'npm':
      return resolveNpmVersion(source.packument, source.version, {
        registryHost: source.registryHost,
        fetchTarball: source.fetchTarball,
        requireCompanyScope: source.requireCompanyScope,
      })
    default: {
      const _exhaustive: never = source
      throw new MirrorError('package', String(_exhaustive))
    }
  }
}

/**
 * Mirror one version into the content-addressed store.
 * Closure must be supplied (fixtures or a prior `pnpm install --lockfile-only` parse).
 */
export async function mirrorVersion(input: MirrorVersionInput): Promise<MirrorVersionResult> {
  assertNotReady(input.mirrorState ?? 'queued')
  const resolved = await resolveSource(input.source)
  validateClosureEntries(input.closure)

  const closureTarballs: Buffer[] = []
  if (input.fetchClosureTarball) {
    for (const entry of input.closure) {
      const bytes = await input.fetchClosureTarball(entry)
      verifyIntegrity(bytes, entry.integrity)
      closureTarballs.push(bytes)
    }
  }

  const mode = chooseArtifactMode(input.closure)
  const artifact = buildArtifact({
    mode,
    pluginTarball: resolved.tarball,
    closure: input.closure,
    closureTarballs: closureTarballs.length > 0 ? closureTarballs : undefined,
  })
  storeArtifact(input.storeRoot, artifact.sha512, artifact.bytes)
  return {
    artifactSha512: artifact.sha512,
    mode: artifact.mode,
    closure: input.closure,
    name: resolved.name,
    version: resolved.version,
    upstreamIntegrity: resolved.upstreamIntegrity,
    sizeBytes: artifact.bytes.length,
  }
}
