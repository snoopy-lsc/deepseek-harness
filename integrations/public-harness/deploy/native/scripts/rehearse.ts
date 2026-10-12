/** Dedicated-host rehearsal runner: runs registered real-host checks and writes evidence bound to this host, release,
 * policy and toolchain. It refuses to run without an explicit opt-in, and evidence from a run with any skipped or
 * simulated check is marked `realHost: false`, which the release validator rejects. */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { arch, release as kernelRelease } from 'node:os'
import { join } from 'node:path'
import { NATIVE_CHECKS, nativeHostId, type NativeCheck, type NativeEvidence, type NativeReleaseManifest } from '../../native-release.ts'

/** Result of one check: `skipped` when its preconditions are not met on this host. */
export type CheckOutcome = { readonly result: 'passed' | 'failed' | 'skipped'; readonly observed: string }
/** One real-host check. Implementations must observe the allowed or denied operation, never configuration text alone. */
export type NativeCheckRunner = () => Promise<CheckOutcome>

/** Rehearsal inputs. */
export interface RehearsalOptions {
  readonly manifest: NativeReleaseManifest
  /** Trees whose content defines the effective policy (units, AppArmor templates, nftables, Caddyfile). */
  readonly policyRoots: readonly string[]
  /** Trees whose content defines the toolchain (Node, release, pinned browser). */
  readonly toolchainRoots: readonly string[]
  readonly checks: Partial<Readonly<Record<NativeCheck, NativeCheckRunner>>>
  readonly machineIdFile?: string
  readonly env?: NodeJS.ProcessEnv
  readonly clock?: () => number
}

/** Digest a set of trees without following links: path, type, mode, owner and content (or link target) of every entry.
 * @param roots Absolute roots.
 * @returns `sha256:<hex>`.
 */
export async function treeDigest(roots: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    hash.update(`${path}\0${info.mode}\0${info.uid}:${info.gid}\0`)
    if (info.isSymbolicLink()) hash.update(`link\0${await readlink(path)}\0`)
    else if (info.isFile()) hash.update(createHash('sha256').update(await readFile(path)).digest('hex'))
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name))
  }
  for (const root of [...roots].sort()) await walk(root)
  return `sha256:${hash.digest('hex')}`
}

/** Run the rehearsal and return evidence; the caller writes it with `writeEvidence`.
 * @param options Manifest, digest roots and check registry.
 * @returns Evidence plus each check's observation (never secrets).
 */
export async function runNativeRehearsal(options: RehearsalOptions): Promise<{ evidence: NativeEvidence; observations: Record<string, string> }> {
  const env = options.env ?? process.env
  // Destructive real-host checks create accounts, firewall rules and resource pressure: never on a developer or shared machine.
  if (env.DSH_NATIVE_REHEARSAL !== 'dedicated-host') throw new Error('set DSH_NATIVE_REHEARSAL=dedicated-host on a dedicated Ubuntu 24.04 host')
  if (options.manifest.runtime.kind !== 'systemd') throw new Error('rehearsal requires a systemd release manifest')
  const [policyDigest, toolchainDigest] = [await treeDigest(options.policyRoots), await treeDigest(options.toolchainRoots)]
  if (policyDigest !== options.manifest.runtime.policyDigest) throw new Error('installed policy does not match the manifest')
  if (toolchainDigest !== options.manifest.runtime.toolchainDigest) throw new Error('installed toolchain does not match the manifest')
  const checks = {} as Record<NativeCheck, 'passed' | 'failed'>, observations: Record<string, string> = {}
  let complete = true
  for (const name of NATIVE_CHECKS) {
    const runner = options.checks[name]
    const outcome: CheckOutcome = runner === undefined ? { result: 'skipped', observed: 'no runner registered' }
      : await runner().catch((error: unknown) => ({ result: 'failed' as const, observed: error instanceof Error ? error.message : String(error) }))
    if (outcome.result === 'skipped') complete = false
    checks[name] = outcome.result === 'passed' ? 'passed' : 'failed'
    observations[name] = `${outcome.result}: ${outcome.observed}`.slice(0, 500)
  }
  const hostId = nativeHostId(await readFile(options.machineIdFile ?? '/etc/machine-id', 'utf8'))
  return { observations, evidence: { schema: 1, backend: 'systemd', hostId, release: options.manifest.release, policyDigest, toolchainDigest,
    architecture: arch(), kernel: kernelRelease(), checks, verifiedAt: (options.clock ?? Date.now)(), realHost: complete } }
}

/** Write evidence as a private file.
 * @param path Destination.
 * @param evidence Evidence from `runNativeRehearsal`.
 */
export async function writeEvidence(path: string, evidence: NativeEvidence): Promise<void> {
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
}
