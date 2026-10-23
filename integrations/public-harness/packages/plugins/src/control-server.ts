/**
 * Plugins control-plane HTTP on a Unix socket (`DSH_PLUGINS_SOCKET` /
 * `/run/dsh-plugins/control.sock`). Identity forwards admin/me with actor
 * headers; provisioner uses open/close/reconcile-plan; audit drain mirrors KB.
 */
import { chmod, chown, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { openEndpoint, closeEndpoint, validateMarketPorts, type MarketPortRange } from './listen.ts'
import type { PluginsDb } from './db.ts'
import { listPendingAudit, ackAuditOutbox, writeAuditOutbox } from './audit.ts'
import { approveSubmission, rejectSubmission, ApproveError } from './approve.ts'
import { submitPluginVersion, withdrawSubmission, SubmitError } from './submit.ts'
import {
  changeScope, delistPackage, relistPackage, rollbackListing, revokeVersion, ListingError,
} from './listing.ts'
import {
  setDefault, clearDefault, resetDefault, reenableDefault, listDefaults, defaultsVisibleToUser,
  DefaultError,
} from './defaults.ts'
import { adminUpload, UploadError, type PluginScopeSpec } from './upload.ts'
import { handlePluginPolicyAdmin, PluginPolicyError } from './policy.ts'
import { handlePluginLimitsAdmin, PluginLimitError, effectivePluginLimits, listPluginLimitRows } from './limits.ts'
import { handleReconcilePlan, SyncPlanError } from './sync-plan.ts'
import { getGlobalPluginPolicy } from './policy.ts'

export class PluginsControlError extends Error {
  readonly status: number
  readonly code: string
  readonly extra: Record<string, unknown>
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export interface PluginsControlActor {
  readonly userId: string
  readonly email: string
  readonly role: 'admin' | 'member'
}

export interface PluginsControlRequest {
  readonly actor: PluginsControlActor
  readonly query: URLSearchParams
  json(): Promise<Record<string, unknown>>
  bytes(limit: number): Promise<Buffer>
}

export type PluginsControlRoute = (request: PluginsControlRequest) => Promise<unknown>
export type PluginsControlRoutes = Record<string, PluginsControlRoute>

const MAX_JSON = 1024 * 1024
const MAX_UPLOAD = 200 * 1024 * 1024
const USER = /^[A-Za-z0-9_-]{1,128}$/
const ROLE = (value: string | string[] | undefined): 'admin' | 'member' =>
  value === 'admin' ? 'admin' : 'member'

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new PluginsControlError(413, 'body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function mapDomainError(error: unknown): never {
  if (error instanceof PluginsControlError) throw error
  if (
    error instanceof UploadError || error instanceof ApproveError || error instanceof SubmitError
    || error instanceof ListingError || error instanceof DefaultError || error instanceof PluginPolicyError
    || error instanceof PluginLimitError || error instanceof SyncPlanError
  ) {
    throw new PluginsControlError(error.status, error.code, error.detail !== undefined ? { detail: error.detail } : {})
  }
  throw error
}

function scopeFromBody(raw: unknown): PluginScopeSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PluginsControlError(400, 'scope')
  }
  const s = raw as { kind?: unknown; target?: unknown }
  if (s.kind === 'company' && (s.target === '*' || s.target === undefined)) {
    return { kind: 'company', target: '*' }
  }
  if (s.kind === 'group' && typeof s.target === 'string' && s.target.length > 0) {
    return { kind: 'group', target: s.target }
  }
  throw new PluginsControlError(400, 'scope')
}

function scopesFromBody(raw: unknown): PluginScopeSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PluginsControlError(400, 'scope')
  return raw.map(scopeFromBody)
}

export interface PluginsControlDeps {
  readonly db: PluginsDb
  readonly storeDir: string
  readonly ports: MarketPortRange
  /** Optional group resolver; defaults to empty (company listings still visible). */
  readonly groupsFor?: (userId: string) => readonly string[]
  readonly emailFor?: (userId: string) => string | null
  /** Mutable principal groups map updated by `/internal/principals`. */
  readonly principalGroups?: Map<string, readonly string[]>
  readonly hostAddress?: string
  readonly log?: (line: string) => void
  readonly now?: () => number
}

/** Build the route table covering the design API list + internal audit + provisioner verbs. */
export function buildPluginsControlRoutes(deps: PluginsControlDeps): PluginsControlRoutes {
  const groupsFor = (userId: string) =>
    deps.groupsFor?.(userId) ?? deps.principalGroups?.get(userId) ?? []
  const emailFor = deps.emailFor ?? (() => null)
  const now = deps.now ?? Date.now
  const hostAddress = deps.hostAddress ?? '127.0.0.1'
  const log = deps.log ?? (() => {})

  const requireAdmin = (actor: PluginsControlActor) => {
    if (actor.role !== 'admin') throw new PluginsControlError(403, 'forbidden')
  }

  return {
    // --- internal ---
    'POST /internal/audit/drain': async () => ({ events: listPendingAudit(deps.db) }),
    'POST /internal/audit/ack': async (request) => {
      const body = await request.json()
      const upTo = body.upTo
      if (typeof upTo !== 'number' || !Number.isSafeInteger(upTo) || upTo < 0) {
        throw new PluginsControlError(400, 'body')
      }
      return { removed: ackAuditOutbox(deps.db, upTo), ok: true }
    },
    'POST /internal/principals': async (request) => {
      const body = await request.json()
      const users = body.users
      if (!Array.isArray(users)) throw new PluginsControlError(400, 'body')
      const map = deps.principalGroups ?? new Map<string, readonly string[]>()
      let changed = 0
      for (const entry of users) {
        if (entry === null || typeof entry !== 'object') continue
        const row = entry as { userId?: unknown; groups?: unknown }
        if (typeof row.userId !== 'string' || !USER.test(row.userId)) continue
        const groups = Array.isArray(row.groups)
          ? row.groups.filter((g): g is string => typeof g === 'string')
          : []
        const prev = map.get(row.userId)
        map.set(row.userId, groups)
        if (prev === undefined || JSON.stringify([...prev].sort()) !== JSON.stringify([...groups].sort())) {
          changed += 1
        }
      }
      if (deps.principalGroups === undefined) {
        // Caller did not pass a shared map; still accept the write for this request only.
        log('plugins: principals update ignored (no principalGroups map)')
      }
      return { changed }
    },

    // --- provisioner verbs (no actor required for internal-style paths under /control) ---
    'POST /control/open': async (request) => {
      const body = await request.json()
      const userId = body.userId
      const instanceId = body.instanceId
      const accountUid = body.accountUid
      if (typeof userId !== 'string' || !USER.test(userId)) throw new PluginsControlError(400, 'userId')
      if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
        throw new PluginsControlError(400, 'instanceId')
      }
      if (typeof accountUid !== 'number' || !Number.isSafeInteger(accountUid) || accountUid < 0) {
        throw new PluginsControlError(400, 'accountUid')
      }
      try {
        const opened = openEndpoint(deps.db, {
          userId, instanceId, accountUid, ports: deps.ports, now: now(),
        })
        const policy = getGlobalPluginPolicy(deps.db)
        return {
          port: opened.port,
          token: opened.token,
          ...(policy.market_only ? { marketOnly: true as const } : {}),
        }
      } catch (error) {
        throw new PluginsControlError(409, (error as Error).message.slice(0, 120))
      }
    },
    'POST /control/close': async (request) => {
      const body = await request.json()
      const instanceId = body.instanceId
      if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
        throw new PluginsControlError(400, 'instanceId')
      }
      closeEndpoint(deps.db, instanceId)
      return { ok: true }
    },
    'POST /control/reconcile-plan': async (request) => {
      const body = await request.json()
      const userId = body.userId
      if (typeof userId !== 'string' || !USER.test(userId)) throw new PluginsControlError(400, 'userId')
      try {
        return handleReconcilePlan({
          db: deps.db,
          userId,
          groups: new Set(groupsFor(userId)),
          hostAddress,
          registryHost: hostAddress,
        })
      } catch (error) {
        mapDomainError(error)
      }
    },

    // --- admin ---
    'GET /admin/plugins': async ({ actor }) => {
      requireAdmin(actor)
      const rows = deps.db.db.prepare(
        `SELECT p.id AS packageId, p.name AS name, p.delisted_at AS delistedAt,
                l.current_version_id AS currentVersionId, l.previous_version_id AS previousVersionId,
                l.generation AS generation
         FROM plugin_package p
         LEFT JOIN plugin_listing l ON l.package_id = p.id
         ORDER BY p.name COLLATE NOCASE`,
      ).all()
      return { packages: rows, defaults: listDefaults(deps.db) }
    },
    'GET /admin/plugins/requests': async ({ actor, query }) => {
      requireAdmin(actor)
      const state = query.get('state')
      const rows = deps.db.db.prepare(
        `SELECT v.id AS versionId, v.package_id AS packageId, p.name AS name, v.version AS version,
                v.state AS state, v.mirror_state AS mirrorState, v.requested_by AS requestedBy,
                v.request_note AS note, v.created_at AS submittedAt, v.artifact_sha512 AS artifactSha512,
                v.review_note AS reason
         FROM plugin_version v
         JOIN plugin_package p ON p.id = v.package_id
         WHERE (? IS NULL OR v.state = ?)
         ORDER BY v.created_at DESC
         LIMIT 500`,
      ).all(state, state)
      return { requests: rows }
    },
    'GET /admin/plugins/requests/detail': async ({ actor, query }) => {
      requireAdmin(actor)
      const id = query.get('id')
      if (typeof id !== 'string' || id.length === 0) throw new PluginsControlError(400, 'id')
      const row = deps.db.db.prepare(
        `SELECT v.id AS versionId, v.package_id AS packageId, p.name AS name, v.version AS version,
                v.state AS state, v.mirror_state AS mirrorState, v.source AS source,
                v.artifact_sha512 AS artifactSha512, v.install_scripts AS installScripts,
                v.allowed_builds AS allowedBuilds, v.requested_by AS requestedBy,
                v.request_note AS note, v.created_at AS submittedAt
         FROM plugin_version v
         JOIN plugin_package p ON p.id = v.package_id
         WHERE v.id = ?`,
      ).get(id)
      if (row === undefined) throw new PluginsControlError(404, 'not-found')
      const closure = deps.db.db.prepare(
        'SELECT name, version, integrity, install_script AS installScript FROM plugin_closure WHERE version_id = ?',
      ).all(id)
      return { request: row, closure }
    },
    'GET /admin/plugins/requests/file': async ({ actor, query }) => {
      requireAdmin(actor)
      const id = query.get('id')
      const filePath = query.get('path')
      if (typeof id !== 'string' || typeof filePath !== 'string') throw new PluginsControlError(400, 'body')
      // Content inspection of stored artifacts is a later enhancement; record the read.
      writeAuditOutbox(deps.db, {
        at: now(),
        event: 'admin-plugin-content-read',
        outcome: 'ok',
        userId: null,
        actor: actor.email,
        detail: { versionId: id, file: filePath.slice(0, 200) },
      })
      throw new PluginsControlError(501, 'file-preview-unavailable')
    },
    'POST /admin/plugins/requests/approve': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        return approveSubmission({
          db: deps.db,
          adminUserId: request.actor.userId,
          versionId: String(body.versionId ?? body.id ?? ''),
          expectedArtifactSha512: String(body.expectedArtifactSha512 ?? ''),
          scope: scopeFromBody(body.scope),
          allowedBuilds: Array.isArray(body.allowedBuilds)
            ? body.allowedBuilds.filter((x): x is string => typeof x === 'string')
            : [],
          reviewNote: typeof body.reviewNote === 'string' ? body.reviewNote : undefined,
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/requests/reject': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        rejectSubmission({
          db: deps.db,
          adminUserId: request.actor.userId,
          versionId: String(body.versionId ?? body.id ?? ''),
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          now: now(),
        })
        return { ok: true }
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/upload': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      const tarballB64 = body.tarball
      if (typeof tarballB64 !== 'string' || tarballB64.length === 0) {
        throw new PluginsControlError(400, 'tarball')
      }
      let tarball: Buffer
      try { tarball = Buffer.from(tarballB64, 'base64') } catch {
        throw new PluginsControlError(400, 'tarball')
      }
      if (tarball.byteLength === 0 || tarball.byteLength > MAX_UPLOAD) {
        throw new PluginsControlError(413, 'artifact-too-large')
      }
      const closure = Array.isArray(body.closure) ? body.closure as Parameters<typeof adminUpload>[0]['closure'] : []
      try {
        return await adminUpload({
          db: deps.db,
          storeRoot: deps.storeDir,
          adminUserId: request.actor.userId,
          scope: scopeFromBody(body.scope),
          source: { type: 'upload', tarball },
          closure,
          allowedBuilds: Array.isArray(body.allowedBuilds)
            ? body.allowedBuilds.filter((x): x is string => typeof x === 'string')
            : [],
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/scope': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        return changeScope({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          scopes: body.scopes !== undefined ? scopesFromBody(body.scopes) : [scopeFromBody(body.scope)],
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/rollback': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        return rollbackListing({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/delist': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        delistPackage({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          now: now(),
        })
        return { ok: true }
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/relist': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        relistPackage({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          now: now(),
        })
        return { ok: true }
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/revoke': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        return revokeVersion({
          db: deps.db,
          adminUserId: request.actor.userId,
          versionId: String(body.versionId ?? ''),
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/defaults': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      const action = body.action === 'clear' ? 'clear' : 'set'
      try {
        if (action === 'clear') {
          return clearDefault({
            db: deps.db,
            adminUserId: request.actor.userId,
            packageId: String(body.packageId ?? ''),
            scope: scopeFromBody(body.scope ?? { kind: 'company', target: '*' }),
            now: now(),
          })
        }
        return setDefault({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          scope: scopeFromBody(body.scope ?? { kind: 'company', target: '*' }),
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/defaults/reset': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      try {
        return resetDefault({
          db: deps.db,
          adminUserId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          scope: scopeFromBody(body.scope ?? { kind: 'company', target: '*' }),
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /admin/plugins/restore': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      const userId = String(body.userId ?? '')
      const snapshotId = String(body.snapshotId ?? '')
      if (!USER.test(userId) || snapshotId.length === 0) throw new PluginsControlError(400, 'body')
      const row = deps.db.db.prepare(
        'SELECT id FROM plugin_profile_snapshot WHERE id = ? AND user_id = ?',
      ).get(snapshotId, userId)
      if (row === undefined) throw new PluginsControlError(404, 'not-found')
      deps.db.db.prepare(
        'UPDATE plugin_profile_snapshot SET restore_requested_at = ? WHERE id = ?',
      ).run(now(), snapshotId)
      writeAuditOutbox(deps.db, {
        at: now(),
        event: 'admin-plugin-restore',
        outcome: 'ok',
        userId,
        actor: request.actor.email,
        detail: { snapshotId },
      })
      return { ok: true, snapshotId }
    },
    'GET /admin/plugins/policy': async ({ actor }) => {
      requireAdmin(actor)
      return handlePluginPolicyAdmin({
        db: deps.db,
        method: 'GET',
        path: '/admin/plugins/policy',
        actor: { userId: actor.userId, email: actor.email },
      })
    },
    'PUT /admin/plugins/policy': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      return handlePluginPolicyAdmin({
        db: deps.db,
        method: 'PUT',
        path: '/admin/plugins/policy',
        actor: { userId: request.actor.userId, email: request.actor.email },
        body,
      })
    },
    'GET /admin/plugins/limits': async ({ actor, query }) => {
      requireAdmin(actor)
      return handlePluginLimitsAdmin({
        db: deps.db,
        method: 'GET',
        path: '/admin/plugins/limits',
        actor: { userId: actor.userId, email: actor.email },
        query,
        groupsFor,
        emailFor,
      })
    },
    'GET /admin/plugins/limits/effective': async ({ actor, query }) => {
      requireAdmin(actor)
      return handlePluginLimitsAdmin({
        db: deps.db,
        method: 'GET',
        path: '/admin/plugins/limits/effective',
        actor: { userId: actor.userId, email: actor.email },
        query,
        groupsFor,
        emailFor,
      })
    },
    'PUT /admin/plugins/limits': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      return handlePluginLimitsAdmin({
        db: deps.db,
        method: 'PUT',
        path: '/admin/plugins/limits',
        actor: { userId: request.actor.userId, email: request.actor.email },
        body,
        groupsFor,
        emailFor,
      })
    },
    'DELETE /admin/plugins/limits': async (request) => {
      requireAdmin(request.actor)
      const body = await request.json()
      return handlePluginLimitsAdmin({
        db: deps.db,
        method: 'DELETE',
        path: '/admin/plugins/limits',
        actor: { userId: request.actor.userId, email: request.actor.email },
        body,
        groupsFor,
        emailFor,
      })
    },

    // --- me ---
    'GET /me/plugins': async ({ actor }) => {
      const submissions = deps.db.db.prepare(
        `SELECT v.id AS versionId, v.package_id AS packageId, p.name AS name, v.version AS version,
                v.state AS state, v.mirror_state AS mirrorState, v.created_at AS submittedAt,
                v.review_note AS reason, v.request_note AS note
         FROM plugin_version v
         JOIN plugin_package p ON p.id = v.package_id
         WHERE v.requested_by = ? OR p.owner_user_id = ?
         ORDER BY v.created_at DESC
         LIMIT 200`,
      ).all(actor.userId, actor.userId)
      const defaults = defaultsVisibleToUser(deps.db, actor.userId, new Set(groupsFor(actor.userId)))
      return { submissions, defaults }
    },
    'POST /me/plugins/submit': async (request) => {
      const body = await request.json()
      const name = String(body.name ?? body.package ?? '')
      const version = String(body.version ?? '')
      const source = body.source as Parameters<typeof submitPluginVersion>[0]['source'] | undefined
      if (source === undefined || typeof source !== 'object') throw new PluginsControlError(400, 'source')
      const limits = effectivePluginLimits(listPluginLimitRows(deps.db), request.actor.userId, groupsFor(request.actor.userId))
      try {
        return submitPluginVersion({
          db: deps.db,
          userId: request.actor.userId,
          isAdmin: request.actor.role === 'admin',
          name,
          version,
          source: { ...source, name: source.name ?? name, version: source.version ?? version } as Parameters<typeof submitPluginVersion>[0]['source'],
          requestNote: typeof body.note === 'string' ? body.note : undefined,
          now: now(),
          limits: {
            maxSubmissions: limits.max_submissions.value,
            maxSubmissionBytes: limits.max_submission_bytes.value,
          },
        })
      } catch (error) { mapDomainError(error) }
    },
    'POST /me/plugins/withdraw': async (request) => {
      const body = await request.json()
      try {
        withdrawSubmission({
          db: deps.db,
          userId: request.actor.userId,
          versionId: String(body.versionId ?? ''),
          now: now(),
        })
        return { ok: true }
      } catch (error) { mapDomainError(error) }
    },
    'POST /me/plugins/delist-request': async (request) => {
      const body = await request.json()
      const packageId = String(body.packageId ?? '')
      const pkg = deps.db.db.prepare(
        'SELECT id, owner_user_id, name FROM plugin_package WHERE id = ?',
      ).get(packageId) as { id: string; owner_user_id: string | null; name: string } | undefined
      if (pkg === undefined) throw new PluginsControlError(404, 'not-found')
      if (pkg.owner_user_id !== request.actor.userId && request.actor.role !== 'admin') {
        throw new PluginsControlError(403, 'not-owner')
      }
      writeAuditOutbox(deps.db, {
        at: now(),
        event: 'plugin-delist-request',
        outcome: 'ok',
        userId: request.actor.userId,
        actor: request.actor.email,
        detail: { package: pkg.name, packageId },
      })
      return { ok: true }
    },
    'POST /me/plugins/defaults/reenable': async (request) => {
      const body = await request.json()
      try {
        return reenableDefault({
          db: deps.db,
          userId: request.actor.userId,
          packageId: String(body.packageId ?? ''),
          now: now(),
        })
      } catch (error) { mapDomainError(error) }
    },
    'GET /me/plugins/snapshots': async ({ actor }) => {
      const snapshots = deps.db.db.prepare(
        `SELECT id, at AS savedAt, reason AS label FROM plugin_profile_snapshot
         WHERE user_id = ? ORDER BY at DESC LIMIT 20`,
      ).all(actor.userId)
      return { snapshots }
    },
    'POST /me/plugins/restore': async (request) => {
      const body = await request.json()
      const snapshotId = String(body.snapshotId ?? '')
      const row = deps.db.db.prepare(
        'SELECT id FROM plugin_profile_snapshot WHERE id = ? AND user_id = ?',
      ).get(snapshotId, request.actor.userId)
      if (row === undefined) throw new PluginsControlError(404, 'not-found')
      deps.db.db.prepare(
        'UPDATE plugin_profile_snapshot SET restore_requested_at = ? WHERE id = ?',
      ).run(now(), snapshotId)
      writeAuditOutbox(deps.db, {
        at: now(),
        event: 'plugin-restore',
        outcome: 'ok',
        userId: request.actor.userId,
        actor: request.actor.email,
        detail: { snapshotId },
      })
      return { ok: true, snapshotId }
    },
  }
}

/** HTTP handler for the control socket (KB-shaped). */
export function pluginsControlHandler(
  routes: PluginsControlRoutes,
  log: (line: string) => void = () => {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const send = (status: number, value: unknown) => {
        if (res.headersSent) { res.end(); return }
        // Policy/limits handlers already return { status, body }.
        if (
          value !== null && typeof value === 'object' && !Array.isArray(value)
          && 'status' in value && 'body' in value
          && typeof (value as { status: unknown }).status === 'number'
        ) {
          const wrapped = value as { status: number; body: unknown }
          res.writeHead(wrapped.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(wrapped.body))
          return
        }
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      try {
        const url = new URL(req.url ?? '/', 'http://plugins.invalid')
        const route = routes[`${req.method ?? 'GET'} ${url.pathname}`]
        if (route === undefined) throw new PluginsControlError(404, 'not-found')
        const user = req.headers['x-dsh-user']
        const internal = url.pathname.startsWith('/internal/') || url.pathname.startsWith('/control/')
        if (!internal && (typeof user !== 'string' || !USER.test(user))) {
          throw new PluginsControlError(401, 'actor')
        }
        const role = ROLE(req.headers['x-dsh-role'])
        if (url.pathname.startsWith('/admin/') && role !== 'admin') {
          throw new PluginsControlError(403, 'forbidden')
        }
        const email = typeof req.headers['x-dsh-email'] === 'string'
          ? req.headers['x-dsh-email'].slice(0, 320)
          : ''
        let parsed: Promise<Record<string, unknown>> | undefined
        const request: PluginsControlRequest = {
          actor: {
            userId: typeof user === 'string' ? user : 'system',
            email: email || (typeof user === 'string' ? user : 'system'),
            role,
          },
          query: url.searchParams,
          json: () => parsed ??= (async () => {
            if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) {
              throw new PluginsControlError(415, 'json-only')
            }
            let value: unknown
            try {
              value = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}')
            } catch (error) {
              if (error instanceof PluginsControlError) throw error
              throw new PluginsControlError(400, 'body')
            }
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new PluginsControlError(400, 'body')
            }
            return value as Record<string, unknown>
          })(),
          bytes: async (limit) => {
            if (!/^application\/octet-stream(;|$)/.test(req.headers['content-type'] ?? '')) {
              throw new PluginsControlError(415, 'octet-stream-only')
            }
            return readBody(req, limit)
          },
        }
        send(200, await route(request) ?? {})
      } catch (error) {
        if (error instanceof PluginsControlError) {
          send(error.status, { code: error.code, ...error.extra })
          return
        }
        log(`plugins-control: request failed: ${(error as Error).message.slice(0, 200)}`)
        send(500, { code: 'internal' })
      }
    })()
  }
}

export interface PluginsControlServer {
  readonly path: string
  close(): Promise<void>
}

/** Listen on a Unix socket with mode/gid; replaces any stale socket file. */
export async function startPluginsControlServer(
  deps: PluginsControlDeps,
  options: {
    readonly path: string
    readonly mode?: number
    readonly gid?: number
    readonly routes?: PluginsControlRoutes
  },
): Promise<PluginsControlServer> {
  validateMarketPorts(deps.ports)
  const routes = options.routes ?? buildPluginsControlRoutes(deps)
  const handler = pluginsControlHandler(routes, deps.log)
  await rm(options.path, { force: true })
  const server: Server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.path, () => { server.off('error', reject); resolve() })
  })
  const mode = options.mode ?? (options.gid !== undefined ? 0o660 : 0o600)
  await chmod(options.path, mode)
  if (options.gid !== undefined) {
    await chown(options.path, process.getuid?.() ?? -1, options.gid)
  }
  return {
    path: options.path,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve())
      })
      await rm(options.path, { force: true }).catch(() => {})
    },
  }
}
