/** Runtime providers operate only on server-assigned identities, paths and private endpoints. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { InstanceEndpoint, UserId } from './index.ts'

/** Selected Linux process runtime. */
export type RuntimeKind = 'systemd' | 'podman-gvisor'
/** Unknown means the provider cannot establish whether processes remain. */
export type RuntimeState = 'running' | 'stopped' | 'unknown'
/** One launch's opaque quota identity. */
export type InstanceId = Branded<'PublicHarnessInstanceId'>
/** Root-owned system unit derived from a user ID. */
export type UnitName = Branded<'PublicHarnessUnitName'>
/** Container name derived from a user ID. */
export type ContainerName = Branded<'PublicHarnessContainerName'>
/** Persistent provider selection; changing configuration never transfers an instance. */
export type RuntimeRef = { kind: 'systemd'; unit: UnitName } | { kind: 'podman-gvisor'; container: ContainerName }

/** Validate a launch identity read across a process or durable-data boundary.
 * @param value Received ID.
 * @returns Bounded ASCII identifier; invalid input throws.
 */
export function parseInstanceId(value: string): InstanceId {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid instance ID')
  return value as InstanceId
}
/** Validate a server-derived unit name.
 * @param value Received name.
 * @returns Unit name; non-derived names throw.
 */
export function parseUnitName(value: string): UnitName {
  if (!/^dsh-user-[0-9a-f]{24}\.service$/.test(value)) throw new Error('invalid unit name')
  return value as UnitName
}
/** Validate a server-derived container name.
 * @param value Received name.
 * @returns Container name; non-derived names throw.
 */
export function parseContainerName(value: string): ContainerName {
  if (!/^dsh-[0-9a-f]{24}$/.test(value)) throw new Error('invalid container name')
  return value as ContainerName
}

/** Fully allocated launch; writable paths and numeric identities are assigned by the server. */
export interface RuntimeInstance {
  userId: UserId
  instanceId: InstanceId
  runtime: RuntimeRef
  account: string
  uid: number
  gid: number
  home: string
  workspace: string
  cache: string
  tmp: string
  controlDir: string
  webPort: number
  quotaPort: number
}

/** Host runtime capability; failed cleanup must retain its durable allocation for operator reconciliation. */
export interface InstanceRuntime {
  readonly kind: RuntimeKind
  /** Reserve private endpoints for one launch before preparation or user execution.
   * @param request Server-assigned identities and paths with a fresh launch ID.
   * @returns Fully assigned instance; partial failure retains durable evidence until verified cleanup.
   */
  allocate(request: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>): Promise<RuntimeInstance>
  /** Enforce required host protections before starting any instance process.
   * @param instance Fully allocated launch.
   * @returns Resolves after enforcement; rejects if any required protection is unavailable.
   */
  prepare(instance: RuntimeInstance): Promise<void>
  /** Revoke an interrupted allocation using its account and launch ID, without fabricated ports.
   * @param request Recorded server assignment; the provider reads durable partial resources.
   * @returns Resolves only after verified cleanup; unknown outcomes retain quarantine and deny reuse.
   */
  releaseAllocation(request: Omit<RuntimeInstance, 'webPort' | 'quotaPort'>): Promise<void>
  /** Initialize a Git workspace within the provider's execution protections.
   * @param instance Fully allocated launch.
   * @returns Resolves once initialization completes; failures remain non-routable.
   */
  initializeWorkspace(instance: RuntimeInstance): Promise<void>
  /** Start and verify readiness before returning a private endpoint.
   * @param instance Fully allocated launch.
   * @returns Verified endpoint; partial failures require stop before allocation reuse.
   */
  start(instance: RuntimeInstance): Promise<InstanceEndpoint>
  /** Read the current private Web launch credential.
   * @param instance Running launch.
   * @returns Credential; rejects when unavailable.
   */
  launchGrant(instance: RuntimeInstance): Promise<string>
  /** Withdraw forwarding, quota grants and processes.
   * @param instance Allocated launch.
   * @returns Resolves only after cleanup; rejects when cleanup cannot be established.
   */
  stop(instance: RuntimeInstance): Promise<void>
  /** Query the runtime rather than trusting persisted lifecycle state.
   * @param instance Allocated launch.
   * @returns Running, stopped or unknown; unknown never authorizes allocation reuse.
   */
  state(instance: RuntimeInstance): Promise<RuntimeState>
}

declare module '@deepseek-ai/cordis' {
  interface Context { instanceRuntime: InstanceRuntime }
}
