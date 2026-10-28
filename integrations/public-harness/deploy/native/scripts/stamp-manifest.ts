// Stamp the shipped native release manifest with the digests of the policy and toolchain trees installed on this host.
// Usage: stamp-manifest.ts <source.json> <out.json> --policy <dir> [--policy <dir>...] --toolchain <dir> [--toolchain <dir>...]
// The source stays untouched; the stamped copy is written atomically (0644). Manifests hold no secrets.
import { readFile, rename, writeFile } from 'node:fs/promises'
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
  if (source === out) { process.stderr.write('stamp-manifest: refusing to overwrite the source manifest\n'); return 2 }
  const stamped = await stampFromInstalledTrees(parseAnyReleaseManifest(JSON.parse(await readFile(source, 'utf8'))), { policyRoots, toolchainRoots })
  const tmp = `${out}.tmp-${process.pid}`
  await writeFile(tmp, serializeReleaseManifest(stamped), { mode: 0o644, flag: 'wx' })
  await rename(tmp, out)
  if (stamped.runtime.kind === 'systemd') process.stdout.write(`stamped ${stamped.release}: policy ${stamped.runtime.policyDigest} toolchain ${stamped.runtime.toolchainDigest}\n`)
  return 0
}

function usage(): number {
  process.stderr.write('usage: stamp-manifest.ts <source.json> <out.json> --policy <dir>... --toolchain <dir>...\n')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code }, (cause: unknown) => {
  process.stderr.write(`stamp-manifest: ${cause instanceof Error ? cause.message : 'failed'}\n`); process.exitCode = 1
})
