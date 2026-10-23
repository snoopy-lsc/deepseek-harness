/**
 * Sync plan + report + reconcile-plan (design § Default installs, sync, and reconcile).
 * Plan is a request, not an order. opted-out is derived only from user-removed op-log records.
 */
import { defaultsVisibleToUser } from './defaults.ts'
import { compareSemVerDescending } from './index-builder.ts'
import type { PluginsDbHandle } from './migrate.ts'

export type SyncAction = 'install' | 'update' | 'downgrade'

export type SyncPlanErrorCode = 'bad-registry' | 'no-endpoint' | 'bad-report'

/** Wire-facing refusal for sync / reconcile plan ops. */
export class SyncPlanError extends Error {
  readonly status: number
  readonly code: SyncPlanErrorCode
  readonly detail: string | undefined
  constructor(code: SyncPlanErrorCode, detail?: string, status?: number) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = status ?? (code === 'bad-registry' || code === 'bad-report' ? 400 : 409)
  }
}

export interface SyncPlanEntry {
  readonly name: string
  readonly version: string
  readonly fromVersion: string | null
  readonly sha512: string
  readonly action: SyncAction
  readonly allowedBuilds: readonly string[]
}

export interface SyncPlan {
  readonly entries: readonly SyncPlanEntry[]
}

export interface ReconcilePlanEntry extends SyncPlanEntry {
  /** `name@exact-semver` for the provisioner / pnpm add. */
  readonly spec: string
}

export interface ReconcilePlan {
  readonly registry: string
  readonly entries: readonly ReconcilePlanEntry[]
}

export interface SyncReportInstalled {
  readonly name: string
  readonly version: string
}

export interface SyncReportResult {
  readonly name: string
  readonly action?: string
  readonly outcome: string
  readonly reason?: string
}

export interface SyncReportOpLog {
  readonly type: string
  readonly name: string
  readonly version?: string
}

export interface SyncReport {
  readonly installed: readonly SyncReportInstalled[]
  readonly opLog: readonly SyncReportOpLog[]
  readonly results: readonly SyncReportResult[]
}

export interface ApplySyncReportResult {
  readonly optedOut: readonly string[]
  readonly failed: readonly string[]
  readonly userManaged: readonly string[]
  readonly installed: readonly string[]
  readonly installedCount: number
}

export interface BuildSyncPlanInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly groups: ReadonlySet<string>
}

export interface ApplySyncReportInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly groups: ReadonlySet<string>
  readonly report: SyncReport
  readonly now?: number
}

export interface ReconcilePlanInput {
  readonly db: PluginsDbHandle
  readonly userId: string
  readonly groups: ReadonlySet<string>
  /** Host written into the registry URL; must be `127.0.0.1` or `hostAddress`. */
  readonly registryHost: string
  /** Container / pasta hostAddress; when set, also accepted as registryHost. */
  readonly hostAddress?: string
}

interface ListedVersionRow {
  version: string
  artifact_sha512: string | null
  allowed_builds: string
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function parseAllowedBuilds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function loadListedVersion(db: PluginsDbHandle, packageId: string): ListedVersionRow | undefined {
  return db.db.prepare(
    `SELECT v.version AS version, v.artifact_sha512 AS artifact_sha512, v.allowed_builds AS allowed_builds
     FROM plugin_listing l
     JOIN plugin_version v ON v.id = l.current_version_id
     WHERE l.package_id = ?`,
  ).get(packageId) as ListedVersionRow | undefined
}

function upsertState(
  db: PluginsDbHandle,
  opts: {
    userId: string
    packageId: string
    state: string
    installedVersion: string | null
    targetVersion: string | null
    lastError: string | null
    now: number
  },
): void {
  db.db.prepare(
    `INSERT INTO plugin_default_state
       (user_id, package_id, state, installed_version, target_version, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, package_id) DO UPDATE SET
       state = excluded.state,
       installed_version = excluded.installed_version,
       target_version = excluded.target_version,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    opts.userId,
    opts.packageId,
    opts.state,
    opts.installedVersion,
    opts.targetVersion,
    opts.lastError,
    opts.now,
  )
}

/**
 * Build the sync plan for one user: install / update / downgrade requests for
 * visible defaults (skips opted-out and user-managed; omits already-current).
 */
export function buildSyncPlan(input: BuildSyncPlanInput): SyncPlan {
  const visible = defaultsVisibleToUser(input.db, input.userId, input.groups)
  const entries: SyncPlanEntry[] = []

  for (const def of visible) {
    if (def.state === 'opted-out' || def.state === 'user-managed') continue

    const listed = loadListedVersion(input.db, def.packageId)
    if (listed === undefined || listed.artifact_sha512 == null || listed.artifact_sha512 === '') continue

    const allowedBuilds = parseAllowedBuilds(listed.allowed_builds)
    const installed = input.db.db.prepare(
      'SELECT installed_version FROM plugin_default_state WHERE user_id = ? AND package_id = ?',
    ).get(input.userId, def.packageId) as { installed_version: string | null } | undefined
    const fromVersion = installed?.installed_version ?? null

    if (fromVersion === null || fromVersion === '') {
      entries.push({
        name: def.name,
        version: listed.version,
        fromVersion: null,
        sha512: listed.artifact_sha512,
        action: 'install',
        allowedBuilds,
      })
      continue
    }

    if (fromVersion === listed.version) continue

    const cmp = compareSemVerDescending(listed.version, fromVersion)
    // compareSemVerDescending(a,b) < 0 ⇒ a > b
    const action: SyncAction = cmp < 0 ? 'update' : 'downgrade'
    entries.push({
      name: def.name,
      version: listed.version,
      fromVersion,
      sha512: listed.artifact_sha512,
      action,
      allowedBuilds,
    })
  }

  return { entries }
}

function assertSyncReport(value: unknown): SyncReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncPlanError('bad-report', 'body')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.installed) || !Array.isArray(record.opLog) || !Array.isArray(record.results)) {
    throw new SyncPlanError('bad-report', 'shape')
  }
  const installed: SyncReportInstalled[] = []
  for (const item of record.installed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SyncPlanError('bad-report', 'installed')
    }
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || typeof row.version !== 'string') {
      throw new SyncPlanError('bad-report', 'installed')
    }
    installed.push({ name: row.name, version: row.version })
  }
  const opLog: SyncReportOpLog[] = []
  for (const item of record.opLog) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SyncPlanError('bad-report', 'opLog')
    }
    const row = item as Record<string, unknown>
    if (typeof row.type !== 'string' || typeof row.name !== 'string') {
      throw new SyncPlanError('bad-report', 'opLog')
    }
    opLog.push({
      type: row.type,
      name: row.name,
      version: typeof row.version === 'string' ? row.version : undefined,
    })
  }
  const results: SyncReportResult[] = []
  for (const item of record.results) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SyncPlanError('bad-report', 'results')
    }
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || typeof row.outcome !== 'string') {
      throw new SyncPlanError('bad-report', 'results')
    }
    results.push({
      name: row.name,
      outcome: row.outcome,
      action: typeof row.action === 'string' ? row.action : undefined,
      reason: typeof row.reason === 'string' ? row.reason : undefined,
    })
  }
  return { installed, opLog, results }
}

/**
 * Apply a sync plugin report: opted-out **only** from `user-removed` records;
 * open/failed applies → `failed`; derive `user-managed` + installed count for `max_installed`.
 */
export function applySyncReport(input: ApplySyncReportInput): ApplySyncReportResult {
  const report = assertSyncReport(input.report)
  const now = input.now ?? Date.now()
  const visible = defaultsVisibleToUser(input.db, input.userId, input.groups)
  const byName = new Map(visible.map((row) => [row.name, row]))

  const userRemoved = new Set(
    report.opLog.filter((entry) => entry.type === 'user-removed').map((entry) => entry.name),
  )
  const failedNames = new Set<string>()
  for (const result of report.results) {
    if (result.outcome === 'failed' || result.outcome === 'open') failedNames.add(result.name)
  }
  for (const entry of report.opLog) {
    if (entry.type === 'failed') failedNames.add(entry.name)
  }
  // Open intent without a later done/recovered/failed/removed for that name stays failed.
  const closed = new Set(
    report.opLog
      .filter((entry) => entry.type === 'done' || entry.type === 'recovered' || entry.type === 'failed' || entry.type === 'removed')
      .map((entry) => entry.name),
  )
  for (const entry of report.opLog) {
    if (entry.type === 'intent' && !closed.has(entry.name) && !report.results.some((r) => r.name === entry.name && r.outcome === 'done')) {
      failedNames.add(entry.name)
    }
  }

  const installedMap = new Map(report.installed.map((row) => [row.name, row.version]))
  const listedVersion = new Map<string, string>()
  for (const def of visible) {
    const listed = loadListedVersion(input.db, def.packageId)
    if (listed !== undefined) listedVersion.set(def.name, listed.version)
  }

  const optedOut: string[] = []
  const failed: string[] = []
  const userManaged: string[] = []
  const installedNames: string[] = []

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    for (const [name, def] of byName) {
      if (userRemoved.has(name)) {
        upsertState(input.db, {
          userId: input.userId,
          packageId: def.packageId,
          state: 'opted-out',
          installedVersion: null,
          targetVersion: null,
          lastError: null,
          now,
        })
        optedOut.push(name)
        continue
      }

      if (failedNames.has(name)) {
        const current = installedMap.get(name) ?? null
        upsertState(input.db, {
          userId: input.userId,
          packageId: def.packageId,
          state: 'failed',
          installedVersion: current,
          targetVersion: listedVersion.get(name) ?? null,
          lastError: 'sync-failed',
          now,
        })
        failed.push(name)
        continue
      }

      const have = installedMap.get(name)
      const want = listedVersion.get(name)
      if (have !== undefined && want !== undefined && have === want) {
        upsertState(input.db, {
          userId: input.userId,
          packageId: def.packageId,
          state: 'installed',
          installedVersion: have,
          targetVersion: want,
          lastError: null,
          now,
        })
        installedNames.push(name)
        continue
      }

      if (have !== undefined && want !== undefined && have !== want) {
        upsertState(input.db, {
          userId: input.userId,
          packageId: def.packageId,
          state: 'user-managed',
          installedVersion: have,
          targetVersion: want,
          lastError: null,
          now,
        })
        userManaged.push(name)
      }
    }

    const installedCount = report.installed.length
    const lastReport = JSON.stringify({
      at: now,
      installedCount,
      optedOut,
      failed,
      userManaged,
      installed: installedNames,
    })
    input.db.db.prepare(
      'UPDATE plugin_endpoint SET last_report = ? WHERE user_id = ?',
    ).run(lastReport, input.userId)

    input.db.db.exec('COMMIT')
    return { optedOut, failed, userManaged, installed: installedNames, installedCount }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}

function assertRegistryHost(registryHost: string, hostAddress: string | undefined): string {
  if (typeof registryHost !== 'string' || !IPV4.test(registryHost)) {
    throw new SyncPlanError('bad-registry', 'host')
  }
  if (registryHost === '127.0.0.1') return registryHost
  if (hostAddress !== undefined && registryHost === hostAddress && IPV4.test(hostAddress)) {
    return registryHost
  }
  throw new SyncPlanError('bad-registry', registryHost)
}

/**
 * Same plan shape for the provisioner. Registry is the user's own market port on
 * `127.0.0.1` or `hostAddress`; anything else is rejected.
 */
export function reconcilePlan(input: ReconcilePlanInput): ReconcilePlan {
  const host = assertRegistryHost(input.registryHost, input.hostAddress)
  const endpoint = input.db.db.prepare(
    'SELECT port FROM plugin_endpoint WHERE user_id = ?',
  ).get(input.userId) as { port: number } | undefined
  if (endpoint === undefined) throw new SyncPlanError('no-endpoint', input.userId)

  const plan = buildSyncPlan({
    db: input.db,
    userId: input.userId,
    groups: input.groups,
  })
  const registry = `http://${host}:${endpoint.port}/npm/`
  return {
    registry,
    entries: plan.entries.map((entry) => ({
      ...entry,
      spec: `${entry.name}@${entry.version}`,
    })),
  }
}

/** Thin control-socket verb: `reconcile-plan(userId)` — validates registry and returns the plan. */
export function handleReconcilePlan(
  input: ReconcilePlanInput,
): ReconcilePlan {
  return reconcilePlan(input)
}

/** Parse an unknown JSON body into a SyncReport (throws SyncPlanError). */
export function parseSyncReport(value: unknown): SyncReport {
  return assertSyncReport(value)
}
