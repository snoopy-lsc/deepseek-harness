// Stamp the shipped native release manifest with the digests of the policy and toolchain trees installed on this host.
// Usage: stamp-manifest.ts <source.json> <out.json> --policy <dir> [--policy <dir>...] --toolchain <dir> [--toolchain <dir>...]
// The source stays untouched; the stamped copy is written atomically (0644). Manifests hold no secrets.
// The output must lie outside every --policy and --toolchain root: a stamped manifest inside a digested tree would
// change that tree's digest the moment it is written, so the stamp could never verify.
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseAnyReleaseManifest, serializeReleaseManifest } from '../../native-release.ts'
import { stampFromInstalledTrees } from './rehearse.ts'

/** Parse arguments, stamp, write.
 * @param argv Arguments after the script name.
 * @returns Process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const positional: string[] = [], policyRoots: string[] = [], toolchainRoots: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--policy' || arg === '--toolchain') {
      const value = argv[++i]
      if (value === undefined) return usage()
      ;(arg === '--policy' ? policyRoots : toolchainRoots).push(value)
    } else positional.push(arg)
  }
  if (positional.length !== 2 || policyRoots.length === 0 || toolchainRoots.length === 0) return usage()
  const [source, out] = positional as [string, string]
  const refusal = await outputRefusal(source, out, [...policyRoots, ...toolchainRoots])
  if (refusal !== undefined) { process.stderr.write(`stamp-manifest: refusing: ${refusal}\n`); return 2 }
  const stamped = await stampFromInstalledTrees(parseAnyReleaseManifest(JSON.parse(await readFile(source, 'utf8'))), { policyRoots, toolchainRoots })
  const tmp = `${out}.tmp-${process.pid}`
  await writeFile(tmp, serializeReleaseManifest(stamped), { mode: 0o644, flag: 'wx' })
  await rename(tmp, out)
  if (stamped.runtime.kind === 'systemd') process.stdout.write(`stamped ${stamped.release}: policy ${stamped.runtime.policyDigest} toolchain ${stamped.runtime.toolchainDigest}\n`)
  return 0
}

// Only a leading `..` segment leaves the root; a child named `..hidden` is still inside it.
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}
const real = (path: string) => realpath(path).catch(() => resolve(path))

/** Why the output path is unsafe, or `undefined` when it may be written.
 * @param source Source manifest path.
 * @param out Requested output path.
 * @param roots Every digested root.
 */
export async function outputRefusal(source: string, out: string, roots: readonly string[]): Promise<string | undefined> {
  if (!isAbsolute(out) || out.endsWith('/') || basename(out) === '.' || basename(out) === '..') return 'the output must be an absolute file path'
  if (roots.some(root => !isAbsolute(root))) return '--policy and --toolchain roots must be absolute'
  const parent = await lstat(dirname(out)).catch(() => undefined)
  if (parent === undefined || !(parent.isDirectory() || parent.isSymbolicLink())) return 'the output directory does not exist'
  const existing = await lstat(out).catch(() => undefined)
  if (existing !== undefined && !existing.isFile()) return 'the output exists and is not a regular file'
  // Compare resolved locations so a symlinked parent cannot smuggle the output into a digested tree.
  const target = join(await real(dirname(out)), basename(out))
  if (target === join(await real(dirname(source)), basename(source))) return 'the output would overwrite the source manifest'
  for (const root of roots) {
    if (inside(resolve(root), resolve(out)) || inside(await real(root), target)) return `the output lies inside the digested tree ${root}`
  }
  return undefined
}

function usage(): number {
  process.stderr.write('usage: stamp-manifest.ts <source.json> <out.json> --policy <dir>... --toolchain <dir>...\n')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code }, (cause: unknown) => {
  process.stderr.write(`stamp-manifest: ${cause instanceof Error ? cause.message : 'failed'}\n`); process.exitCode = 1
})
