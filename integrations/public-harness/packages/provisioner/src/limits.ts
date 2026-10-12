/** Mandatory per-instance resource limits; every missing or unenforceable limit refuses the start. */
import { isAbsolute } from 'node:path'
import { runChecked, type CommandRunner } from './system.ts'

/** All limits are required and positive; there are no defaults that silently mean "unlimited". */
export interface Limits {
  readonly cpus: number
  readonly memoryBytes: number
  readonly pids: number
  readonly openFiles: number
  readonly diskBytes: number
  /** Isolated user-space network stack: exactly `pasta` or `slirp4netns`. The provisioner builds the full podman argument. */
  readonly network: string
}

/** A mandatory limit is absent, malformed, or the host cannot enforce it. */
export class LimitsError extends Error {
  override readonly name = 'LimitsError'
  constructor(reason: string) { super(`resource limits: ${reason}`) }
}

/**
 * Smallest accepted limits. Under gVisor the pids limit counts the sandbox's own host threads (about 45 idle, roughly
 * 2-3 more per guest process), not guest processes, and exhausting the pids limit killed the whole sandbox in lab
 * runs (exceeding memory did so in one run but not another). Values below these leave no room for the Harness itself.
 */
export const MIN_PIDS = 256
export const MIN_MEMORY_BYTES = 512 << 20

/** cgroup v2 controllers the account's user manager must delegate; rootless podman with runsc did not start without all six. */
export const REQUIRED_CONTROLLERS = ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] as const

const REQUIRED = ['cpus', 'memoryBytes', 'pids', 'openFiles', 'diskBytes'] as const

/** Validate configuration shape before touching the host. */
export function validateLimits(value: unknown): Limits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LimitsError('missing')
  const record = value as Record<string, unknown>
  for (const key of REQUIRED) {
    const field = record[key]
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) throw new LimitsError(`${key} must be positive`)
    if (key !== 'cpus' && !Number.isSafeInteger(field)) throw new LimitsError(`${key} must be an integer`)
  }
  if (Number(record.memoryBytes) < MIN_MEMORY_BYTES) throw new LimitsError('memoryBytes below 512 MiB')
  if (Number(record.pids) < MIN_PIDS) throw new LimitsError(`pids below ${MIN_PIDS}`)
  const network = record.network
  if (network !== 'pasta' && network !== 'slirp4netns') throw new LimitsError('network must be exactly pasta or slirp4netns')
  return { cpus: Number(record.cpus), memoryBytes: Number(record.memoryBytes), pids: Number(record.pids),
    openFiles: Number(record.openFiles), diskBytes: Number(record.diskBytes), network }
}

/**
 * The `--network` argument for an instance. pasta must run with `--no-splice`: with the default splice path the published
 * sidecar port answers with resets under gVisor (observed with passt 2025-05-03). `--map-host-loopback` is what lets the
 * instance reach the quota proxy at `hostAddress`. Options are fixed here, never taken from configuration.
 */
export function networkArgument(network: Limits['network'], hostAddress: string): string {
  return network === 'pasta' ? `pasta:--map-host-loopback,${hostAddress},--no-splice` : 'slirp4netns:allow_host_loopback=true'
}

/** Host facts the limits depend on, injected so tests need no cgroups or quotas. */
export interface EnforcementProbe {
  /** Delegated cgroup v2 controllers for the account's user manager. */
  controllers(uid: number): Promise<readonly string[]>
}

/** Tools used to apply and verify limits. */
export interface LimitTools { readonly setquota: string; readonly nft: string; readonly quotaMount: string }

/** Verify the host can enforce every limit for this account, then apply the disk quota. Fails closed. */
export async function enforceLimits(runner: CommandRunner, probe: EnforcementProbe, tools: LimitTools,
  limits: Limits, uid: number): Promise<void> {
  if (!isAbsolute(tools.quotaMount)) throw new LimitsError('quota mount must be absolute')
  const controllers = await probe.controllers(uid).catch(() => [] as string[])
  for (const required of REQUIRED_CONTROLLERS) {
    if (!controllers.includes(required)) throw new LimitsError(`cgroup controller ${required} is not delegated`)
  }
  const firewall = await runner.run(tools.nft, ['list', 'table', 'inet', 'dsh_instances'])
  if (firewall.code !== 0) throw new LimitsError('egress firewall table dsh_instances is not loaded')
  try {
    const blocks = Math.ceil(limits.diskBytes / 1024)
    await runChecked(runner, tools.setquota, ['-u', String(uid), '0', String(blocks), '0', '0', tools.quotaMount])
  } catch { throw new LimitsError('disk quota could not be applied') }
}
