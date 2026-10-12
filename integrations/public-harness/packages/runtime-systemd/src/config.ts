/** Explicit native settings resolved together with the common provisioner configuration. */
import { isIP } from 'node:net'
import { posix } from 'node:path'
import { portRangesOverlap, validatePortRange, type PortRange } from '@public-harness/contracts'
import { validateProvisionerConfig, type ProvisionerConfig } from '@public-harness/provisioner/config'

/** A native operation cannot safely continue; the caller retains allocation and reports the failed stage. */
export class NativeHostError extends Error {
  override readonly name = 'NativeHostError'
  /** @param code Stable failure category. @param operation Failed operation. @param cause Original failure, when available. */
  constructor(readonly code: 'invalid-config' | 'unsafe-path' | 'account-conflict' | 'host-operation', readonly operation: string, cause?: unknown) {
    super(`native host ${operation} failed; retain allocation and reconcile before retry`, { cause })
  }
}

/** Resolved native inputs; asset ownership is checked asynchronously before privileged preparation. */
export interface SystemdConfig {
  readonly paths: ProvisionerConfig['paths'] & {
    readonly release: string; readonly releaseManifest: string; readonly toolchain: string; readonly dsh: string; readonly launchPatch: string
    /** Root-owned tree holding exactly one pinned Chrome for Testing build. */
    readonly browserRoot: string
    /** The pinned browser executable; the only path the AppArmor browser child profile attaches to. */
    readonly browser: string
  }
  readonly tools: ProvisionerConfig['tools'] & { readonly node: string; readonly systemctl: string; readonly apparmorParser: string; readonly xfsQuota: string; readonly nft: string }
  readonly limits: ProvisionerConfig['limits'] & { readonly diskInodes: number; readonly shmBytes: number; readonly shmInodes: number }
  readonly ports: { readonly web: PortRange; readonly quota: PortRange }
  readonly profile: string
  readonly resolver: string
  readonly publicEgress: { readonly tcp: readonly number[]; readonly udp: readonly number[] }
  readonly operationTimeoutMs: number
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NativeHostError('invalid-config', 'configuration')
  const r = value as Record<string, unknown>
  if (keys.some(key => !Object.hasOwn(r, key)) || Object.keys(r).some(key => !keys.includes(key))) throw new NativeHostError('invalid-config', 'configuration-fields')
  return r
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value === '/' || posix.normalize(value) !== value
    || value.endsWith('/')) throw new NativeHostError('invalid-config', 'absolute-path')
  return value
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new NativeHostError('invalid-config', 'positive-integer')
  return value
}
function portList(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(port => typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    || new Set(value).size !== value.length) throw new NativeHostError('invalid-config', 'egress-ports')
  return value as number[]
}
/** Smallest native TasksMax: an idle instance uses about 50 tasks and Chromium adds many processes and threads. */
export const NATIVE_MIN_PIDS = 512
/** Smallest native MemoryMax: an idle instance uses about 200 MiB before tools or a browser start. */
export const NATIVE_MIN_MEMORY_BYTES = 1024 * 1024 * 1024
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`)

/** Resolve native options without importing a provider into the common provisioner.
 * @param value Exact object containing common configuration and native companion options.
 * @returns Validated settings; host ownership checks remain mandatory before account or storage effects.
 */
export function parseSystemdConfig(value: unknown): SystemdConfig {
  const root = record(value, ['common', 'native'])
  let common: ProvisionerConfig
  try { common = validateProvisionerConfig(root.common) } catch (cause) { throw new NativeHostError('invalid-config', 'common-configuration', cause) }
  if (common.runtime.kind !== 'systemd') throw new NativeHostError('invalid-config', 'runtime-selection')
  const n = record(root.native, ['paths', 'tools', 'profile', 'diskInodes', 'shmBytes', 'shmInodes', 'operationTimeoutMs', 'web', 'resolver', 'publicEgress'])
  const p = record(n.paths, ['release', 'releaseManifest', 'toolchain', 'dsh', 'launchPatch', 'browserRoot', 'browser'])
  const t = record(n.tools, ['node', 'systemctl', 'apparmorParser', 'xfsQuota', 'nft'])
  const paths = { ...common.paths, release: path(p.release), releaseManifest: path(p.releaseManifest), toolchain: path(p.toolchain),
    dsh: path(p.dsh), launchPatch: path(p.launchPatch), browserRoot: path(p.browserRoot), browser: path(p.browser) }
  const tools = { ...common.tools, node: path(t.node), systemctl: path(t.systemctl), apparmorParser: path(t.apparmorParser), xfsQuota: path(t.xfsQuota), nft: path(t.nft) }
  Object.values(paths).forEach(path); Object.values(tools).forEach(path)
  path(common.runtime.configFile)
  if (!inside(paths.storageRoot, paths.quotaMount) || !inside(paths.dsh, paths.release) || !inside(paths.launchPatch, paths.release)
    || !inside(paths.releaseManifest, paths.release) || paths.browser === paths.browserRoot || !inside(paths.browser, paths.browserRoot)
    || !inside(tools.node, paths.toolchain)) throw new NativeHostError('invalid-config', 'asset-layout')
  // The unit's ProtectHome=yes empties these trees and InaccessiblePaths hides /run/systemd, so data or launch assets
  // placed there would vanish inside the confined service.
  const hidden = ['/home', '/root', '/run/user', '/run/systemd', '/run/dbus']
  if ([paths.storageRoot, paths.release, paths.toolchain, paths.browserRoot].some(p => hidden.some(h => inside(p, h)))) throw new NativeHostError('invalid-config', 'hidden-path')
  const isolated = [paths.storageRoot, paths.stateDir, paths.socketDir, paths.release, paths.toolchain, paths.browserRoot]
  if (isolated.some((a, i) => isolated.some((b, j) => i !== j && inside(a, b)))) throw new NativeHostError('invalid-config', 'overlapping-paths')
  let web: PortRange
  try { web = validatePortRange(n.web, 'native.web', common.maxActiveInstances) } catch (cause) { throw new NativeHostError('invalid-config', 'web-ports', cause) }
  if (portRangesOverlap(web, common.ports.quota)) throw new NativeHostError('invalid-config', 'overlapping-ports')
  if (typeof n.profile !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(n.profile)) throw new NativeHostError('invalid-config', 'profile')
  if (typeof n.resolver !== 'string' || isIP(n.resolver) === 0) throw new NativeHostError('invalid-config', 'resolver')
  const egress = record(n.publicEgress, ['tcp', 'udp'])
  const limits = { ...common.limits, diskInodes: positive(n.diskInodes), shmBytes: positive(n.shmBytes), shmInodes: positive(n.shmInodes) }
  // A native instance shares one cgroup between Node, its tools and Chromium; the container floors apply here too.
  if (limits.pids < NATIVE_MIN_PIDS || limits.memoryBytes < NATIVE_MIN_MEMORY_BYTES) throw new NativeHostError('invalid-config', 'native-limit-floor')
  if (limits.shmBytes > limits.memoryBytes || limits.diskBytes % 1024 !== 0) throw new NativeHostError('invalid-config', 'storage-limits')
  return { paths, tools, limits, ports: { web, quota: common.ports.quota }, profile: n.profile, resolver: n.resolver,
    publicEgress: { tcp: portList(egress.tcp), udp: portList(egress.udp) }, operationTimeoutMs: positive(n.operationTimeoutMs),
    readyTimeoutMs: common.readyTimeoutMs, stopTimeoutMs: common.stopTimeoutMs }
}
