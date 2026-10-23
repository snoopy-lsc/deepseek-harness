/**
 * Production catalogue adapters for market HTTP routes: personalized index,
 * scope-filtered packuments, and content-addressed tarballs from the store.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginsDbHandle } from './migrate.ts'
import { createMarketBuildIndex, compareSemVerDescending, type CreateMarketBuildIndexOptions } from './index-builder.ts'
import { createMarketLookupPackument } from './limits.ts'
import { applySyncReport, buildSyncPlan, type ApplySyncReportResult, type SyncPlan } from './sync-plan.ts'
import { packageArtifactsVisible, type ScopeRow } from './visibility.ts'
import type { MarketRouteDeps } from './routes.ts'
import { lookupEndpointByPort } from './listen.ts'
import { blobPath } from './mirror/store.ts'

export interface CatalogueServeOptions {
  readonly db: PluginsDbHandle
  readonly storeDir: string
  /** Resolve the user's loopback registry base, e.g. `http://127.0.0.1:20210/npm/`. */
  readonly registryUrlFor: (userId: string) => string
  readonly groupsFor: (userId: string) => readonly string[]
  readonly indexOptions?: Omit<CreateMarketBuildIndexOptions, 'registryUrl' | 'groupsFor'>
}

function scopesForPackage(db: PluginsDbHandle, packageId: string): ScopeRow[] {
  return db.db.prepare(
    'SELECT kind, target FROM plugin_scope WHERE package_id = ?',
  ).all(packageId) as unknown as ScopeRow[]
}

function loadPackageByName(db: PluginsDbHandle, name: string): { id: string; name: string } | undefined {
  return db.db.prepare('SELECT id, name FROM plugin_package WHERE name = ?').get(name) as
    | { id: string; name: string }
    | undefined
}

interface VersionServeRow {
  version: string
  artifact_sha512: string
}

function loadVisibleApprovedVersions(db: PluginsDbHandle, packageId: string): VersionServeRow[] {
  return db.db.prepare(
    `SELECT version, artifact_sha512 FROM plugin_version
     WHERE package_id = ? AND state = 'approved' AND mirror_state = 'ready'
       AND artifact_sha512 IS NOT NULL AND artifact_sha512 != ''`,
  ).all(packageId) as unknown as VersionServeRow[]
}

function encodeNpmName(name: string): string {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash > 0) return `${name.slice(0, slash)}%2F${name.slice(slash + 1)}`
  }
  return name
}

function basenameOf(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
}

function integrityOf(sha512Hex: string): string {
  return `sha512-${Buffer.from(sha512Hex, 'hex').toString('base64')}`
}

/**
 * Build a minimal npm packument for versions visible to the user (scope-only;
 * delist still serves artifacts). Returns undefined when the package is out of scope
 * or has no approved ready versions.
 */
export function buildCataloguePackument(
  db: PluginsDbHandle,
  name: string,
  userId: string,
  groups: readonly string[],
  registryUrl: string,
): unknown | undefined {
  const pkg = loadPackageByName(db, name)
  if (pkg === undefined) return undefined
  const scopes = scopesForPackage(db, pkg.id)
  if (!packageArtifactsVisible({ scopes, groups: new Set(groups) })) return undefined
  const versions = loadVisibleApprovedVersions(db, pkg.id)
  if (versions.length === 0) return undefined
  versions.sort((a, b) => compareSemVerDescending(a.version, b.version))
  const base = registryUrl.endsWith('/') ? registryUrl.slice(0, -1) : registryUrl
  const encoded = encodeNpmName(name)
  const fileBase = basenameOf(name)
  const versionsMap: Record<string, unknown> = {}
  for (const row of versions) {
    versionsMap[row.version] = {
      name,
      version: row.version,
      dist: {
        tarball: `${base}/${encoded}/-/${fileBase}-${row.version}.tgz`,
        integrity: integrityOf(row.artifact_sha512),
      },
    }
  }
  return {
    name,
    'dist-tags': { latest: versions[0]!.version },
    versions: versionsMap,
  }
}

/** Read a frozen artifact from the store when the version is in the caller's artifact scope. */
export function lookupCatalogueTarball(
  db: PluginsDbHandle,
  storeDir: string,
  name: string,
  version: string,
  groups: readonly string[],
): Buffer | undefined {
  const pkg = loadPackageByName(db, name)
  if (pkg === undefined) return undefined
  const scopes = scopesForPackage(db, pkg.id)
  if (!packageArtifactsVisible({ scopes, groups: new Set(groups) })) return undefined
  const row = db.db.prepare(
    `SELECT artifact_sha512 FROM plugin_version
     WHERE package_id = ? AND version = ? AND state = 'approved' AND mirror_state = 'ready'
       AND artifact_sha512 IS NOT NULL AND artifact_sha512 != ''`,
  ).get(pkg.id, version) as { artifact_sha512: string } | undefined
  if (row === undefined) return undefined
  const path = blobPath(storeDir, row.artifact_sha512)
  if (!existsSync(path)) return undefined
  return readFileSync(path)
}

/**
 * Assemble `MarketRouteDeps` backed by the live catalogue (never empty stubs).
 * `lookup` resolves the endpoint for the bound listener port.
 */
export function createCatalogueMarketRouteDeps(
  options: CatalogueServeOptions & { readonly listenPort: number },
): MarketRouteDeps {
  const { db, storeDir, groupsFor, registryUrlFor, listenPort } = options
  const buildIndex = createMarketBuildIndex(db, {
    registryUrl: registryUrlFor,
    groupsFor,
    ...options.indexOptions,
  })
  const underlyingPackument = (name: string, userId: string) =>
    buildCataloguePackument(db, name, userId, groupsFor(userId), registryUrlFor(userId))
  const lookupPackument = createMarketLookupPackument(db, {
    groupsFor,
    lookup: underlyingPackument,
  })
  const lookupTarball = (name: string, version: string, userId: string) =>
    lookupCatalogueTarball(db, storeDir, name, version, groupsFor(userId))

  return {
    lookup: () => lookupEndpointByPort(db, listenPort),
    buildIndex,
    lookupPackument,
    lookupTarball,
    buildSyncPlan: (userId: string): SyncPlan =>
      buildSyncPlan({ db, userId, groups: new Set(groupsFor(userId)) }),
    applySyncReport: (userId: string, report: unknown): ApplySyncReportResult =>
      applySyncReport({
        db,
        userId,
        groups: new Set(groupsFor(userId)),
        report: report as Parameters<typeof applySyncReport>[0]['report'],
      }),
  }
}

/** Store layout helper used by tests. */
export function catalogueBlobPath(storeDir: string, sha512: string): string {
  return join(storeDir, 'sha512', sha512)
}
