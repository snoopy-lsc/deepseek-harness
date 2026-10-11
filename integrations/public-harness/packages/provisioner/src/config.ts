/** Required host configuration for the Linux provisioner; nothing here comes from a request. */
import { isAbsolute } from 'node:path'
import { portRangesOverlap, validateIdleMs, validatePortRange, type PortRange } from '@public-harness/contracts'
import type { AccountToolchain } from './accounts.ts'
import { validateLimits, type LimitTools, type Limits } from './limits.ts'

/** Absolute directories owned by the deployment. */
export interface HostPaths {
  /** Parent of every account's private tree; root-owned, not listable by users. */
  readonly storageRoot: string
  /** Durable lifecycle records; root-only. */
  readonly stateDir: string
  /** Router-facing per-instance Unix sockets; root:router-group, group may traverse but not write. */
  readonly socketDir: string
  /** Read-only tree mounted into every container (container entry script and sidecar). */
  readonly runtimeAssets: string
  /** Mount point carrying user disk quotas. */
  readonly quotaMount: string
}

/** Absolute paths of every external executable the provisioner may run. */
export interface HostTools extends AccountToolchain, LimitTools {
  readonly runuser: string
  readonly podman: string
  readonly runsc: string
  readonly git: string
  readonly env: string
}

/** Complete provisioner configuration. */
export interface ProvisionerConfig {
  readonly paths: HostPaths
  readonly tools: HostTools
  readonly socketGid: number
  readonly maxActiveInstances: number
  readonly idleStopMs: number
  readonly deletionRecoveryMs: number
  readonly image: string
  /**
   * Root-owned, world-readable image archive (`podman save`) that every account loads into its own rootless store the
   * first time it starts. When absent, each account pulls `image` from its registry instead. There is one store per
   * account, so the image is stored once per account and counts against that account's disk quota.
   */
  readonly imageArchive?: string
  readonly limits: Limits
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
  /** Address inside the instance that reaches the quota proxy (host loopback mapping) and its port. */
  readonly quota: { readonly hostAddress: string }
  /**
   * The only loopback ports instances may ever reach or occupy. `quota` is where the quota service opens instance
   * listeners (mirrors its `listenPorts` and the firewall's `QUOTA_PORTS`); `sidecar` is where the provisioner publishes
   * each instance's sidecar, which only the host-side forwarder uses and the firewall therefore does not allow.
   */
  readonly ports: { readonly quota: PortRange; readonly sidecar: PortRange }
}

/** Validate before any host change; every failure names the setting, never a value. */
export function validateProvisionerConfig(config: ProvisionerConfig): ProvisionerConfig {
  for (const [name, value] of Object.entries({ ...config.paths, ...config.tools }).filter(([name]) => name !== 'sharedGroup')) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path`)
  }
  for (const name of ['sharedGroup'] as const) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(config.tools[name])) throw new Error(`${name} is invalid`)
  }
  const paths = Object.values(config.paths)
  if (new Set(paths).size !== paths.length) throw new Error('provisioner paths must be distinct')
  if (!Number.isSafeInteger(config.socketGid) || config.socketGid < 0) throw new Error('socketGid is invalid')
  for (const name of ['maxActiveInstances', 'readyTimeoutMs', 'stopTimeoutMs', 'deletionRecoveryMs'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`${name} must be positive`)
  }
  validateIdleMs(config.idleStopMs)
  if (config.imageArchive !== undefined && (typeof config.imageArchive !== 'string' || !isAbsolute(config.imageArchive)
    || config.imageArchive.includes('\0') || config.imageArchive.startsWith('-'))) throw new Error('imageArchive must be an absolute path')
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,255}$/.test(config.image) || /^(localhost\/)?$/.test(config.image)) throw new Error('image is invalid')
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(config.quota.hostAddress)) throw new Error('quota.hostAddress must be an IPv4 address')
  const quotaPorts = validatePortRange(config.ports?.quota, 'ports.quota', config.maxActiveInstances)
  const sidecarPorts = validatePortRange(config.ports?.sidecar, 'ports.sidecar', config.maxActiveInstances)
  if (portRangesOverlap(quotaPorts, sidecarPorts)) throw new Error('ports.quota and ports.sidecar must not overlap')
  validateLimits(config.limits)
  return config
}
