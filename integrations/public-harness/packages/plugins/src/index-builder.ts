/**
 * Personalized format-1 `index.json` from catalogue visibility scopes (KB-view style).
 * Skills are omitted (phase 2). Cached by fingerprint + content digest.
 */
import { createHash } from 'node:crypto'
import type { PluginsDbHandle } from './migrate.ts'
import { scopesVisibleToUser } from './visibility.ts'

/** Format-1 market index document (subset matching upstream plugin-market-index). */
export interface PersonalizedMarketIndex {
  readonly format: 1
  readonly title: Readonly<Record<string, string>> | string
  readonly description?: Readonly<Record<string, string>> | string
  readonly metadata: {
    readonly categories: Readonly<Record<string, unknown>>
    readonly labels: Readonly<Record<string, unknown>>
    readonly sortKeys: Readonly<Record<string, unknown>>
  }
  readonly plugins: readonly PersonalizedMarketPlugin[]
}

export interface PersonalizedMarketPlugin {
  readonly name: string
  readonly title?: Readonly<Record<string, string>> | string
  readonly description?: Readonly<Record<string, string>> | string
  readonly icon?: string
  readonly author?: string
  readonly homepage?: string
  readonly repository?: { readonly url: string; readonly directory?: string }
  readonly metadata: {
    readonly category?: string
    readonly keywords: readonly string[]
    readonly labels: readonly string[]
    readonly sortKeys: Readonly<Record<string, number>>
  }
  readonly versions: readonly PersonalizedMarketVersion[]
  /** Best-effort: last sync/reconcile report is at max_installed and this package is not yet installed. */
  readonly 'x-dsh-at-limit'?: true
}

export interface PersonalizedMarketVersion {
  readonly version: string
  readonly publishTimestamp: number
  readonly source: { readonly type: 'npm'; readonly registry: string }
  readonly engines: { readonly dsh?: string }
  /** Company extension; upstream parseMarketIndex drops unknown members. */
  readonly 'x-dsh-integrity'?: string
  readonly 'x-dsh-company'?: {
    readonly origin: unknown
    readonly approvedAt?: number
    readonly default?: boolean
  }
}

export interface IndexCacheEntry {
  fingerprint: string
  digest: string
  index: PersonalizedMarketIndex
}

export type IndexCache = Map<string, IndexCacheEntry>

export interface BuildPersonalizedIndexOptions {
  /** User's loopback npm registry, e.g. `http://127.0.0.1:20210/npm/`. */
  readonly registryUrl: string
  readonly title?: Readonly<Record<string, string>> | string
  readonly description?: Readonly<Record<string, string>> | string
  /** When set, cache hits skip rebuilding; key is per userId. */
  readonly cache?: IndexCache
}

export interface PersonalizedIndexResult {
  readonly index: PersonalizedMarketIndex
  /** SHA-256 hex of the canonical index JSON. */
  readonly digest: string
  readonly fromCache: boolean
}

interface PackageRow {
  id: string
  name: string
  kind: string
  display: string
  delisted_at: number | null
  generation: number
}

interface VersionRow {
  id: string
  package_id: string
  version: string
  state: string
  mirror_state: string
  artifact_sha512: string | null
  engines_dsh: string | null
  source: string
  created_at: number
  reviewed_at: number | null
}

interface ScopeRow {
  package_id: string
  kind: string
  target: string
}

interface DisplayJson {
  title?: unknown
  description?: unknown
  author?: unknown
  homepage?: unknown
  repository?: unknown
  metadata?: unknown
  icon?: unknown
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Unix seconds for format 1 (`publishTimestamp` must stay below 10^11). */
export function toPublishTimestampSeconds(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0
  return raw >= 1e11 ? Math.floor(raw / 1000) : Math.floor(raw)
}

/**
 * Compare exact SemVer strings for descending precedence (major.minor.patch, then prerelease).
 * Exact versions only — no ranges.
 */
export function compareSemVerDescending(a: string, b: string): number {
  const pa = parseExactSemVer(a)
  const pb = parseExactSemVer(b)
  if (pa === undefined || pb === undefined) return b.localeCompare(a)
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i]! !== pb.core[i]!) return pb.core[i]! - pa.core[i]!
  }
  // No prerelease sorts above prerelease.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return -1
  if (pb.pre.length === 0) return 1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i += 1) {
    const left = pa.pre[i]
    const right = pb.pre[i]
    if (left === undefined) return 1
    if (right === undefined) return -1
    if (left !== right) {
      const ln = typeof left === 'number'
      const rn = typeof right === 'number'
      if (ln && rn) return (right as number) - (left as number)
      if (ln) return 1
      if (rn) return -1
      return String(right).localeCompare(String(left))
    }
  }
  return 0
}

function parseExactSemVer(version: string): { core: [number, number, number]; pre: Array<string | number> } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
  if (match === null) return undefined
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const pre = (match[4] ?? '').split('.').filter(Boolean).map((part) => (/^(0|[1-9]\d*)$/u.test(part) ? Number(part) : part))
  return { core, pre }
}

function parseDisplay(raw: string): DisplayJson {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as DisplayJson
  } catch { /* ignore */ }
  return {}
}

function pluginMetadata(display: DisplayJson): PersonalizedMarketPlugin['metadata'] {
  const meta = (typeof display.metadata === 'object' && display.metadata !== null && !Array.isArray(display.metadata))
    ? display.metadata as Record<string, unknown>
    : {}
  const keywords = Array.isArray(meta.keywords) ? meta.keywords.filter((k): k is string => typeof k === 'string') : []
  const labels = Array.isArray(meta.labels) ? meta.labels.filter((k): k is string => typeof k === 'string') : []
  const sortKeys: Record<string, number> = {}
  if (typeof meta.sortKeys === 'object' && meta.sortKeys !== null && !Array.isArray(meta.sortKeys)) {
    for (const [key, value] of Object.entries(meta.sortKeys as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) sortKeys[key] = value
    }
  }
  const category = typeof meta.category === 'string' ? meta.category : undefined
  return {
    ...(category !== undefined ? { category } : {}),
    keywords,
    labels,
    sortKeys,
  }
}

function repositoryOf(display: DisplayJson): PersonalizedMarketPlugin['repository'] | undefined {
  const repo = display.repository
  if (typeof repo === 'string' && repo.trim() !== '') return { url: repo }
  if (typeof repo === 'object' && repo !== null && !Array.isArray(repo)) {
    const url = (repo as { url?: unknown }).url
    if (typeof url === 'string' && url.trim() !== '') {
      const directory = (repo as { directory?: unknown }).directory
      return {
        url,
        ...(typeof directory === 'string' && directory.trim() !== '' ? { directory } : {}),
      }
    }
  }
  return undefined
}

function localizedOrString(value: unknown): Readonly<Record<string, string>> | string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
    )
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries)
  }
  return undefined
}

function originFromSource(sourceJson: string): unknown {
  try {
    const parsed = JSON.parse(sourceJson) as unknown
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch { /* ignore */ }
  return { type: 'upload' }
}

function fingerprintFor(
  db: PluginsDbHandle,
  userId: string,
  groups: readonly string[],
): string {
  const listings = db.db.prepare(
    `SELECT package_id, current_version_id, generation FROM plugin_listing ORDER BY package_id`,
  ).all() as Array<{ package_id: string; current_version_id: string; generation: number }>
  const packages = db.db.prepare(
    `SELECT id, name, kind, delisted_at FROM plugin_package ORDER BY id`,
  ).all() as Array<{ id: string; name: string; kind: string; delisted_at: number | null }>
  const scopes = db.db.prepare(
    `SELECT package_id, kind, target FROM plugin_scope ORDER BY package_id, kind, target`,
  ).all() as ScopeRow[]
  const versions = db.db.prepare(
    `SELECT id, package_id, version, state, mirror_state, artifact_sha512, engines_dsh, created_at, reviewed_at
     FROM plugin_version ORDER BY id`,
  ).all() as Array<Pick<VersionRow, 'id' | 'package_id' | 'version' | 'state' | 'mirror_state' | 'artifact_sha512' | 'engines_dsh' | 'created_at' | 'reviewed_at'>>
  const defaults = db.db.prepare(
    `SELECT package_id, kind, target, set_at, reset_at FROM plugin_default ORDER BY package_id, kind, target`,
  ).all()
  const defaultState = db.db.prepare(
    `SELECT package_id, state, installed_version, target_version, updated_at
     FROM plugin_default_state WHERE user_id = ? ORDER BY package_id`,
  ).all(userId)
  return sha256Hex(JSON.stringify({
    userId,
    groups: [...groups].sort(),
    listings,
    packages,
    scopes,
    versions,
    defaults,
    defaultState,
  }))
}

function loadVisiblePackages(
  db: PluginsDbHandle,
  groups: ReadonlySet<string>,
): PackageRow[] {
  const rows = db.db.prepare(
    `SELECT p.id AS id, p.name AS name, p.kind AS kind, p.display AS display,
            p.delisted_at AS delisted_at, l.generation AS generation
     FROM plugin_package p
     JOIN plugin_listing l ON l.package_id = p.id
     WHERE p.delisted_at IS NULL AND p.kind = 'bundle'
     ORDER BY p.name COLLATE NOCASE`,
  ).all() as PackageRow[]

  const scopeStmt = db.db.prepare(
    `SELECT package_id, kind, target FROM plugin_scope WHERE package_id = ?`,
  )
  return rows.filter((row) => {
    const scopes = scopeStmt.all(row.id) as ScopeRow[]
    return scopesVisibleToUser(scopes, groups)
  })
}

function loadApprovedReadyVersions(db: PluginsDbHandle, packageId: string): VersionRow[] {
  return db.db.prepare(
    `SELECT id, package_id, version, state, mirror_state, artifact_sha512, engines_dsh, source, created_at, reviewed_at
     FROM plugin_version
     WHERE package_id = ? AND state = 'approved' AND mirror_state = 'ready'
     ORDER BY version`,
  ).all(packageId) as VersionRow[]
}

function buildPlugin(
  db: PluginsDbHandle,
  pkg: PackageRow,
  registryUrl: string,
): PersonalizedMarketPlugin | undefined {
  const versions = loadApprovedReadyVersions(db, pkg.id)
  if (versions.length === 0) return undefined
  versions.sort((a, b) => compareSemVerDescending(a.version, b.version))

  const display = parseDisplay(pkg.display)
  const title = localizedOrString(display.title)
  const description = localizedOrString(display.description)
  const author = typeof display.author === 'string' && display.author.trim() !== '' ? display.author : undefined
  const homepage = typeof display.homepage === 'string' && display.homepage.trim() !== '' ? display.homepage : undefined
  const repository = repositoryOf(display)
  // URL icons are never passed through; only inline data: URLs (design).
  const icon = typeof display.icon === 'string' && display.icon.startsWith('data:') ? display.icon : undefined

  return {
    name: pkg.name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(repository !== undefined ? { repository } : {}),
    metadata: pluginMetadata(display),
    versions: versions.map((row) => {
      const approvedAt = row.reviewed_at ?? row.created_at
      const integrity = row.artifact_sha512 !== null
        ? `sha512-${Buffer.from(row.artifact_sha512, 'hex').toString('base64')}`
        : undefined
      return {
        version: row.version,
        publishTimestamp: toPublishTimestampSeconds(row.created_at),
        source: { type: 'npm' as const, registry: registryUrl },
        engines: row.engines_dsh ? { dsh: row.engines_dsh } : {},
        ...(integrity !== undefined ? { 'x-dsh-integrity': integrity } : {}),
        'x-dsh-company': {
          origin: originFromSource(row.source),
          approvedAt: toPublishTimestampSeconds(approvedAt),
        },
      }
    }),
  }
}

/**
 * Build the personalized format-1 index for one user from catalogue scopes.
 * @param db Catalogue database.
 * @param userId Principal id (used for default-state fingerprint and cache key).
 * @param groups Effective group ids (including ancestor departments).
 * @param options Registry URL and optional cache.
 */
export function buildPersonalizedIndex(
  db: PluginsDbHandle,
  userId: string,
  groups: readonly string[],
  options: BuildPersonalizedIndexOptions,
): PersonalizedIndexResult {
  const fingerprint = fingerprintFor(db, userId, groups)
  const cacheKey = userId
  const cached = options.cache?.get(cacheKey)
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return { index: cached.index, digest: cached.digest, fromCache: true }
  }

  const groupSet = new Set(groups)
  const visible = loadVisiblePackages(db, groupSet)
  const plugins: PersonalizedMarketPlugin[] = []
  for (const pkg of visible) {
    const plugin = buildPlugin(db, pkg, options.registryUrl)
    if (plugin !== undefined) plugins.push(plugin)
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))

  const index: PersonalizedMarketIndex = {
    format: 1,
    title: options.title ?? { en: 'Company market' },
    ...(options.description !== undefined ? { description: options.description } : {}),
    metadata: { categories: {}, labels: {}, sortKeys: {} },
    plugins,
  }
  const digest = sha256Hex(JSON.stringify(index))
  if (options.cache !== undefined) {
    options.cache.set(cacheKey, { fingerprint, digest, index })
  }
  return { index, digest, fromCache: false }
}

export interface CreateMarketBuildIndexOptions {
  readonly registryUrl: string | ((userId: string) => string)
  readonly groupsFor: (userId: string) => readonly string[]
  readonly title?: BuildPersonalizedIndexOptions['title']
  readonly description?: BuildPersonalizedIndexOptions['description']
  readonly cache?: IndexCache
}

/**
 * Adapter for `MarketRouteDeps.buildIndex`: resolves groups + registry per user.
 */
export function createMarketBuildIndex(
  db: PluginsDbHandle,
  options: CreateMarketBuildIndexOptions,
): (userId: string) => PersonalizedMarketIndex {
  const cache = options.cache ?? new Map<string, IndexCacheEntry>()
  return (userId: string) => {
    const registryUrl = typeof options.registryUrl === 'function'
      ? options.registryUrl(userId)
      : options.registryUrl
    return buildPersonalizedIndex(db, userId, options.groupsFor(userId), {
      registryUrl,
      title: options.title,
      description: options.description,
      cache,
    }).index
  }
}
