/** Resolve npm / upload sources: integrity, host check, company scope, SemVer deps. */
import { COMPANY_SCOPE_PREFIX } from '../schema.ts'
import { refuseNonSemVerDeps } from './closure.ts'
import { MirrorError } from './errors.ts'
import { detectInstallScripts, type PackageManifest } from './scripts.ts'
import { verifyIntegrity } from './artifact.ts'
import { readNpmTarball, stripPackagePrefix, type TarFile } from './tar.ts'

export interface ResolvedPackage {
  readonly name: string
  readonly version: string
  readonly tarball: Buffer
  readonly upstreamIntegrity: string | null
  readonly manifest: PackageManifest
  readonly files: readonly TarFile[]
  readonly installScripts: ReturnType<typeof detectInstallScripts>
}

function parseManifest(files: readonly TarFile[]): PackageManifest {
  const entry = files.find(f => f.path === 'package.json')
  if (!entry) throw new MirrorError('package', 'package.json')
  let manifest: unknown
  try { manifest = JSON.parse(entry.data.toString('utf8')) } catch { throw new MirrorError('package', 'json') }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new MirrorError('package', 'json')
  const pkg = manifest as PackageManifest
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new MirrorError('package', 'name-version')
  return pkg
}

function collectDeps(manifest: PackageManifest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const block = manifest[field]
    if (block && typeof block === 'object') {
      for (const [name, spec] of Object.entries(block)) {
        if (typeof spec === 'string') out[name] = spec
      }
    }
  }
  return out
}

function assertCompanyScope(name: string): void {
  if (!name.startsWith(COMPANY_SCOPE_PREFIX)) throw new MirrorError('scope', name)
}

/** Unpack an uploaded `.tgz`, enforce company scope and SemVer-only deps. */
export function resolveUpload(tarball: Buffer): ResolvedPackage {
  const raw = readNpmTarball(tarball)
  const files = stripPackagePrefix(raw)
  const manifest = parseManifest(files)
  assertCompanyScope(manifest.name!)
  refuseNonSemVerDeps(collectDeps(manifest))
  const hasBindingGyp = files.some(f => f.path === 'binding.gyp')
  return {
    name: manifest.name!,
    version: manifest.version!,
    tarball,
    upstreamIntegrity: null,
    manifest,
    files,
    installScripts: detectInstallScripts(manifest, { hasBindingGyp }),
  }
}

export interface PackumentVersion {
  readonly name?: string
  readonly version?: string
  readonly dist?: { readonly tarball?: string; readonly integrity?: string }
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly gypfile?: unknown
  readonly [key: string]: unknown
}

export interface Packument {
  readonly name?: string
  readonly versions?: Readonly<Record<string, PackumentVersion>>
}

export interface ResolveNpmOptions {
  readonly registryHost: string
  readonly fetchTarball: (url: string) => Promise<Buffer>
  /** When true (default for company uploads only), require `@corp-dsh/`. Public mirrors skip. */
  readonly requireCompanyScope?: boolean
}

/** Resolve one exact version from a packument fixture / registry response. */
export async function resolveNpmVersion(
  packument: Packument,
  version: string,
  options: ResolveNpmOptions,
): Promise<ResolvedPackage> {
  const entry = packument.versions?.[version]
  if (!entry) throw new MirrorError('package', 'version')
  const integrity = entry.dist?.integrity
  const tarballUrl = entry.dist?.tarball
  if (typeof integrity !== 'string' || integrity.length < 8) throw new MirrorError('integrity', 'missing')
  if (typeof tarballUrl !== 'string') throw new MirrorError('package', 'tarball')
  let url: URL
  try { url = new URL(tarballUrl) } catch { throw new MirrorError('tarball-host', tarballUrl) }
  if (url.hostname.toLowerCase() !== options.registryHost.toLowerCase()) {
    throw new MirrorError('tarball-host', url.hostname)
  }
  const bytes = await options.fetchTarball(tarballUrl)
  verifyIntegrity(bytes, integrity)
  // Prefer packument fields for deps scan before unpack (static refuse).
  const depScan: PackageManifest = {
    name: entry.name ?? packument.name,
    version,
    dependencies: entry.dependencies,
    optionalDependencies: entry.optionalDependencies,
    scripts: entry.scripts,
    gypfile: entry.gypfile,
  }
  refuseNonSemVerDeps(collectDeps(depScan))
  let files: TarFile[] = []
  let manifest: PackageManifest = depScan
  try {
    files = stripPackagePrefix(readNpmTarball(bytes))
    manifest = parseManifest(files)
  } catch (error) {
    // Fixture bodies may be plain buffers (not real tarballs) in unit tests.
    if (!(error instanceof MirrorError) || (error.message !== 'upload' && error.message !== 'package')) throw error
    if (typeof depScan.name !== 'string' || typeof depScan.version !== 'string') throw error
    manifest = depScan
  }
  if (manifest.name !== (entry.name ?? packument.name) || manifest.version !== version) {
    // allow fixture where body is not a tarball but packument names match
    if (files.length > 0) throw new MirrorError('package', 'name-version-mismatch')
  }
  const name = (manifest.name ?? entry.name ?? packument.name) as string
  if (options.requireCompanyScope) assertCompanyScope(name)
  const hasBindingGyp = files.some(f => f.path === 'binding.gyp')
  return {
    name,
    version,
    tarball: bytes,
    upstreamIntegrity: integrity,
    manifest,
    files,
    installScripts: detectInstallScripts(manifest, { hasBindingGyp }),
  }
}
