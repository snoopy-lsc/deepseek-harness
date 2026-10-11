/** Durable lifecycle records, one atomic file per derived account. */
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseUserId, type UserId } from '@public-harness/contracts'
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
  return record as unknown as UserState
}

/** Durable lifecycle storage. */
export interface StateStore {
  get(userId: UserId): Promise<UserState | undefined>
  put(record: UserState): Promise<void>
  delete(userId: UserId): Promise<void>
  /** Valid records plus the file names of records that failed validation (never trusted, never deleted). */
  list(): Promise<{ readonly records: UserState[]; readonly invalid: string[] }>
}

/** File-backed store. `dir` must be root-only; files are written 0600 via tmp + fsync + rename. */
export function createFileStateStore(dir: string): StateStore {
  const file = (account: string): string => join(dir, `${account}.json`)
  return {
    async get(userId) {
      let text: string
      try { text = await readFile(file(deriveNames(userId).account), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
      const record = parseUserState(JSON.parse(text))
      if (record.userId !== userId) throw new Error('state record belongs to a different user')
      return record
    },
    async put(record) {
      parseUserState(JSON.parse(JSON.stringify(record)))
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
      const records: UserState[] = [], invalid: string[] = []
      for (const name of await readdir(dir)) {
        if (!/^dsh-[0-9a-f]{24}\.json$/.test(name)) continue
        try {
          const record = parseUserState(JSON.parse(await readFile(join(dir, name), 'utf8')))
          if (`${record.account}.json` !== name) throw new Error('mismatch')
          records.push(record)
        } catch { invalid.push(name) }
      }
      return { records, invalid }
    },
  }
}
