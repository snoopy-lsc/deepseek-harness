/** Required host configuration for the Linux provisioner; nothing here comes from a request. */
import { isAbsolute } from 'node:path'
import { validateIdleMs } from '@public-harness/contracts'
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
  readonly limits: Limits
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
  /** Address inside the instance that reaches the quota proxy (host loopback mapping) and its port. */
  readonly quota: { readonly hostAddress: string }
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,255}$/.test(config.image) || /^(localhost\/)?$/.test(config.image)) throw new Error('image is invalid')
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(config.quota.hostAddress)) throw new Error('quota.hostAddress must be an IPv4 address')
  validateLimits(config.limits)
  return config
}
