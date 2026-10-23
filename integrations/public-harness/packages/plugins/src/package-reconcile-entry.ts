/**
 * Assemble `reconcile-entry.mjs` (+ plugin-sync / entry libs) into a release or
 * runtime-assets directory. Native units use `${paths.release}/reconcile-entry.mjs`;
 * container one-shot uses `${CONTAINER.assets}/reconcile-entry.mjs`.
 */
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Stable basename consumed by runtime-systemd and provisioner argv. */
export const RECONCILE_ENTRY_FILENAME = 'reconcile-entry.mjs' as const

export interface PackageReconcileEntryOptions {
  /** Destination release or assets root (receives `reconcile-entry.mjs` at top level). */
  readonly destDir: string
  /**
   * Directory that contains `plugins/` and `plugin-sync/` package folders.
   * Defaults to the sibling `packages/` of this module's package root.
   */
  readonly packagesRoot?: string
}

export interface PackageReconcileEntryResult {
  readonly entryPath: string
}

function defaultPackagesRoot(): string {
  // src/ or lib/ → package root → packages/
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

const ENTRY_WRAPPER = `/**
 * Release/assets entry for pre-start reconcile.
 * Invoked as: node <release-or-assets>/reconcile-entry.mjs <planPath> [--market-port=N]
 */
import { pathToFileURL } from 'node:url'
import { main } from './packages/plugins/lib/reconcile-entry-main.js'

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(\`reconcile-entry: \${error instanceof Error ? error.message : String(error)}\\n\`)
      process.exit(1)
    },
  )
}
`

/**
 * Copy built plugin-sync + reconcile-entry libs and write the stable root entry.
 * @returns Absolute path of the packaged `reconcile-entry.mjs`.
 */
export async function packageReconcileEntry(
  options: PackageReconcileEntryOptions,
): Promise<PackageReconcileEntryResult> {
  const packagesRoot = options.packagesRoot ?? defaultPackagesRoot()
  const dest = options.destDir
  const pluginsSrc = join(packagesRoot, 'plugins')
  const syncSrc = join(packagesRoot, 'plugin-sync')
  const pluginsDest = join(dest, 'packages', 'plugins')
  const syncDest = join(dest, 'packages', 'plugin-sync')

  await mkdir(join(pluginsDest, 'lib'), { recursive: true })
  await mkdir(syncDest, { recursive: true })
  await cp(join(pluginsSrc, 'lib', 'reconcile-entry-main.js'), join(pluginsDest, 'lib', 'reconcile-entry-main.js'))
  await cp(join(pluginsSrc, 'lib', 'reconcile-entry.js'), join(pluginsDest, 'lib', 'reconcile-entry.js'))
  await cp(join(pluginsSrc, 'package.json'), join(pluginsDest, 'package.json'))
  await cp(join(syncSrc, 'lib'), join(syncDest, 'lib'), { recursive: true })
  await cp(join(syncSrc, 'package.json'), join(syncDest, 'package.json'))

  // Resolve `@public-harness/plugin-sync` from the packaged plugins lib without
  // clobbering the assets-root `node_modules` → image symlink used by build-assets.
  const linkDir = join(pluginsDest, 'node_modules', '@public-harness')
  await mkdir(linkDir, { recursive: true })
  await symlink(join('..', '..', '..', 'plugin-sync'), join(linkDir, 'plugin-sync'))

  const entryPath = join(dest, RECONCILE_ENTRY_FILENAME)
  await writeFile(entryPath, ENTRY_WRAPPER, { mode: 0o644 })
  return { entryPath }
}

/** CLI: `node package-reconcile-entry.js <destDir>` (used by build-assets.sh). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const destDir = argv[0]
  if (typeof destDir !== 'string' || destDir === '') {
    process.stderr.write('usage: package-reconcile-entry <destDir>\n')
    return 2
  }
  const { entryPath } = await packageReconcileEntry({ destDir })
  process.stdout.write(`${entryPath}\n`)
  return 0
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
