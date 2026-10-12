/** Validated common settings and an explicit runtime selection, resolved before host effects. */
import { isAbsolute } from 'node:path'
import { portRangesOverlap, validateIdleMs, validatePortRange, type PortRange } from '@public-harness/contracts'
import type { AccountToolchain } from './accounts.ts'
import { validateLimits, type LimitTools, type Limits } from './limits.ts'

/** Deployment-owned data and private socket directories. */
export interface HostPaths { readonly storageRoot: string; readonly stateDir: string; readonly socketDir: string; readonly quotaMount: string }
/** Account commands shared by both runtimes. */
export type HostTools = Pick<AccountToolchain, 'getent' | 'useradd' | 'userdel' | 'nologin'>
/** Container-only settings; native selection requires none of these programs or assets. */
export interface ContainerRuntimeConfig {
  readonly kind: 'podman-gvisor'
  readonly runtimeAssets: string
  readonly tools: Omit<AccountToolchain, keyof HostTools> & Omit<LimitTools, 'quotaMount'> & {
    readonly runuser: string; readonly podman: string; readonly runsc: string; readonly git: string; readonly env: string }
  readonly image: string
  readonly imageArchive?: string
  readonly hostAddress: string
  readonly network: Limits['network']
  readonly sidecar: PortRange
}
/** Native configuration is owned by the systemd provider; no provider is mounted implicitly. */
export interface SystemdRuntimeConfig { readonly kind: 'systemd'; readonly configFile: string }
/** Common lifecycle settings and a tagged provider selection. */
export interface ProvisionerConfig {
  readonly paths: HostPaths
  readonly tools: HostTools
  readonly runtime: ContainerRuntimeConfig | SystemdRuntimeConfig
  readonly socketGid: number
  readonly maxActiveInstances: number
  readonly idleStopMs: number
  readonly deletionRecoveryMs: number
  readonly limits: Omit<Limits, 'network'>
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly ports: { readonly quota: PortRange }
}
/** Explicitly resolved inputs used by the container implementation. */
export interface ContainerConfig extends Omit<ProvisionerConfig, 'runtime' | 'tools' | 'paths' | 'limits' | 'ports'> {
  readonly paths: HostPaths & { readonly runtimeAssets: string }
  readonly tools: HostTools & ContainerRuntimeConfig['tools'] & { readonly quotaMount: string }
  readonly limits: Limits
  readonly ports: { readonly quota: PortRange; readonly sidecar: PortRange }
  readonly image: string
  readonly imageArchive?: string
  readonly quota: { readonly hostAddress: string }
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid provisioner configuration')
  const object = value as Record<string, unknown>
  if (required.some(key => !(key in object)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('invalid provisioner configuration fields')
  }
  return object
}
function path(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path`)
  return value
}
function integer(value: unknown, name: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} is invalid`)
  return value
}

/** Parse root-owned configuration; missing tags and stale container fields reject before side effects.
 * @param value Configuration read from JSON or trusted composition.
 * @returns Explicit validated settings; malformed input throws.
 */
export function validateProvisionerConfig(value: unknown): ProvisionerConfig {
  const c = record(value, ['paths', 'tools', 'runtime', 'socketGid', 'maxActiveInstances', 'idleStopMs', 'deletionRecoveryMs',
    'limits', 'readyTimeoutMs', 'stopTimeoutMs', 'ports'])
  const p = record(c.paths, ['storageRoot', 'stateDir', 'socketDir', 'quotaMount'])
  const paths: HostPaths = { storageRoot: path(p.storageRoot, 'storageRoot'), stateDir: path(p.stateDir, 'stateDir'),
    socketDir: path(p.socketDir, 'socketDir'), quotaMount: path(p.quotaMount, 'quotaMount') }
  if (new Set(Object.values(paths)).size !== 4) throw new Error('provisioner paths must be distinct')
  const t = record(c.tools, ['getent', 'useradd', 'userdel', 'nologin'])
  const tools: HostTools = { getent: path(t.getent, 'getent'), useradd: path(t.useradd, 'useradd'), userdel: path(t.userdel, 'userdel'), nologin: path(t.nologin, 'nologin') }
  const maxActiveInstances = integer(c.maxActiveInstances, 'maxActiveInstances')
  const idleStopMs = integer(c.idleStopMs, 'idleStopMs'); validateIdleMs(idleStopMs)
  const ports = record(c.ports, ['quota'])
  const quota = validatePortRange(ports.quota, 'ports.quota', maxActiveInstances)
  const l = record(c.limits, ['cpus', 'memoryBytes', 'pids', 'openFiles', 'diskBytes'])
  if (typeof l.cpus !== 'number' || !Number.isFinite(l.cpus) || l.cpus <= 0) throw new Error('cpus must be positive')
  const limits = { cpus: l.cpus, memoryBytes: integer(l.memoryBytes, 'memoryBytes'), pids: integer(l.pids, 'pids'),
    openFiles: integer(l.openFiles, 'openFiles'), diskBytes: integer(l.diskBytes, 'diskBytes') }
  const tag = record(c.runtime, ['kind'], ['runtimeAssets', 'tools', 'image', 'imageArchive', 'hostAddress', 'network', 'sidecar', 'configFile'])
  let runtime: ProvisionerConfig['runtime']
  switch (tag.kind) {
    case 'systemd': record(tag, ['kind', 'configFile']); runtime = { kind: 'systemd', configFile: path(tag.configFile, 'runtime.configFile') }; break
    case 'podman-gvisor': {
      record(tag, ['kind', 'runtimeAssets', 'tools', 'image', 'hostAddress', 'network', 'sidecar'], ['imageArchive'])
      const ct = record(tag.tools, ['loginctl', 'sharedGroup', 'setquota', 'nft', 'runuser', 'podman', 'runsc', 'git', 'env'])
      if (typeof ct.sharedGroup !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(ct.sharedGroup)) throw new Error('sharedGroup is invalid')
      if (typeof tag.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,255}$/.test(tag.image)) throw new Error('image is invalid')
      if (typeof tag.hostAddress !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(tag.hostAddress)
        || tag.hostAddress.split('.').some(octet => Number(octet) > 255)) throw new Error('hostAddress must be an IPv4 address')
      const sidecar = validatePortRange(tag.sidecar, 'runtime.sidecar', maxActiveInstances)
      if (portRangesOverlap(quota, sidecar)) throw new Error('quota and sidecar ports must not overlap')
      const containerLimits = validateLimits({ ...limits, network: tag.network })
      runtime = { kind: 'podman-gvisor', runtimeAssets: path(tag.runtimeAssets, 'runtimeAssets'), image: tag.image,
        hostAddress: tag.hostAddress, network: containerLimits.network, sidecar,
        tools: { loginctl: path(ct.loginctl, 'loginctl'), sharedGroup: ct.sharedGroup, setquota: path(ct.setquota, 'setquota'),
          nft: path(ct.nft, 'nft'), runuser: path(ct.runuser, 'runuser'), podman: path(ct.podman, 'podman'),
          runsc: path(ct.runsc, 'runsc'), git: path(ct.git, 'git'), env: path(ct.env, 'env') },
        ...(tag.imageArchive === undefined ? {} : { imageArchive: path(tag.imageArchive, 'imageArchive') }) }
      if (Object.values(paths).includes(runtime.runtimeAssets)) throw new Error('provisioner paths must be distinct')
      break
    }
    default: throw new Error('unknown runtime provider kind')
  }
  return { paths, tools, runtime, maxActiveInstances, idleStopMs, limits, ports: { quota },
    socketGid: integer(c.socketGid, 'socketGid', 0), deletionRecoveryMs: integer(c.deletionRecoveryMs, 'deletionRecoveryMs'),
    readyTimeoutMs: integer(c.readyTimeoutMs, 'readyTimeoutMs'), stopTimeoutMs: integer(c.stopTimeoutMs, 'stopTimeoutMs') }
}

/** Resolve the container settings at the provider's entry; a native selection rejects.
 * @param config Validated common configuration.
 * @returns Complete container inputs with no implicit backend default.
 */
export function resolveContainerConfig(config: ProvisionerConfig): ContainerConfig {
  const runtime = config.runtime
  if (runtime.kind !== 'podman-gvisor') throw new Error('container provider does not match configured backend')
  const { runtime: _runtime, ...common } = config
  return { ...common, paths: { ...config.paths, runtimeAssets: runtime.runtimeAssets },
    tools: { ...config.tools, ...runtime.tools, quotaMount: config.paths.quotaMount },
    limits: { ...config.limits, network: runtime.network }, ports: { ...config.ports, sidecar: runtime.sidecar },
    image: runtime.image, ...(runtime.imageArchive === undefined ? {} : { imageArchive: runtime.imageArchive }), quota: { hostAddress: runtime.hostAddress } }
}
