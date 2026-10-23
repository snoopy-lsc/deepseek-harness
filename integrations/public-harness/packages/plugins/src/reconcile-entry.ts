/**
 * Pre-start reconcile entry (design § Fallback: pre-start reconcile).
 * Runs as the account; plan only from reconcile-plan; P0.4 argv/env fixtures.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendOp,
  detectUserRemovals,
  isUserRemoved,
  planSha512ToIntegrity,
  readLockfileIntegrity,
  readOps,
  listQueuedRestores,
  restoreQueuePath,
  restoreSnapshotFiles,
  writeProfileSnapshot,
  type SyncOp,
} from '@public-harness/plugin-sync'
import type { ReconcilePlan, ReconcilePlanEntry, SyncAction } from './sync-plan.ts'

/** Exact semver (no range); same shape as fetch/verbs EXACT_SEMVER. */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const SHA512_HEX = /^[0-9a-f]{128}$/i

export const PKG_TIMEOUT_MS = 120_000
export const TOTAL_TIMEOUT_MS = 300_000

/** Environment allowlist for the reconcile unit (design § Environment allowlist). */
export const RECONCILE_ENV_ALLOWLIST = [
  'HOME',
  'DSH_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'PATH',
  'NPM_CONFIG_GLOBALCONFIG',
] as const

export type ReconcileEnvKey = (typeof RECONCILE_ENV_ALLOWLIST)[number]

export type ReconcileEntryErrorCode = 'bad-registry' | 'bad-entry' | 'bad-plan'

export class ReconcileEntryError extends Error {
  readonly code: ReconcileEntryErrorCode
  readonly detail: string | undefined
  constructor(code: ReconcileEntryErrorCode, detail?: string) {
    super(detail !== undefined ? `${code}: ${detail}` : code)
    this.name = 'ReconcileEntryError'
    this.code = code
    this.detail = detail
  }
}

/** Wire plan shape (from `reconcilePlan` / plan file) — alias for tests / callers. */
export type ReconcileEntryPlan = ReconcilePlan

export interface AssertReconcilePlanOptions {
  /** Hosts accepted in the registry URL (`127.0.0.1` and/or `hostAddress`). */
  readonly allowedHosts: readonly string[]
  /** User's market port; must match the registry URL. */
  readonly expectedPort: number
}

export interface PnpmRunOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface PnpmRunner {
  run(argv: readonly string[], options: PnpmRunOptions): Promise<{ code: number }>
}

export interface ReconcileEntryResult {
  readonly name: string
  readonly action?: SyncAction
  readonly outcome: 'done' | 'skipped' | 'failed'
  readonly reason?: string
  readonly opId?: string
}

export interface ReconcileEntryReport {
  /** Overall outcome recorded for plugin-reconcile (`error` when any apply failed). */
  readonly outcome: 'ok' | 'error'
  readonly results: readonly ReconcileEntryResult[]
  readonly restoredFailed: number
  readonly restoredQueued: number
}

export interface RunReconcileEntryInput {
  readonly home: string
  readonly profileDir: string
  readonly plan: unknown
  readonly pnpm: PnpmRunner
  readonly allowedHosts: readonly string[]
  readonly expectedPort: number
  readonly env: Readonly<Record<string, string>>
  readonly now?: () => number
  readonly pkgTimeoutMs?: number
  readonly totalTimeoutMs?: number
}

export interface BuildReconcileEnvInput {
  readonly home: string
  readonly dshHome: string
  readonly cacheHome: string
  readonly tmpdir: string
  readonly path: string
  readonly npmGlobalConfig: string
  /** Rejected keys (root inherit / model key) — ignored when building the allowlist. */
  readonly inherit?: Readonly<Record<string, string | undefined>>
}

export interface BuildPnpmAddArgvInput {
  readonly registry: string
  readonly spec: string
  readonly allowedBuilds: readonly string[]
}

export interface BuildPnpmRepairArgvInput {
  readonly offline: boolean
  readonly registry: string
}

function nowMs(input: RunReconcileEntryInput): number {
  return input.now?.() ?? Date.now()
}

function newOpId(): string {
  return randomBytes(8).toString('hex')
}

/** Strip allowlisted env from any inherit bag; never copy model key / npm_config / proxy. */
export function buildReconcileEnv(input: BuildReconcileEnvInput): Record<ReconcileEnvKey, string> {
  void input.inherit
  return {
    HOME: input.home,
    DSH_HOME: input.dshHome,
    XDG_CACHE_HOME: input.cacheHome,
    TMPDIR: input.tmpdir,
    PATH: input.path,
    NPM_CONFIG_GLOBALCONFIG: input.npmGlobalConfig,
  }
}

/** `pnpm add name@version` with dsh-plugin-equivalent safety flags (never `ignore-scripts`). */
export function buildPnpmAddArgv(input: BuildPnpmAddArgvInput): string[] {
  return [
    'add',
    input.spec,
    '--ignore-pnpmfile',
    `--config.registry=${input.registry}`,
    '--config.userconfig=/dev/null',
    ...input.allowedBuilds.map((pkg) => `--allow-build=${pkg}`),
  ]
}

/** Offline / online frozen-lockfile repair after snapshot restore. */
export function buildPnpmRepairArgv(input: BuildPnpmRepairArgvInput): string[] {
  if (input.offline) {
    return [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--ignore-pnpmfile',
      '--config.userconfig=/dev/null',
    ]
  }
  return [
    'install',
    '--frozen-lockfile',
    `--config.registry=${input.registry}`,
    '--ignore-pnpmfile',
    '--config.userconfig=/dev/null',
  ]
}

function parseRegistryUrl(registry: string): { host: string; port: number } {
  let url: URL
  try {
    url = new URL(registry)
  } catch {
    throw new ReconcileEntryError('bad-registry', 'url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ReconcileEntryError('bad-registry', 'protocol')
  }
  if (!IPV4.test(url.hostname)) {
    throw new ReconcileEntryError('bad-registry', 'host')
  }
  const port = url.port !== '' ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ReconcileEntryError('bad-registry', 'port')
  }
  return { host: url.hostname, port }
}

function assertEntry(entry: unknown): ReconcilePlanEntry {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ReconcileEntryError('bad-entry', 'shape')
  }
  const row = entry as Record<string, unknown>
  if (typeof row.name !== 'string' || row.name === '') {
    throw new ReconcileEntryError('bad-entry', 'name')
  }
  if (typeof row.version !== 'string' || !EXACT_SEMVER.test(row.version)) {
    throw new ReconcileEntryError('bad-entry', 'version')
  }
  if (typeof row.sha512 !== 'string' || row.sha512 === '' || !(SHA512_HEX.test(row.sha512) || /^sha512-/.test(row.sha512))) {
    throw new ReconcileEntryError('bad-entry', 'sha512')
  }
  if (row.action !== 'install' && row.action !== 'update' && row.action !== 'downgrade') {
    throw new ReconcileEntryError('bad-entry', 'action')
  }
  if (typeof row.spec !== 'string' || row.spec !== `${row.name}@${row.version}`) {
    throw new ReconcileEntryError('bad-entry', 'spec')
  }
  const allowedBuilds = Array.isArray(row.allowedBuilds)
    ? row.allowedBuilds.filter((item): item is string => typeof item === 'string')
    : []
  const fromVersion = row.fromVersion === null || typeof row.fromVersion === 'string' ? row.fromVersion : null
  return {
    name: row.name,
    version: row.version,
    fromVersion,
    sha512: row.sha512,
    action: row.action,
    allowedBuilds,
    spec: row.spec,
  }
}

/**
 * Validate a reconcile-plan payload: each entry `name@exact-semver` + sha512;
 * registry must be the user's market port on an allowed host.
 */
export function assertReconcilePlan(plan: unknown, options: AssertReconcilePlanOptions): ReconcilePlan {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new ReconcileEntryError('bad-plan', 'shape')
  }
  const record = plan as Record<string, unknown>
  if (typeof record.registry !== 'string') {
    throw new ReconcileEntryError('bad-registry', 'missing')
  }
  const { host, port } = parseRegistryUrl(record.registry)
  if (!options.allowedHosts.includes(host)) {
    throw new ReconcileEntryError('bad-registry', host)
  }
  if (port !== options.expectedPort) {
    throw new ReconcileEntryError('bad-registry', `port:${port}`)
  }
  if (!Array.isArray(record.entries)) {
    throw new ReconcileEntryError('bad-plan', 'entries')
  }
  return {
    registry: record.registry,
    entries: record.entries.map(assertEntry),
  }
}

interface PackageJsonShape {
  dependencies?: Record<string, string>
}

async function readPackageJson(profileDir: string): Promise<PackageJsonShape> {
  try {
    const text = await readFile(join(profileDir, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as PackageJsonShape
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function installedVersion(manifest: PackageJsonShape, name: string): string | undefined {
  const raw = manifest.dependencies?.[name]
  if (typeof raw !== 'string' || raw === '') return undefined
  if (/^\d/.test(raw)) return raw
  const npmExact = /^npm:(\d.*)$/.exec(raw)
  if (npmExact) return npmExact[1]
  return raw
}

async function readInstalledIntegrity(
  profileDir: string,
  name: string,
  version: string,
): Promise<string | undefined> {
  try {
    const text = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    return readLockfileIntegrity(text, name, version)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Open failed/intent ops whose opId was never closed — restore their snapshots. */
export function openFailedSnapshots(ops: readonly SyncOp[]): { opId: string; name: string }[] {
  const byOp = new Map<string, SyncOp[]>()
  for (const op of ops) {
    if (op.opId === undefined) continue
    const list = byOp.get(op.opId) ?? []
    list.push(op)
    byOp.set(op.opId, list)
  }
  const out: { opId: string; name: string }[] = []
  for (const [opId, list] of byOp) {
    const types = new Set(list.map((o) => o.type))
    if (types.has('done') || types.has('recovered') || types.has('abandoned') || types.has('removed')) continue
    if (!types.has('failed') && !types.has('intent')) continue
    const named = list.find((o) => o.type === 'failed') ?? list.find((o) => o.type === 'intent')
    if (named === undefined) continue
    out.push({ opId, name: named.name })
  }
  return out
}

async function clearRestoreQueue(home: string): Promise<void> {
  await writeFile(restoreQueuePath(home), '', { mode: 0o600 })
}

async function executeQueuedRestores(home: string, profileDir: string): Promise<number> {
  const queued = await listQueuedRestores(home)
  for (const entry of queued) {
    await restoreSnapshotFiles(home, profileDir, entry.snapshotId)
  }
  if (queued.length > 0) await clearRestoreQueue(home)
  return queued.length
}

async function completeOpenFailed(
  home: string,
  profileDir: string,
  at: number,
): Promise<number> {
  const ops = await readOps(home)
  const open = openFailedSnapshots(ops)
  for (const item of open) {
    await restoreSnapshotFiles(home, profileDir, item.opId)
    await appendOp(home, {
      type: 'recovered',
      name: item.name,
      opId: item.opId,
      reason: 'reconcile-open-failed',
      at,
    })
  }
  return open.length
}

async function repairAfterFailure(
  input: RunReconcileEntryInput,
  registry: string,
  remainingMs: number,
): Promise<void> {
  const offline = buildPnpmRepairArgv({ offline: true, registry })
  const offlineResult = await input.pnpm.run(offline, {
    cwd: input.profileDir,
    env: input.env,
    timeoutMs: Math.min(input.pkgTimeoutMs ?? PKG_TIMEOUT_MS, Math.max(1, remainingMs)),
  })
  if (offlineResult.code === 0) return
  const online = buildPnpmRepairArgv({ offline: false, registry })
  await input.pnpm.run(online, {
    cwd: input.profileDir,
    env: input.env,
    timeoutMs: Math.min(input.pkgTimeoutMs ?? PKG_TIMEOUT_MS, Math.max(1, remainingMs)),
  })
}

async function applyOneEntry(
  entry: ReconcilePlanEntry,
  registry: string,
  input: RunReconcileEntryInput,
  deadline: number,
): Promise<ReconcileEntryResult> {
  const at = () => nowMs(input)
  const ops = await readOps(input.home)
  if (entry.action === 'install' && isUserRemoved(ops, entry.name)) {
    return { name: entry.name, action: entry.action, outcome: 'skipped', reason: 'user-removed' }
  }

  const manifest = await readPackageJson(input.profileDir)
  const current = installedVersion(manifest, entry.name)
  if (entry.action === 'install') {
    if (current !== undefined) {
      return { name: entry.name, action: entry.action, outcome: 'skipped', reason: 'already-present' }
    }
  } else if (current === undefined || current !== entry.fromVersion) {
    return { name: entry.name, action: entry.action, outcome: 'skipped', reason: 'from-version-mismatch' }
  }

  const opId = newOpId()
  const intentAt = at()
  await writeProfileSnapshot(input.home, input.profileDir, opId)
  await appendOp(input.home, {
    type: 'intent',
    name: entry.name,
    version: entry.version,
    action: entry.action,
    opId,
    at: intentAt,
  })

  const pkgTimeout = input.pkgTimeoutMs ?? PKG_TIMEOUT_MS
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    await restoreSnapshotFiles(input.home, input.profileDir, opId)
    await repairAfterFailure(input, registry, pkgTimeout)
    await appendOp(input.home, {
      type: 'failed', name: entry.name, version: entry.version, action: entry.action,
      reason: 'timeout', opId, at: at(),
    })
    return { name: entry.name, action: entry.action, outcome: 'failed', reason: 'timeout', opId }
  }

  const argv = buildPnpmAddArgv({
    registry,
    spec: entry.spec,
    allowedBuilds: entry.allowedBuilds,
  })
  const run = await input.pnpm.run(argv, {
    cwd: input.profileDir,
    env: input.env,
    timeoutMs: Math.min(pkgTimeout, remaining),
  })

  if (run.code !== 0) {
    await restoreSnapshotFiles(input.home, input.profileDir, opId)
    await repairAfterFailure(input, registry, Math.min(pkgTimeout, Math.max(1, deadline - Date.now())))
    await appendOp(input.home, {
      type: 'failed', name: entry.name, version: entry.version, action: entry.action,
      reason: 'pnpm-failed', opId, at: at(),
    })
    return { name: entry.name, action: entry.action, outcome: 'failed', reason: 'pnpm-failed', opId }
  }

  const after = await readPackageJson(input.profileDir)
  const installed = installedVersion(after, entry.name)
  if (installed !== entry.version) {
    await restoreSnapshotFiles(input.home, input.profileDir, opId)
    await repairAfterFailure(input, registry, Math.min(pkgTimeout, Math.max(1, deadline - Date.now())))
    await appendOp(input.home, {
      type: 'failed', name: entry.name, version: entry.version, action: entry.action,
      reason: 'version-mismatch', opId, at: at(),
    })
    return { name: entry.name, action: entry.action, outcome: 'failed', reason: 'version-mismatch', opId }
  }

  const integrity = await readInstalledIntegrity(input.profileDir, entry.name, entry.version)
  const expected = planSha512ToIntegrity(entry.sha512)
  if (integrity === undefined || integrity !== expected) {
    await restoreSnapshotFiles(input.home, input.profileDir, opId)
    await repairAfterFailure(input, registry, Math.min(pkgTimeout, Math.max(1, deadline - Date.now())))
    await appendOp(input.home, {
      type: 'failed', name: entry.name, version: entry.version, action: entry.action,
      reason: 'integrity-mismatch', opId, at: at(),
    })
    return { name: entry.name, action: entry.action, outcome: 'failed', reason: 'integrity-mismatch', opId }
  }

  await appendOp(input.home, {
    type: 'done',
    name: entry.name,
    version: entry.version,
    action: entry.action,
    opId,
    at: at(),
  })
  return { name: entry.name, action: entry.action, outcome: 'done', opId }
}

/**
 * Run pre-start reconcile as the account.
 * Order: queued restores → open failed sync restore → user-removal detect → plan apply.
 * Failures leave `outcome: 'error'` but callers start the instance anyway.
 */
export async function runReconcileEntry(input: RunReconcileEntryInput): Promise<ReconcileEntryReport> {
  const plan = assertReconcilePlan(input.plan, {
    allowedHosts: input.allowedHosts,
    expectedPort: input.expectedPort,
  })
  const restoredQueued = await executeQueuedRestores(input.home, input.profileDir)
  const restoredFailed = await completeOpenFailed(input.home, input.profileDir, nowMs(input))
  await detectUserRemovals({ home: input.home, profileDir: input.profileDir, now: nowMs(input) })

  const totalTimeout = input.totalTimeoutMs ?? TOTAL_TIMEOUT_MS
  const deadline = Date.now() + totalTimeout
  const results: ReconcileEntryResult[] = []
  for (const entry of plan.entries) {
    if (Date.now() >= deadline) {
      results.push({
        name: entry.name,
        action: entry.action,
        outcome: 'failed',
        reason: 'timeout',
      })
      continue
    }
    results.push(await applyOneEntry(entry, plan.registry, input, deadline))
  }

  const failed = results.some((r) => r.outcome === 'failed')
  return {
    outcome: failed ? 'error' : 'ok',
    results,
    restoredFailed,
    restoredQueued,
  }
}
