/**
 * Path B: administrator direct listing (upload / git name check).
 * Mirrors via `mirrorVersion`, freezes the artifact, writes catalogue rows + `admin-plugin-upload` audit.
 */
import { COMPANY_SCOPE_PREFIX } from './schema.ts'
import { compareSemVerDescending } from './index-builder.ts'
import { newId } from './ids.ts'
import type { PluginsDbHandle } from './migrate.ts'
import { writeAuditOutbox } from './audit.ts'
import {
  MirrorError,
  mirrorVersion,
  resolveUpload,
  type ClosurePackage,
  type MirrorVersionResult,
} from './mirror/index.ts'

export type UploadErrorCode =
  | 'scope'
  | 'version-exists'
  | 'install-scripts'
  | 'closure-source'
  | 'package'
  | 'integrity'
  | 'artifact-too-large'
  | 'upload'

/** Wire-facing refusal for path B; `message` is the stable conflict code. */
export class UploadError extends Error {
  readonly status: number
  readonly code: UploadErrorCode
  readonly detail: string | undefined
  constructor(code: UploadErrorCode, detail?: string, status = 409) {
    super(code)
    this.code = code
    this.detail = detail
    this.status = code === 'scope' ? 400 : status
  }
}

export type PluginScopeSpec =
  | { readonly kind: 'company'; readonly target: '*' }
  | { readonly kind: 'group'; readonly target: string }

export type AdminUploadSource =
  | { readonly type: 'upload'; readonly tarball: Buffer }
  | {
      readonly type: 'git'
      readonly name: string
      readonly url: string
      readonly commit: string
      readonly path?: string
      /** Already-fetched pack tarball (git resolve lives with the fetch service). */
      readonly tarball: Buffer
    }

export interface AdminUploadInput {
  readonly db: PluginsDbHandle
  readonly storeRoot: string
  readonly adminUserId: string
  readonly scope: PluginScopeSpec
  readonly source: AdminUploadSource
  readonly closure: readonly ClosurePackage[]
  readonly fetchClosureTarball?: (entry: ClosurePackage) => Promise<Buffer>
  /** Packages an admin allows to run install scripts; empty/default refuses any scripts. */
  readonly allowedBuilds?: readonly string[]
  readonly kind?: 'bundle' | 'skill'
  readonly display?: string
  readonly now?: number
}

export interface AdminUploadResult {
  readonly packageId: string
  readonly versionId: string
  readonly name: string
  readonly version: string
  readonly artifactSha512: string
  readonly mode: 'bundle' | 'fallback'
  readonly auditId: number
}

/** Mandatory `@corp-dsh/` for git and upload package names (decided Q6). */
export function assertCompanyPluginName(name: string): void {
  if (!name.startsWith(COMPANY_SCOPE_PREFIX)) throw new UploadError('scope', name)
}

function mapMirrorError(error: unknown): never {
  if (error instanceof UploadError) throw error
  if (error instanceof MirrorError) {
    const code = error.message as UploadErrorCode
    if (
      code === 'scope' || code === 'closure-source' || code === 'integrity' ||
      code === 'artifact-too-large' || code === 'package' || code === 'upload'
    ) {
      throw new UploadError(code, error.detail)
    }
    throw new UploadError('package', error.message)
  }
  throw error
}

function liveVersionExists(db: PluginsDbHandle, name: string, version: string): boolean {
  const artifact = db.db.prepare('SELECT 1 AS ok FROM plugin_artifact WHERE name = ? AND version = ?').get(name, version)
  if (artifact !== undefined) return true
  const live = db.db.prepare(
    `SELECT 1 AS ok FROM plugin_version v
     JOIN plugin_package p ON p.id = v.package_id
     WHERE p.name = ? AND v.version = ? AND v.state IN ('pending', 'approved', 'revoked')
     LIMIT 1`,
  ).get(name, version)
  return live !== undefined
}

function assertNoUnauthorizedInstallScripts(
  closure: readonly ClosurePackage[],
  pluginInstallScripts: readonly string[],
  allowedBuilds: readonly string[],
  pluginName: string,
): void {
  const allowed = new Set(allowedBuilds)
  if (pluginInstallScripts.length > 0 && !allowed.has(pluginName)) {
    throw new UploadError('install-scripts', pluginName)
  }
  for (const entry of closure) {
    if (entry.installScript != null && entry.installScript !== '' && !allowed.has(entry.name)) {
      throw new UploadError('install-scripts', entry.name)
    }
  }
}

function defaultDisplay(name: string): string {
  return JSON.stringify({
    title: name,
    description: '',
    author: '',
    homepage: '',
    repository: '',
    metadata: {},
  })
}

function sourceJson(source: AdminUploadSource, upstreamIntegrity: string | null): string {
  if (source.type === 'upload') return JSON.stringify({ type: 'upload' })
  return JSON.stringify({
    type: 'git',
    url: source.url,
    commit: source.commit,
    ...(source.path !== undefined ? { path: source.path } : {}),
    ...(upstreamIntegrity ? { integrity: upstreamIntegrity } : {}),
  })
}

/**
 * Administrator path B: mirror, approve, list, and audit as `admin-plugin-upload`.
 * Reauth is enforced by the HTTP layer (1C); this is the catalogue core.
 */
export async function adminUpload(input: AdminUploadInput): Promise<AdminUploadResult> {
  const now = input.now ?? Date.now()
  const allowedBuilds = input.allowedBuilds ?? []

  if (input.source.type === 'git') {
    assertCompanyPluginName(input.source.name)
  }

  // Peek name/version before mirror so version-exists fails without writing blobs.
  let peekedName: string
  let peekedVersion: string
  let peekedInstallScripts: readonly string[] = []
  try {
    const peeked = resolveUpload(input.source.tarball)
    peekedName = peeked.name
    peekedVersion = peeked.version
    peekedInstallScripts = peeked.installScripts
    if (input.source.type === 'git' && peeked.name !== input.source.name) {
      throw new UploadError('package', 'name-mismatch')
    }
    assertCompanyPluginName(peekedName)
  } catch (error) {
    mapMirrorError(error)
  }

  if (liveVersionExists(input.db, peekedName, peekedVersion)) {
    throw new UploadError('version-exists', `${peekedName}@${peekedVersion}`)
  }

  assertNoUnauthorizedInstallScripts(input.closure, peekedInstallScripts, allowedBuilds, peekedName)

  let mirrored: MirrorVersionResult
  try {
    mirrored = await mirrorVersion({
      source: { type: 'upload', tarball: input.source.tarball },
      storeRoot: input.storeRoot,
      closure: input.closure,
      fetchClosureTarball: input.fetchClosureTarball,
      mirrorState: 'queued',
    })
  } catch (error) {
    mapMirrorError(error)
  }

  if (mirrored.name !== peekedName || mirrored.version !== peekedVersion) {
    throw new UploadError('package', 'name-version-mismatch')
  }
  if (liveVersionExists(input.db, mirrored.name, mirrored.version)) {
    throw new UploadError('version-exists', `${mirrored.name}@${mirrored.version}`)
  }

  const versionId = newId('plv')
  const kind = input.kind ?? 'bundle'
  const display = input.display ?? defaultDisplay(mirrored.name)
  const installScriptsJson = JSON.stringify(
    input.closure.filter(c => c.installScript).map(c => ({ name: c.name, version: c.version, installScript: c.installScript })),
  )
  const allowedBuildsJson = JSON.stringify([...allowedBuilds])
  const source = sourceJson(input.source, mirrored.upstreamIntegrity)

  input.db.db.exec('BEGIN IMMEDIATE')
  try {
    if (liveVersionExists(input.db, mirrored.name, mirrored.version)) {
      throw new UploadError('version-exists', `${mirrored.name}@${mirrored.version}`)
    }

    const existing = input.db.db.prepare(
      'SELECT id, kind FROM plugin_package WHERE name = ?',
    ).get(mirrored.name) as { id: string; kind: string } | undefined

    let packageId: string
    let createdPackage = false
    if (existing !== undefined) {
      packageId = existing.id
    } else {
      packageId = newId('plg')
      createdPackage = true
      input.db.db.prepare(`INSERT INTO plugin_package
        (id, name, kind, origin, owner_user_id, claimed_at, display, icon_sha512, created_at)
        VALUES (?, ?, ?, 'admin', NULL, ?, ?, NULL, ?)`).run(
        packageId, mirrored.name, kind, now, display, now,
      )
    }

    input.db.db.prepare(`INSERT INTO plugin_version
      (id, package_id, version, source, state, mirror_state, mirror_error, artifact_sha512,
       upstream_integrity, size_bytes, engines_dsh, install_scripts, allowed_builds,
       requested_by, request_note, reviewed_by, reviewed_at, review_note, created_at)
      VALUES (?, ?, ?, ?, 'approved', 'ready', NULL, ?, ?, ?, NULL, ?, ?, ?, '', ?, ?, NULL, ?)`).run(
      versionId, packageId, mirrored.version, source,
      mirrored.artifactSha512, mirrored.upstreamIntegrity, mirrored.sizeBytes,
      installScriptsJson, allowedBuildsJson,
      input.adminUserId, input.adminUserId, now, now,
    )

    input.db.db.prepare('INSERT INTO plugin_artifact (name, version, sha512) VALUES (?, ?, ?)').run(
      mirrored.name, mirrored.version, mirrored.artifactSha512,
    )

    input.db.db.prepare(
      `INSERT INTO plugin_blob (sha512, size, stored_at, verified_at, quarantined) VALUES (?, ?, ?, ?, 0)`,
    ).run(mirrored.artifactSha512, mirrored.sizeBytes, now, now)

    const insertClosure = input.db.db.prepare(
      `INSERT INTO plugin_closure (version_id, name, version, integrity, install_script) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const entry of input.closure) {
      insertClosure.run(versionId, entry.name, entry.version, entry.integrity, entry.installScript)
    }

    const listing = input.db.db.prepare(
      'SELECT package_id, current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
    ).get(packageId) as {
      package_id: string
      current_version_id: string
      previous_version_id: string | null
      generation: number
    } | undefined

    if (listing === undefined) {
      input.db.db.prepare(
        `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
         VALUES (?, ?, NULL, 1, ?, ?)`,
      ).run(packageId, versionId, input.adminUserId, now)
      input.db.db.prepare(
        `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
         VALUES (?, ?, 'list', ?, ?, ?)`,
      ).run(packageId, versionId, JSON.stringify({ source: input.source.type }), input.adminUserId, now)
      if (createdPackage) {
        input.db.db.prepare(
          `INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)`,
        ).run(packageId, input.scope.kind, input.scope.target)
      }
    } else {
      const currentVer = input.db.db.prepare(
        'SELECT version FROM plugin_version WHERE id = ?',
      ).get(listing.current_version_id) as { version: string } | undefined
      const currentVersion = currentVer?.version ?? '0.0.0'
      // Same rule as approve: only advance current when the new version is newer.
      if (compareSemVerDescending(mirrored.version, currentVersion) < 0) {
        input.db.db.prepare(
          `UPDATE plugin_listing
           SET previous_version_id = current_version_id,
               current_version_id = ?,
               generation = generation + 1,
               listed_by = ?,
               listed_at = ?
           WHERE package_id = ?`,
        ).run(versionId, input.adminUserId, now, packageId)
        input.db.db.prepare(
          `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
           VALUES (?, ?, 'update', ?, ?, ?)`,
        ).run(
          packageId,
          versionId,
          JSON.stringify({ from: currentVersion, to: mirrored.version, source: input.source.type }),
          input.adminUserId,
          now,
        )
      } else {
        input.db.db.prepare(
          `INSERT INTO plugin_listing_history (package_id, version_id, action, detail, by, at)
           VALUES (?, ?, 'list', ?, ?, ?)`,
        ).run(
          packageId,
          versionId,
          JSON.stringify({ source: input.source.type, historyOnly: true, version: mirrored.version }),
          input.adminUserId,
          now,
        )
      }
    }

    const auditId = writeAuditOutbox(input.db, {
      at: now,
      event: 'admin-plugin-upload',
      outcome: 'ok',
      userId: null,
      actor: input.adminUserId,
      detail: {
        package: mirrored.name,
        version: mirrored.version,
        sourceType: input.source.type,
        scope: input.scope,
      },
    })

    input.db.db.exec('COMMIT')
    return {
      packageId,
      versionId,
      name: mirrored.name,
      version: mirrored.version,
      artifactSha512: mirrored.artifactSha512,
      mode: mirrored.mode,
      auditId,
    }
  } catch (error) {
    try { input.db.db.exec('ROLLBACK') } catch { /* ignore */ }
    mapMirrorError(error)
  }
}
