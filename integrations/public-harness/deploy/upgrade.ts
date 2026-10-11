/** Versioned upgrade and rollback: manifest validation, canary preflight, staged rollout, code-only rollback. */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { parseUserId, type UserId } from '../packages/contracts/src/index.ts'

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const PACKAGE = /^(?:@[a-z0-9-]+\/)?[a-z0-9._-]+$/
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Pinned versions of one released set. */
export interface ReleaseSet {
  readonly release: string
  readonly harness: { readonly package: string; readonly version: string }
  readonly image: string
  readonly pluginApi: Readonly<Record<string, string>>
  readonly bundles: Readonly<Record<string, string>>
}

/** The deployment manifest; public enrollment is never opened by it. */
export interface ReleaseManifest extends ReleaseSet {
  readonly schema: 1
  readonly previous: ReleaseSet | null
  readonly publicEnrollment: 'closed'
}

function exact(value: unknown, keys: readonly string[], context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${context} has unexpected or missing fields`)
  return record
}

function versions(value: unknown, context: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length === 0) throw new Error(`${context} must list pinned versions`)
  const result: Record<string, string> = {}
  for (const [name, version] of Object.entries(value)) {
    if (!PACKAGE.test(name) || typeof version !== 'string' || !VERSION.test(version)) throw new Error(`${context} must pin exact versions`)
    result[name] = version
  }
  return result
}

function releaseSet(value: Record<string, unknown>, context: string): ReleaseSet {
  const harness = exact(value.harness, ['package', 'version'], `${context}.harness`)
  if (typeof value.release !== 'string' || !RELEASE_ID.test(value.release)) throw new Error(`${context}.release is invalid`)
  if (typeof harness.package !== 'string' || !PACKAGE.test(harness.package) || typeof harness.version !== 'string' || !VERSION.test(harness.version)) {
    throw new Error(`${context}.harness must pin an exact version`)
  }
  if (typeof value.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,255}$/.test(value.image) || !/[:@]/.test(value.image)) throw new Error(`${context}.image must be a tagged or digest-pinned reference`)
  return { release: value.release, harness: { package: harness.package, version: harness.version }, image: value.image,
    pluginApi: versions(value.pluginApi, `${context}.pluginApi`), bundles: versions(value.bundles, `${context}.bundles`) }
}

/** Validate a manifest strictly: exact pins, no ranges, enrollment closed. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const record = exact(value, ['schema', 'release', 'harness', 'image', 'pluginApi', 'bundles', 'previous', 'publicEnrollment'], 'manifest')
  if (record.schema !== 1) throw new Error('unsupported manifest schema')
  if (record.publicEnrollment !== 'closed') throw new Error('the manifest cannot open public enrollment; use the release check')
  const previous = record.previous === null ? null
    : releaseSet(exact(record.previous, ['release', 'harness', 'image', 'pluginApi', 'bundles'], 'previous'), 'previous')
  return { schema: 1, ...releaseSet(record, 'manifest'), previous, publicEnrollment: 'closed' }
}

/** Canary checks run against a nonproduction profile that has the candidate Harness and every pinned bundle. */
export interface CanaryProbe {
  /** Versions of the plugin-facing interfaces the candidate Harness actually provides. */
  installedPluginApi(): Promise<Readonly<Record<string, string>>>
  /** Versions of the bundles actually installed in the canary profile. */
  installedBundles(): Promise<Readonly<Record<string, string>>>
  /** Run the candidate's Session migration against a copy of the canary's `DSH_HOME`. */
  migrateSessions(): Promise<void>
  readonly flows: Readonly<Record<'login' | 'modelCall' | 'terminal' | 'session' | 'pluginLoading', () => Promise<void>>>
}

/** Result of `preflightUpgrade`; names only, never values from user data. */
export interface CompatibilityReport {
  readonly ok: boolean
  readonly failures: readonly string[]
}

/** Prove a candidate release in a canary profile before any user instance is touched. */
export async function preflightUpgrade(manifest: ReleaseManifest, probe: CanaryProbe): Promise<CompatibilityReport> {
  const failures: string[] = []
  const attempt = async (name: string, action: () => Promise<void>): Promise<void> => {
    try { await action() } catch { failures.push(name) }
  }
  const same = (expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): boolean =>
    Object.entries(expected).every(([name, version]) => actual[name] === version)
  await attempt('plugin-api', async () => { if (!same(manifest.pluginApi, await probe.installedPluginApi())) throw new Error('mismatch') })
  await attempt('bundle-versions', async () => { if (!same(manifest.bundles, await probe.installedBundles())) throw new Error('mismatch') })
  // Stop before exercising anything else: a plugin interface mismatch makes later results meaningless.
  if (failures.length > 0) return { ok: false, failures }
  await attempt('session-migration', () => probe.migrateSessions())
  if (failures.length > 0) return { ok: false, failures }
  for (const [name, flow] of Object.entries(probe.flows)) await attempt(name, flow)
  return { ok: failures.length === 0, failures }
}

/** Atomically point `link` at `target`; the previous target stays on disk. */
export async function switchRelease(link: string, target: string): Promise<void> {
  if (!isAbsolute(link) || !isAbsolute(target)) throw new Error('release paths must be absolute')
  const current = await lstat(link).catch(() => undefined)
  if (current !== undefined && !current.isSymbolicLink()) throw new Error('refusing to replace a non-link release path')
  const temporary = `${link}.${randomBytes(6).toString('hex')}`
  await symlink(target, temporary)
  try { await rename(temporary, link) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

/** The release directory the link currently selects. */
export async function currentRelease(link: string): Promise<string | undefined> {
  return await readlink(link).catch(() => undefined)
}

/** Persisted rollout progress so an interrupted rollout resumes instead of repeating or skipping users. */
export interface RolloutState {
  readonly release: string
  readonly upgraded: readonly UserId[]
  readonly failed?: UserId
}

function parseRolloutState(text: string): RolloutState {
  const record = JSON.parse(text) as Record<string, unknown>
  if (typeof record.release !== 'string' || !Array.isArray(record.upgraded)) throw new Error('invalid rollout state')
  return { release: record.release, upgraded: record.upgraded.map(item => parseUserId(String(item))),
    ...typeof record.failed === 'string' ? { failed: parseUserId(record.failed) } : {} }
}

async function saveState(path: string, state: RolloutState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(6).toString('hex')}`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Operations on live instances; none of them can touch `DSH_HOME` or Git workspaces. */
export interface RolloutDeps {
  /** Stop one instance; the next wake starts it from the currently selected release. */
  stop(userId: UserId): Promise<void>
  /** Start the instance again and report whether it became healthy. */
  wake(userId: UserId): Promise<boolean>
}

export interface RolloutOptions {
  readonly manifest: ReleaseManifest
  /** Path of the symlink the provisioner mounts as the runtime assets. */
  readonly assetsLink: string
  /** Directory holding `<release>` subdirectories. */
  readonly releasesDir: string
  readonly statePath: string
  readonly users: readonly UserId[]
  /** Users upgraded before the rest, one at a time; all must be healthy before others start. */
  readonly canaryUsers: readonly UserId[]
  readonly batchSize: number
}

/** Result of one rollout attempt. */
export interface RolloutResult {
  readonly completed: boolean
  readonly upgraded: readonly UserId[]
  readonly failed?: UserId
  readonly rolledBack: boolean
}

/** Roll the candidate through user instances in stages; stop and restore the previous code on the first failure. */
export async function rolloutUpgrade(options: RolloutOptions, deps: RolloutDeps): Promise<RolloutResult> {
  const { manifest } = options
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0) throw new Error('batch size must be positive')
  if (manifest.previous === null) throw new Error('a rollout needs a previous release to roll back to')
  const target = join(options.releasesDir, manifest.release)
  const previous = join(options.releasesDir, manifest.previous.release)
  const saved = await readFile(options.statePath, 'utf8').then(parseRolloutState, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (saved?.release !== undefined && saved.release !== manifest.release) throw new Error('rollout state belongs to another release')
  if (saved?.failed !== undefined) throw new Error('a previous rollout failed; roll back or clear the state first')
  const upgraded = new Set<UserId>(saved?.upgraded ?? [])
  await switchRelease(options.assetsLink, target)
  const order = [...options.canaryUsers, ...options.users.filter(userId => !options.canaryUsers.includes(userId))]
  const pending = order.filter(userId => !upgraded.has(userId))
  const canaryPending = pending.filter(userId => options.canaryUsers.includes(userId))
  const batches: UserId[][] = canaryPending.map(userId => [userId])
  const rest = pending.filter(userId => !options.canaryUsers.includes(userId))
  for (let index = 0; index < rest.length; index += options.batchSize) batches.push(rest.slice(index, index + options.batchSize))
  for (const batch of batches) {
    const outcomes = await Promise.all(batch.map(async userId => {
      try { await deps.stop(userId); return await deps.wake(userId) } catch { return false }
    }))
    const failedIndex = outcomes.indexOf(false)
    batch.forEach((userId, index) => { if (outcomes[index]) upgraded.add(userId) })
    if (failedIndex >= 0) {
      const failed = batch[failedIndex]!
      await saveState(options.statePath, { release: manifest.release, upgraded: [...upgraded], failed })
      await rollbackRelease({ ...options, previousDir: previous }, deps, [...upgraded, failed])
      return { completed: false, upgraded: [...upgraded], failed, rolledBack: true }
    }
    await saveState(options.statePath, { release: manifest.release, upgraded: [...upgraded] })
  }
  return { completed: true, upgraded: [...upgraded], rolledBack: false }
}

/** Code-only rollback: reselect the previous release and restart touched instances. Data is never moved or deleted. */
export async function rollbackRelease(options: Pick<RolloutOptions, 'assetsLink'> & { readonly previousDir: string },
  deps: RolloutDeps, touched: readonly UserId[]): Promise<void> {
  await switchRelease(options.assetsLink, options.previousDir)
  for (const userId of touched) await deps.stop(userId).catch(() => {})
}
