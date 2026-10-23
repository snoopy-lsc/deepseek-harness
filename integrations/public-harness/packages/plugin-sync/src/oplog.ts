/**
 * Local sync op log under `~/.dsh-market/sync-log.jsonl`.
 * Sole source for deciding what the user removed (design § Default installs).
 */
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Core sync op types plus local clear markers for reset / re-enable. */
export type SyncOpType =
  | 'intent'
  | 'done'
  | 'removed'
  | 'failed'
  | 'recovered'
  | 'user-removed'
  | 'abandoned'
  | 'reset'
  | 're-enable'

export interface SyncOp {
  readonly type: SyncOpType
  readonly name: string
  readonly version?: string
  readonly action?: string
  readonly reason?: string
  readonly opId?: string
  readonly at: number
}

export function marketDir(home: string): string {
  return join(home, '.dsh-market')
}

export function syncLogPath(home: string): string {
  return join(marketDir(home), 'sync-log.jsonl')
}

export function snapshotsDir(home: string): string {
  return join(marketDir(home), 'snapshots')
}

async function ensureMarketDir(home: string): Promise<void> {
  await mkdir(marketDir(home), { recursive: true, mode: 0o700 })
}

/** Append one JSONL record. Creates `~/.dsh-market` as needed. */
export async function appendOp(home: string, op: SyncOp): Promise<void> {
  await ensureMarketDir(home)
  await appendFile(syncLogPath(home), `${JSON.stringify(op)}\n`, { mode: 0o600 })
}

/** Read all op-log records (empty when the file is missing). */
export async function readOps(home: string): Promise<SyncOp[]> {
  let text: string
  try {
    text = await readFile(syncLogPath(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: SyncOp[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) continue
      const row = parsed as Record<string, unknown>
      if (typeof row.type !== 'string' || typeof row.name !== 'string' || typeof row.at !== 'number') continue
      out.push({
        type: row.type as SyncOpType,
        name: row.name,
        ...(typeof row.version === 'string' ? { version: row.version } : {}),
        ...(typeof row.action === 'string' ? { action: row.action } : {}),
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
        ...(typeof row.opId === 'string' ? { opId: row.opId } : {}),
        at: row.at,
      })
    } catch {
      // skip corrupt lines
    }
  }
  return out
}

/**
 * Active user-removal block: a `user-removed` with no later `reset` or `re-enable`
 * for the same package (admin reset / My plugins re-enable clear the local block).
 */
export function isUserRemoved(ops: readonly SyncOp[], name: string): boolean {
  let blocked = false
  for (const op of ops) {
    if (op.name !== name) continue
    if (op.type === 'user-removed') blocked = true
    if (op.type === 'reset' || op.type === 're-enable') blocked = false
  }
  return blocked
}

function dependencyNames(packageJsonText: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(packageJsonText)
    if (typeof parsed !== 'object' || parsed === null) return new Set()
    const deps = (parsed as { dependencies?: unknown }).dependencies
    if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return new Set()
    return new Set(Object.keys(deps as Record<string, unknown>))
  } catch {
    return new Set()
  }
}

/**
 * User-removal rule: sync `done` install of P, P absent from package.json, no later
 * sync `removed` → write `user-removed` (covers Discover / `dsh plugin remove` / hand edit).
 * @returns names newly recorded as user-removed
 */
export async function detectUserRemovals(input: {
  readonly home: string
  readonly profileDir: string
  readonly now?: number
}): Promise<string[]> {
  const now = input.now ?? Date.now()
  const ops = await readOps(input.home)
  let packageJsonText: string
  try {
    packageJsonText = await readFile(join(input.profileDir, 'package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') packageJsonText = '{}'
    else throw error
  }
  const present = dependencyNames(packageJsonText)

  // Latest relevant event per name
  const lastDoneAt = new Map<string, number>()
  const lastRemovedAt = new Map<string, number>()
  const lastUserRemovedAt = new Map<string, number>()
  for (const op of ops) {
    if (op.type === 'done') lastDoneAt.set(op.name, op.at)
    if (op.type === 'removed') lastRemovedAt.set(op.name, op.at)
    if (op.type === 'user-removed') lastUserRemovedAt.set(op.name, op.at)
  }

  const written: string[] = []
  for (const [name, doneAt] of lastDoneAt) {
    if (present.has(name)) continue
    const removedAt = lastRemovedAt.get(name)
    if (removedAt !== undefined && removedAt > doneAt) continue
    const already = lastUserRemovedAt.get(name)
    if (already !== undefined && already >= doneAt) continue
    await appendOp(input.home, { type: 'user-removed', name, at: now })
    written.push(name)
  }
  return written
}
