/** Install-script detection for a package manifest and optional binding.gyp. */

export type InstallScriptKind =
  | 'preinstall'
  | 'install'
  | 'postinstall'
  | 'prepare'
  | 'gypfile'
  | 'binding.gyp'

export interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly gypfile?: unknown
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly bundleDependencies?: readonly string[]
  readonly bundledDependencies?: readonly string[]
  readonly [key: string]: unknown
}

const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** Return which install-script signals are present (design § Detect install scripts). */
export function detectInstallScripts(
  manifest: PackageManifest,
  options: { readonly hasBindingGyp?: boolean } = {},
): InstallScriptKind[] {
  const found: InstallScriptKind[] = []
  const scripts = manifest.scripts
  if (scripts && typeof scripts === 'object') {
    for (const key of SCRIPT_KEYS) {
      const value = scripts[key]
      if (typeof value === 'string' && value.length > 0) found.push(key)
    }
  }
  if (manifest.gypfile === true || manifest.gypfile === 'true') found.push('gypfile')
  if (options.hasBindingGyp) found.push('binding.gyp')
  return found
}

/** Collapse detected kinds to the primary label stored on `plugin_closure.install_script`. */
export function primaryInstallScript(kinds: readonly InstallScriptKind[]): string | null {
  return kinds[0] ?? null
}
