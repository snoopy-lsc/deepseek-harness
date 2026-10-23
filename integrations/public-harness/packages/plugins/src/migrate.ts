/** Apply catalogue DDL and expose the row helpers schema tests need. */
import type { DatabaseSync } from 'node:sqlite'
import type { MirrorState, PluginKind, PluginOrigin, VersionState } from './schema.ts'
import { PLUGIN_SCHEMA_SQL } from './schema.ts'

export interface PluginsDbHandle {
  readonly db: DatabaseSync
  close(): void
}

/** Create tables and partial unique indexes when missing. */
export function migratePluginsDb(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
  db.exec(PLUGIN_SCHEMA_SQL)
}

export interface PackageInsert {
  id: string
  name: string
  kind: PluginKind
  origin: PluginOrigin
  ownerUserId: string | null
  claimedAt: number | null
  display: string
  iconSha512: string | null
  createdAt: number
}

export interface VersionInsert {
  id: string
  packageId: string
  version: string
  source: string
  state: VersionState
  mirrorState: MirrorState
  mirrorError: string | null
  artifactSha512: string | null
  upstreamIntegrity: string | null
  sizeBytes: number | null
  enginesDsh: string | null
  installScripts: string
  allowedBuilds: string
  requestedBy: string
  requestNote: string
  reviewedBy: string | null
  reviewedAt: number | null
  reviewNote: string | null
  createdAt: number
}

export function insertPackage(store: PluginsDbHandle, row: PackageInsert): void {
  store.db.prepare(`INSERT INTO plugin_package
    (id, name, kind, origin, owner_user_id, claimed_at, display, icon_sha512, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.name, row.kind, row.origin, row.ownerUserId, row.claimedAt,
    row.display, row.iconSha512, row.createdAt,
  )
}

export function insertVersion(store: PluginsDbHandle, row: VersionInsert): void {
  store.db.prepare(`INSERT INTO plugin_version
    (id, package_id, version, source, state, mirror_state, mirror_error, artifact_sha512,
     upstream_integrity, size_bytes, engines_dsh, install_scripts, allowed_builds,
     requested_by, request_note, reviewed_by, reviewed_at, review_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.packageId, row.version, row.source, row.state, row.mirrorState, row.mirrorError,
    row.artifactSha512, row.upstreamIntegrity, row.sizeBytes, row.enginesDsh,
    row.installScripts, row.allowedBuilds, row.requestedBy, row.requestNote,
    row.reviewedBy, row.reviewedAt, row.reviewNote, row.createdAt,
  )
}

export function insertArtifact(store: PluginsDbHandle, row: { name: string; version: string; sha512: string }): void {
  store.db.prepare('INSERT INTO plugin_artifact (name, version, sha512) VALUES (?, ?, ?)').run(row.name, row.version, row.sha512)
}

export function setVersionState(store: PluginsDbHandle, versionId: string, state: VersionState): void {
  store.db.prepare('UPDATE plugin_version SET state = ? WHERE id = ?').run(state, versionId)
}

/**
 * Clear `owner_user_id` when no version of the package has ever been approved
 * (`claimed_at` still NULL) and nothing is pending. Rejected / withdrawn /
 * expired first versions free the name for the next submitter.
 */
export function releaseUnclaimedName(store: PluginsDbHandle, packageId: string): boolean {
  const pkg = store.db.prepare('SELECT claimed_at FROM plugin_package WHERE id = ?').get(packageId) as
    | { claimed_at: number | null }
    | undefined
  if (pkg === undefined || pkg.claimed_at !== null) return false
  const live = store.db.prepare(
    `SELECT 1 AS ok FROM plugin_version WHERE package_id = ? AND state IN ('pending', 'approved', 'revoked') LIMIT 1`,
  ).get(packageId)
  if (live !== undefined) return false
  store.db.prepare('UPDATE plugin_package SET owner_user_id = NULL WHERE id = ? AND claimed_at IS NULL').run(packageId)
  return true
}
