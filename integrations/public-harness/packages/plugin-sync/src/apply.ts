/**
 * Apply one sync plan entry: preconditions under package.json lock, then
 * install disabled → re-check → enable (P0.7 / design § Default installs).
 * Idle gating lives in idle.ts (1D.4); snapshots/recovery in snapshots.ts (1D.5).
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendOp,
  isUserRemoved,
  readOps,
} from './oplog.ts'
import { restoreSnapshotFiles, writeProfileSnapshot } from './snapshots.ts'

export type SyncAction = 'install' | 'update' | 'downgrade'

export interface SyncPlanEntry {
  readonly name: string
  readonly version: string
  readonly fromVersion: string | null
  readonly sha512: string
  readonly action: SyncAction
  readonly allowedBuilds: readonly string[]
}

/** Local clear learned from admin reset / My plugins re-enable (optional on plan). */
export interface SyncPlanClear {
  readonly name: string
  readonly kind: 'reset' | 're-enable'
}

export interface SyncPlan {
  readonly entries: readonly SyncPlanEntry[]
  /** When present, stamp local reset / re-enable before apply. */
  readonly clears?: readonly SyncPlanClear[]
}

/** Subset of plugin-manager change results we branch on. */
export interface ChangeResultLike {
  readonly application: string
  readonly changed?: boolean
  readonly error?: { readonly code?: string; readonly diagnostic?: string }
}

export interface PluginManagerLike {
  installBundle(
    spec: string,
    options?: {
      registry?: string
      enabled?: boolean
      approvedBuilds?: readonly string[]
    },
  ): Promise<ChangeResultLike>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResultLike>
  removeBundle(name: string): Promise<ChangeResultLike>
}

export type FileLockFn = <T>(filename: string, operation: () => Promise<T>) => Promise<T>

export interface ApplyDeps {
  readonly home: string
  readonly profileDir: string
  readonly manager: PluginManagerLike
  readonly registry: string
  readonly withFileLock: FileLockFn
  readonly now?: () => number
}

export type ApplyOutcome = 'done' | 'skipped' | 'abandoned' | 'failed'

export interface ApplyResult {
  readonly outcome: ApplyOutcome
  readonly reason?: string
  readonly name: string
  readonly action: SyncAction
  readonly opId?: string
}

function nowMs(deps: ApplyDeps): number {
  return deps.now?.() ?? Date.now()
}

function newOpId(): string {
  return randomBytes(8).toString('hex')
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

/** Installed dependency version from package.json (exact string as recorded). */
function installedVersion(manifest: PackageJsonShape, name: string): string | undefined {
  const raw = manifest.dependencies?.[name]
  if (typeof raw !== 'string' || raw === '') return undefined
  // Strip a leading npm: / workspace: / etc. only when it is a simple exact pin.
  if (/^\d/.test(raw)) return raw
  const npmExact = /^npm:(\d.*)$/.exec(raw)
  if (npmExact) return npmExact[1]
  return raw
}

/** Convert plan hex sha512 (128 chars) to npm `sha512-<base64>` integrity. */
export function planSha512ToIntegrity(sha512: string): string {
  if (/^sha512-/.test(sha512)) return sha512
  if (!/^[0-9a-f]{128}$/i.test(sha512)) return sha512
  return `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`
}

/**
 * Read resolution integrity for `name@version` from a pnpm-lock.yaml packages section.
 * Tolerates quoted scoped keys and peer-suffix keys (`name@version(...)`).
 */
export function readLockfileIntegrity(lockText: string, name: string, version: string): string | undefined {
  const prefix = `${name}@${version}`
  const lines = lockText.split(/\r?\n/)
  let inPackages = false
  let capturing = false
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages && /^[^\s]/.test(line) && !/^packages:/.test(line)) {
      // left packages section
      inPackages = false
      capturing = false
    }
    if (!inPackages) continue
    const keyMatch = /^\s{2}('([^']+)'|([^:]+)):\s*$/.exec(line)
    if (keyMatch) {
      const key = keyMatch[2] ?? keyMatch[3] ?? ''
      capturing = key === prefix || key.startsWith(`${prefix}(`)
      continue
    }
    if (capturing) {
      const integ = /integrity:\s*(sha512-[A-Za-z0-9+/=]+)/.exec(line)
      if (integ) return integ[1]
    }
  }
  return undefined
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

function refusalCode(result: ChangeResultLike): string | undefined {
  if (result.application === 'failed' && result.error?.code) return result.error.code
  return undefined
}

/** GET /sync plan fetch (idle gate + loop in idle.ts). */
export async function pollSyncPlan(
  syncUrl: string,
  options: { fetchPlan: (url: string) => Promise<SyncPlan> },
): Promise<SyncPlan> {
  return options.fetchPlan(syncUrl)
}

interface PreconditionOk {
  readonly ok: true
  readonly opId: string
  readonly intentAt: number
}
interface PreconditionSkip {
  readonly ok: false
  readonly reason: string
}
type Precondition = PreconditionOk | PreconditionSkip

/**
 * Under package.json lock: check preconditions → write snapshot + intent → release.
 * Design: check → intent+snapshot → release, then apply outside the lock.
 */
async function checkPreconditionsAndIntent(
  entry: SyncPlanEntry,
  deps: ApplyDeps,
): Promise<Precondition> {
  return deps.withFileLock(join(deps.profileDir, 'package.json'), async () => {
    const manifest = await readPackageJson(deps.profileDir)
    const current = installedVersion(manifest, entry.name)
    const ops = await readOps(deps.home)

    if (entry.action === 'install') {
      if (current !== undefined) return { ok: false, reason: 'already-present' }
      if (isUserRemoved(ops, entry.name)) return { ok: false, reason: 'user-removed' }
    } else {
      // update / downgrade: must be installed at exact fromVersion
      if (current === undefined || current !== entry.fromVersion) {
        return { ok: false, reason: 'from-version-mismatch' }
      }
    }

    const opId = newOpId()
    const intentAt = nowMs(deps)
    await writeProfileSnapshot(deps.home, deps.profileDir, opId)
    await appendOp(deps.home, {
      type: 'intent',
      name: entry.name,
      version: entry.version,
      action: entry.action,
      opId,
      at: intentAt,
    })
    return { ok: true, opId, intentAt }
  })
}

async function recheckAfterInstall(
  entry: SyncPlanEntry,
  deps: ApplyDeps,
  intentAt: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return deps.withFileLock(join(deps.profileDir, 'package.json'), async () => {
    const manifest = await readPackageJson(deps.profileDir)
    const current = installedVersion(manifest, entry.name)
    if (current !== entry.version) {
      return { ok: false, reason: 'version-mismatch' }
    }
    const integrity = await readInstalledIntegrity(deps.profileDir, entry.name, entry.version)
    const expected = planSha512ToIntegrity(entry.sha512)
    if (integrity === undefined || integrity !== expected) {
      return { ok: false, reason: 'integrity-mismatch' }
    }
    const ops = await readOps(deps.home)
    // User removal recorded after intent (race with Discover / hand edit).
    for (const op of ops) {
      if (op.name === entry.name && op.type === 'user-removed' && op.at >= intentAt) {
        return { ok: false, reason: 'user-removed' }
      }
    }
    return { ok: true }
  })
}

/**
 * Apply one plan entry. Integrity mismatch never enables the bundle.
 */
export async function applySyncEntry(
  entry: SyncPlanEntry,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const pre = await checkPreconditionsAndIntent(entry, deps)
  if (!pre.ok) {
    return { outcome: 'skipped', reason: pre.reason, name: entry.name, action: entry.action }
  }

  const { opId, intentAt } = pre

  const installOpts = {
    registry: deps.registry,
    enabled: false as const,
    approvedBuilds: [...entry.allowedBuilds],
  }

  if (entry.action === 'update' || entry.action === 'downgrade') {
    const removed = await deps.manager.removeBundle(entry.name)
    const code = refusalCode(removed)
    if (code === 'not-removable') {
      // Close the intent without type 'failed' — abandoned ≠ default-state failed (1D.3 Important #1).
      await appendOp(deps.home, {
        type: 'abandoned',
        name: entry.name,
        version: entry.version,
        action: entry.action,
        reason: 'not-removable',
        opId,
        at: nowMs(deps),
      })
      return {
        outcome: 'abandoned',
        reason: 'not-removable',
        name: entry.name,
        action: entry.action,
        opId,
      }
    }
    if (removed.application === 'failed') {
      await appendOp(deps.home, {
        type: 'failed',
        name: entry.name,
        version: entry.version,
        action: entry.action,
        reason: code ?? 'remove-failed',
        opId,
        at: nowMs(deps),
      })
      return {
        outcome: 'failed',
        reason: code ?? 'remove-failed',
        name: entry.name,
        action: entry.action,
        opId,
      }
    }
  }

  const installed = await deps.manager.installBundle(
    `${entry.name}@${entry.version}`,
    installOpts,
  )
  const installCode = refusalCode(installed)
  if (installCode === 'already-installed') {
    // Close the intent without type 'failed' — abandoned ≠ default-state failed (1D.3 Important #1).
    await appendOp(deps.home, {
      type: 'abandoned',
      name: entry.name,
      version: entry.version,
      action: entry.action,
      reason: 'already-installed',
      opId,
      at: nowMs(deps),
    })
    return {
      outcome: 'abandoned',
      reason: 'already-installed',
      name: entry.name,
      action: entry.action,
      opId,
    }
  }
  if (installed.application === 'failed') {
    // Recovery: removeBundle ok + installBundle fail → reinstall fromVersion;
    // if that fails → restore both files from snapshot; leave intent failed for reconcile.
    if (
      (entry.action === 'update' || entry.action === 'downgrade')
      && entry.fromVersion != null
      && entry.fromVersion !== ''
    ) {
      const restored = await deps.manager.installBundle(`${entry.name}@${entry.fromVersion}`, {
        ...installOpts,
        approvedBuilds: [...entry.allowedBuilds],
      })
      if (restored.application === 'failed') {
        await restoreSnapshotFiles(deps.home, deps.profileDir, opId)
      }
    }
    await appendOp(deps.home, {
      type: 'failed',
      name: entry.name,
      version: entry.version,
      action: entry.action,
      reason: installCode ?? 'install-failed',
      opId,
      at: nowMs(deps),
    })
    return {
      outcome: 'failed',
      reason: installCode ?? 'install-failed',
      name: entry.name,
      action: entry.action,
      opId,
    }
  }

  const check = await recheckAfterInstall(entry, deps, intentAt)
  if (!check.ok) {
    // Never enable on failed check — plugin never started / never enabled.
    await deps.manager.removeBundle(entry.name)
    if (
      check.reason === 'integrity-mismatch'
      && (entry.action === 'update' || entry.action === 'downgrade')
      && entry.fromVersion != null
      && entry.fromVersion !== ''
    ) {
      const restored = await deps.manager.installBundle(`${entry.name}@${entry.fromVersion}`, {
        registry: deps.registry,
        enabled: false,
        approvedBuilds: [...entry.allowedBuilds],
      })
      if (restored.application === 'failed') {
        await restoreSnapshotFiles(deps.home, deps.profileDir, opId)
      }
    }
    await appendOp(deps.home, {
      type: 'failed',
      name: entry.name,
      version: entry.version,
      action: entry.action,
      reason: check.reason,
      opId,
      at: nowMs(deps),
    })
    return {
      outcome: 'failed',
      reason: check.reason,
      name: entry.name,
      action: entry.action,
      opId,
    }
  }

  const enabled = await deps.manager.setBundleEnabled(entry.name, true)
  if (enabled.application === 'failed') {
    await appendOp(deps.home, {
      type: 'failed',
      name: entry.name,
      version: entry.version,
      action: entry.action,
      reason: refusalCode(enabled) ?? 'enable-failed',
      opId,
      at: nowMs(deps),
    })
    return {
      outcome: 'failed',
      reason: refusalCode(enabled) ?? 'enable-failed',
      name: entry.name,
      action: entry.action,
      opId,
    }
  }

  await appendOp(deps.home, {
    type: 'done',
    name: entry.name,
    version: entry.version,
    action: entry.action,
    opId,
    at: nowMs(deps),
  })
  return { outcome: 'done', name: entry.name, action: entry.action, opId }
}
