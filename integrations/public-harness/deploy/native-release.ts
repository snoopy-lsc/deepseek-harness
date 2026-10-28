/** Native release manifests and real-host evidence: enrollment opens only on evidence bound to this host, release, policy and toolchain. */
import { createHash } from 'node:crypto'
import { parseReleaseManifest, type ReleaseManifest, type ReleaseSet } from './upgrade.ts'

/** Native runtime of a release. Both digests are `null` in an unstamped source manifest (the one in the repository) and are
 * stamped from the installed policy and toolchain trees; an unstamped manifest can never admit a host or run a rehearsal. */
export type SystemdRuntimeRelease =
  | { readonly kind: 'systemd'; readonly policyDigest: string; readonly toolchainDigest: string }
  | { readonly kind: 'systemd'; readonly policyDigest: null; readonly toolchainDigest: null }
/** Frozen container runtime of a release (Podman + gVisor): maintained, no new features. */
export type ContainerRuntimeRelease = { readonly kind: 'podman-gvisor'; readonly image: string }
/** Runtime a release targets; a container release can never satisfy a native admission and vice versa. */
export type RuntimeRelease = SystemdRuntimeRelease | ContainerRuntimeRelease

/** Schema 2 manifest: the runtime is tagged; Harness/plugin pins, the prior release and closed enrollment are kept.
 * `deploy/release-manifest.json` is the native mainline manifest; `deploy/production/release-manifest.json` is the frozen container one. */
export interface NativeReleaseManifest extends Omit<ReleaseSet, 'image'> {
  readonly schema: 2
  readonly runtime: RuntimeRelease
  readonly previous: (Omit<ReleaseSet, 'image'> & { readonly runtime: RuntimeRelease }) | null
  readonly publicEnrollment: 'closed'
}

/** Real-host checks from deployment plan Task 3; every one must pass. */
export const NATIVE_CHECKS = ['tools', 'files', 'processes', 'network', 'resources', 'recovery', 'failures', 'upgrade-restore'] as const
/** One required real-host check. */
export type NativeCheck = typeof NATIVE_CHECKS[number]
/** Host identity derived from root-controlled `/etc/machine-id`, never from request or evidence fields. */
export type NativeHostId = string & { readonly __brand: 'NativeHostId' }

/** Evidence written by the rehearsal on the dedicated host. */
export interface NativeEvidence {
  readonly schema: 1
  readonly backend: 'systemd'
  readonly hostId: NativeHostId
  readonly release: string
  readonly policyDigest: string
  readonly toolchainDigest: string
  readonly architecture: string
  readonly kernel: string
  readonly checks: Readonly<Record<NativeCheck, 'passed' | 'failed'>>
  readonly verifiedAt: number
  /** True only when every check really ran; a simulated or skipped run sets false. */
  readonly realHost: boolean
}

const DIGEST = /^sha256:[0-9a-f]{64}$/

/** Whether a native runtime carries real digests.
 * @param runtime Runtime of a manifest.
 * @returns True when both digests are stamped.
 */
export function isStamped(runtime: RuntimeRelease): runtime is { readonly kind: 'systemd'; readonly policyDigest: string; readonly toolchainDigest: string } {
  return runtime.kind === 'systemd' && runtime.policyDigest !== null && runtime.toolchainDigest !== null
}

/** Derive the host ID from the machine ID.
 * @param machineId Contents of `/etc/machine-id`.
 * @returns Branded host ID.
 */
export function nativeHostId(machineId: string): NativeHostId {
  const id = machineId.trim()
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('machine-id is malformed')
  return `host-${createHash('sha256').update(`dsh-native\0${id}`).digest('hex').slice(0, 32)}` as NativeHostId
}

function runtime(value: unknown, context: string): RuntimeRelease {
  const r = value as Record<string, unknown> | null
  if (r?.kind === 'systemd' && Object.keys(r).sort().join(',') === 'kind,policyDigest,toolchainDigest') {
    if (typeof r.policyDigest === 'string' && DIGEST.test(r.policyDigest) && typeof r.toolchainDigest === 'string' && DIGEST.test(r.toolchainDigest)) {
      return { kind: 'systemd', policyDigest: r.policyDigest, toolchainDigest: r.toolchainDigest }
    }
    // Unstamped source manifest: both digests absent together, never one of them.
    if (r.policyDigest === null && r.toolchainDigest === null) return { kind: 'systemd', policyDigest: null, toolchainDigest: null }
  }
  if (r?.kind === 'podman-gvisor' && Object.keys(r).sort().join(',') === 'image,kind' && typeof r.image === 'string' && /[:@]/.test(r.image)) {
    return { kind: 'podman-gvisor', image: r.image }
  }
  throw new Error(`${context}.runtime is invalid`)
}

/** Parse either schema: v1 is the legacy container manifest and stays container-only; v2 carries a tagged runtime.
 * @param value Parsed manifest JSON.
 * @returns A v2 manifest (v1 is lifted with `runtime.kind = podman-gvisor`).
 */
export function parseAnyReleaseManifest(value: unknown): NativeReleaseManifest {
  const record = value as Record<string, unknown> | null
  if (record?.schema === 1) {
    const legacy: ReleaseManifest = parseReleaseManifest(value)
    const lift = (set: ReleaseSet) => ({ release: set.release, harness: set.harness, pluginApi: set.pluginApi, bundles: set.bundles, runtime: { kind: 'podman-gvisor' as const, image: set.image } })
    return { schema: 2, ...lift(legacy), previous: legacy.previous === null ? null : lift(legacy.previous), publicEnrollment: 'closed' }
  }
  if (record?.schema !== 2) throw new Error('unsupported manifest schema')
  const keys = ['schema', 'release', 'harness', 'runtime', 'pluginApi', 'bundles', 'previous', 'publicEnrollment']
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error('manifest has unexpected or missing fields')
  if (record.publicEnrollment !== 'closed') throw new Error('the manifest cannot open public enrollment; use the release check')
  // Reuse the v1 pin validation by checking the same fields with a placeholder image.
  const pins = (set: Record<string, unknown>, context: string) => {
    const parsed = parseReleaseManifest({ schema: 1, release: set.release, harness: set.harness, image: 'placeholder:pin-check', pluginApi: set.pluginApi,
      bundles: set.bundles, previous: null, publicEnrollment: 'closed' })
    return { release: parsed.release, harness: parsed.harness, pluginApi: parsed.pluginApi, bundles: parsed.bundles, runtime: runtime(set.runtime, context) }
  }
  const previous = record.previous === null ? null : pins(record.previous as Record<string, unknown>, 'previous')
  return { schema: 2, ...pins(record, 'manifest'), previous, publicEnrollment: 'closed' }
}

/** Narrow a manifest to one runtime; tools of the other runtime refuse it.
 * @param manifest Parsed schema 2 manifest.
 * @param kind Runtime the caller operates.
 * @returns The same manifest with a narrowed runtime.
 */
export function requireRuntime<K extends RuntimeRelease['kind']>(manifest: NativeReleaseManifest, kind: K): NativeReleaseManifest & { readonly runtime: Extract<RuntimeRelease, { kind: K }> } {
  if (manifest.runtime.kind !== kind) throw new Error(`expected a ${kind} release, got a ${manifest.runtime.kind} release`)
  return manifest as NativeReleaseManifest & { readonly runtime: Extract<RuntimeRelease, { kind: K }> }
}

/** Return a copy of a native manifest with stamped digests; the source manifest and every pin are unchanged.
 * @param manifest Native (systemd) manifest, stamped or not.
 * @param digests `sha256:<hex>` digests of the installed policy and toolchain trees (see `treeDigest`).
 * @returns Stamped manifest.
 */
export function stampNativeManifest(manifest: NativeReleaseManifest, digests: { readonly policyDigest: string; readonly toolchainDigest: string }): NativeReleaseManifest {
  if (manifest.runtime.kind !== 'systemd') throw new Error('only a systemd release manifest can be stamped')
  if (!DIGEST.test(digests.policyDigest) || !DIGEST.test(digests.toolchainDigest)) throw new Error('stamp digests must be sha256:<64 hex>')
  return { ...manifest, runtime: { kind: 'systemd', policyDigest: digests.policyDigest, toolchainDigest: digests.toolchainDigest } }
}

/** Serialize a schema 2 manifest in the shipped key order with a trailing newline.
 * @param manifest Parsed manifest.
 * @returns JSON text.
 */
export function serializeReleaseManifest(manifest: NativeReleaseManifest): string {
  const set = (value: Omit<ReleaseSet, 'image'> & { readonly runtime: RuntimeRelease }) => ({ release: value.release, harness: value.harness, runtime: value.runtime,
    pluginApi: value.pluginApi, bundles: value.bundles })
  return `${JSON.stringify({ schema: 2, ...set(manifest), previous: manifest.previous === null ? null : set(manifest.previous), publicEnrollment: manifest.publicEnrollment }, null, 2)}\n`
}

/** Refuse admission unless the evidence is real, complete, passing and bound to this host, release, policy and toolchain.
 * @param manifest Manifest being admitted.
 * @param evidence Untrusted evidence file contents.
 * @param hostId This host's ID, computed locally.
 * @param context Current time and the maximum evidence age.
 * @returns The validated evidence; throws with every reason otherwise.
 */
export function validateNativeEvidence(manifest: NativeReleaseManifest, evidence: unknown, hostId: NativeHostId,
  context: { readonly now: number; readonly maxAgeMs: number }): NativeEvidence {
  const reasons: string[] = []
  if (manifest.runtime.kind !== 'systemd') throw new Error('native evidence cannot admit a container release')
  if (!isStamped(manifest.runtime)) throw new Error('native admission refused: the release manifest is not stamped with policy and toolchain digests')
  const stamped = manifest.runtime
  const e = evidence as Record<string, unknown> | null
  const keys = ['schema', 'backend', 'hostId', 'release', 'policyDigest', 'toolchainDigest', 'architecture', 'kernel', 'checks', 'verifiedAt', 'realHost']
  if (e === null || typeof e !== 'object' || Object.keys(e).sort().join(',') !== [...keys].sort().join(',') || e.schema !== 1) throw new Error('native evidence is missing or malformed')
  if (e.backend !== 'systemd') reasons.push('evidence is not from the systemd backend')
  if (e.realHost !== true) reasons.push('evidence is simulated or skipped')
  if (e.hostId !== hostId) reasons.push('evidence was recorded on another host')
  if (e.release !== manifest.release) reasons.push('evidence is for another release')
  if (e.policyDigest !== stamped.policyDigest) reasons.push('policy changed since the evidence was recorded')
  if (e.toolchainDigest !== stamped.toolchainDigest) reasons.push('toolchain changed since the evidence was recorded')
  if (typeof e.architecture !== 'string' || !e.architecture || typeof e.kernel !== 'string' || !e.kernel) reasons.push('host architecture or kernel is missing')
  const checks = e.checks as Record<string, unknown> | null
  if (checks === null || typeof checks !== 'object') reasons.push('checks are missing')
  else {
    for (const name of Object.keys(checks)) if (!(NATIVE_CHECKS as readonly string[]).includes(name)) reasons.push(`unknown check ${name.slice(0, 40)}`)
    for (const name of NATIVE_CHECKS) if (checks[name] !== 'passed') reasons.push(`check ${name} ${checks[name] === 'failed' ? 'failed' : 'is missing'}`)
  }
  if (typeof e.verifiedAt !== 'number' || !Number.isSafeInteger(e.verifiedAt) || e.verifiedAt > context.now + 60_000) reasons.push('evidence time is invalid')
  else if (context.now - e.verifiedAt > context.maxAgeMs) reasons.push('evidence is stale')
  if (reasons.length) throw new Error(`native admission refused: ${reasons.join('; ')}`)
  const valid = checks as Record<NativeCheck, 'passed'>
  return { schema: 1, backend: 'systemd', hostId, release: manifest.release, policyDigest: stamped.policyDigest, toolchainDigest: stamped.toolchainDigest,
    architecture: String(e.architecture), kernel: String(e.kernel), checks: Object.fromEntries(NATIVE_CHECKS.map(name => [name, valid[name]])) as Record<NativeCheck, 'passed'>,
    verifiedAt: Number(e.verifiedAt), realHost: true }
}
