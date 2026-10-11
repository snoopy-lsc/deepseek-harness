/** Durable lifecycle records, one atomic file per derived account. */
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseContainerName, parseInstanceId, parseUnitName, parseUserId, type RuntimeInstance, type RuntimeRef, type InstanceId, type UserId } from '@public-harness/contracts'
import { deriveNames } from './accounts.ts'

/** Lifecycle of one user's host resources. Only `running` may be routed. */
export type Lifecycle = 'provisioning' | 'stopped' | 'starting' | 'running' | 'suspended' | 'pending-deletion'

export const LIFECYCLES: readonly Lifecycle[] = ['provisioning', 'stopped', 'starting', 'running', 'suspended', 'pending-deletion']

/** Which provisioning steps are known complete; retries resume after the last completed one. */
export interface Steps { account: boolean; storage: boolean; workspace: boolean }

/** The persisted record. Contains no secrets, tokens, or caller-supplied paths. */
export interface UserState {
  readonly version: 1
  readonly userId: UserId
  readonly account: string
  uid?: number
  gid?: number
  lifecycle: Lifecycle
  steps: Steps
  readonly createdAt: number
  updatedAt: number
  lastActiveAt?: number
  suspendedAt?: number
  deletionRequestedAt?: number
  deletionConfirmedAt?: number
  /** Short failure code from the last interrupted step; never a message with paths or output. */
  lastError?: string
}

const KEYS = new Set(['version', 'userId', 'account', 'uid', 'gid', 'lifecycle', 'steps', 'createdAt', 'updatedAt',
  'lastActiveAt', 'suspendedAt', 'deletionRequestedAt', 'deletionConfirmedAt', 'lastError'])

const int = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Validate a record read from disk; any malformed or inconsistent record is rejected whole. */
export function parseUserState(value: unknown): UserState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid state record')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !KEYS.has(key)) || record.version !== 1 || typeof record.userId !== 'string'
    || typeof record.account !== 'string' || !LIFECYCLES.includes(record.lifecycle as Lifecycle)
    || !int(record.createdAt) || !int(record.updatedAt)) throw new Error('invalid state record')
  for (const key of ['uid', 'gid', 'lastActiveAt', 'suspendedAt', 'deletionRequestedAt', 'deletionConfirmedAt']) {
    if (record[key] !== undefined && !int(record[key])) throw new Error('invalid state record')
  }
  if (record.lastError !== undefined && (typeof record.lastError !== 'string' || !/^[a-z-]{1,40}$/.test(record.lastError))) {
    throw new Error('invalid state record')
  }
  const steps = record.steps as Record<string, unknown> | undefined
  if (typeof steps !== 'object' || steps === null || Object.keys(steps).sort().join(',') !== 'account,storage,workspace'
    || Object.values(steps).some(step => typeof step !== 'boolean')) throw new Error('invalid state record')
  const userId = parseUserId(record.userId)
  if (deriveNames(userId).account !== record.account) throw new Error('state record account does not match its user')
  return { version: 1, userId, account: record.account, lifecycle: record.lifecycle as Lifecycle,
    steps: { account: steps.account as boolean, storage: steps.storage as boolean, workspace: steps.workspace as boolean },
    createdAt: record.createdAt as number, updatedAt: record.updatedAt as number,
    ...optionalFields(record) }
}

/** Resource ownership retained until cleanup has been verified. */
export type AcquiredResource = 'account' | 'storage' | 'policy' | 'network' | 'quota' | 'unit' | 'forwarder'
/** An interrupted allocation, before a complete RuntimeInstance exists. */
export interface PendingAllocation { instanceId: InstanceId; webPort?: number; quotaPort?: number }
/** Current record; legacy v1 readers remain available for migration review. */
export type UserStateV2 = Omit<UserState, 'version' | 'lifecycle'> & { version: 2; runtime: RuntimeRef;
  instance: RuntimeInstance | null; lifecycle: Lifecycle | 'quarantined'; acquired: AcquiredResource[]; pending?: PendingAllocation }

function optionalFields(record: Record<string, unknown>): Partial<Pick<UserState, 'uid' | 'gid' | 'lastActiveAt' | 'suspendedAt' |
  'deletionRequestedAt' | 'deletionConfirmedAt' | 'lastError'>> {
  return { ...(record.uid === undefined ? {} : { uid: record.uid as number }),
    ...(record.gid === undefined ? {} : { gid: record.gid as number }),
    ...(record.lastActiveAt === undefined ? {} : { lastActiveAt: record.lastActiveAt as number }),
    ...(record.suspendedAt === undefined ? {} : { suspendedAt: record.suspendedAt as number }),
    ...(record.deletionRequestedAt === undefined ? {} : { deletionRequestedAt: record.deletionRequestedAt as number }),
    ...(record.deletionConfirmedAt === undefined ? {} : { deletionConfirmedAt: record.deletionConfirmedAt as number }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError as string }) }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid state record')
  return value as Record<string, unknown>
}
function runtimeRef(value: unknown, account: string): RuntimeRef {
  const ref = object(value)
  if (ref.kind === 'podman-gvisor' && Object.keys(ref).sort().join(',') === 'container,kind'
    && ref.container === account) return { kind: 'podman-gvisor', container: parseContainerName(account) }
  if (ref.kind === 'systemd' && Object.keys(ref).sort().join(',') === 'kind,unit'
    && ref.unit === `dsh-user-${account.slice(4)}.service`) return { kind: 'systemd', unit: parseUnitName(ref.unit) }
  throw new Error('invalid state runtime')
}
function port(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error('invalid state port')
  return value
}
function instance(value: unknown, base: UserState, runtime: RuntimeRef): RuntimeInstance | null {
  if (value === null) return null
  const entry = object(value)
  const keys = ['userId', 'instanceId', 'runtime', 'account', 'uid', 'gid', 'home', 'workspace', 'cache', 'tmp', 'controlDir', 'webPort', 'quotaPort']
  if (Object.keys(entry).sort().join(',') !== keys.sort().join(',') || entry.userId !== base.userId
    || entry.account !== base.account || entry.uid !== base.uid || entry.gid !== base.gid || !int(entry.uid) || !int(entry.gid)
    || typeof entry.instanceId !== 'string') throw new Error('invalid state instance')
  const ref = runtimeRef(entry.runtime, base.account)
  if (ref.kind !== runtime.kind) throw new Error('invalid state instance runtime')
  const absolute = (key: string): string => {
    const value = entry[key]
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('invalid state instance path')
    return value
  }
  return { userId: base.userId, instanceId: parseInstanceId(entry.instanceId), runtime: ref, account: base.account,
    uid: entry.uid as number, gid: entry.gid as number, home: absolute('home'), workspace: absolute('workspace'),
    cache: absolute('cache'), tmp: absolute('tmp'), controlDir: absolute('controlDir'), webPort: port(entry.webPort), quotaPort: port(entry.quotaPort) }
}

/** Decode v1 as container state or validate v2, without modifying the input or publishing a file.
 * @param value Untrusted persisted JSON.
 * @returns Current logical state; malformed and unsupported versions throw without rewriting the source.
 */
export function migrateUserState(value: unknown): UserStateV2 {
  const record = object(value)
  if (record.version === 1) {
    const legacy = parseUserState(record)
    return { ...legacy, version: 2, steps: { ...legacy.steps }, runtime: { kind: 'podman-gvisor', container: parseContainerName(legacy.account) },
      instance: null, acquired: [...(legacy.steps.account ? ['account' as const] : []), ...(legacy.steps.storage ? ['storage' as const] : [])] }
  }
  if (record.version !== 2) throw new Error('unsupported state record version')
  const { runtime: refValue, instance: instanceValue, acquired: acquiredValue, pending: pendingValue, ...common } = record
  const lifecycle = record.lifecycle
  const base = parseUserState({ ...common, version: 1, lifecycle: lifecycle === 'quarantined' ? 'stopped' : lifecycle })
  const ref = runtimeRef(refValue, base.account)
  const allowed: readonly string[] = ['account', 'storage', 'policy', 'network', 'quota', 'unit', 'forwarder']
  if (!Array.isArray(acquiredValue) || acquiredValue.some(item => typeof item !== 'string' || !allowed.includes(item))
    || new Set(acquiredValue).size !== acquiredValue.length) throw new Error('invalid state resources')
  const acquired = acquiredValue as AcquiredResource[]
  let pending: PendingAllocation | undefined
  if (pendingValue !== undefined) {
    const entry = object(pendingValue)
    if (typeof entry.instanceId !== 'string' || Object.keys(entry).some(key => !['instanceId', 'webPort', 'quotaPort'].includes(key))) throw new Error('invalid pending allocation')
    pending = { instanceId: parseInstanceId(entry.instanceId), ...(entry.webPort === undefined ? {} : { webPort: port(entry.webPort) }),
      ...(entry.quotaPort === undefined ? {} : { quotaPort: port(entry.quotaPort) }) }
  }
  const allocated = instance(instanceValue, base, ref)
  if (allocated !== null && pending !== undefined) throw new Error('state instance and pending allocation conflict')
  return { ...base, version: 2, lifecycle: lifecycle === 'quarantined' ? 'quarantined' : base.lifecycle,
    runtime: ref, instance: allocated, acquired: [...acquired], ...(pending === undefined ? {} : { pending }) }
}

/** Durable lifecycle storage. */
export interface StateStore {
  get(userId: UserId): Promise<UserStateV2 | undefined>
  put(record: UserStateV2): Promise<void>
  delete(userId: UserId): Promise<void>
  /** Valid records plus the file names of records that failed validation (never trusted, never deleted). */
  list(): Promise<{ readonly records: UserStateV2[]; readonly invalid: string[] }>
}

/** File-backed store. `dir` must be root-only; files are written 0600 via tmp + fsync + rename. */
export function createFileStateStore(dir: string): StateStore {
  const file = (account: string): string => join(dir, `${account}.json`)
  return {
    async get(userId) {
      let text: string
      try { text = await readFile(file(deriveNames(userId).account), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
      const record = migrateUserState(JSON.parse(text))
      if (record.userId !== userId) throw new Error('state record belongs to a different user')
      return record
    },
    async put(record) {
      migrateUserState(JSON.parse(JSON.stringify(record)))
      const path = file(record.account)
      const temporary = `${path}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync() } finally { await handle.close() }
      try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
    },
    async delete(userId) {
      await unlink(file(deriveNames(userId).account)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    },
    async list() {
      const records: UserStateV2[] = [], invalid: string[] = []
      for (const name of await readdir(dir)) {
        if (!/^dsh-[0-9a-f]{24}\.json$/.test(name)) continue
        try {
          const record = migrateUserState(JSON.parse(await readFile(join(dir, name), 'utf8')))
          if (`${record.account}.json` !== name) throw new Error('mismatch')
          records.push(record)
        } catch (error) { invalid.push(name) /* Invalid records remain available for operator recovery. */ }
      }
      return { records, invalid }
    },
  }
}
