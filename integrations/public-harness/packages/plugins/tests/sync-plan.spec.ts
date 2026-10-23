/** 1D.2: sync plan, report apply, reconcile-plan registry (design § Default installs). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { submitPluginVersion } from '../src/submit.ts'
import { approveSubmission } from '../src/approve.ts'
import { rollbackListing } from '../src/listing.ts'
import { setDefault } from '../src/defaults.ts'
import { openEndpoint } from '../src/listen.ts'
import {
  SyncPlanError,
  applySyncReport,
  buildSyncPlan,
  reconcilePlan,
} from '../src/sync-plan.ts'
import { mintMarketToken } from '../src/token.ts'
import { startMarketHttpServer, type MarketHttpServer } from '../src/listen.ts'

const roots: string[] = []
const opened: PluginsDb[] = []
const servers: MarketHttpServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-plan-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}sync-demo`
const SHA_A = 'a'.repeat(128)
const SHA_B = 'b'.repeat(128)

function npmSource(name: string, version: string) {
  return { type: 'npm' as const, registry: 'https://registry.npmjs.org', name, version }
}

function submitReady(
  db: PluginsDb,
  opts: { name?: string; version?: string; userId?: string; sha?: string; allowedBuilds?: string[] } = {},
): { packageId: string; versionId: string; name: string; sha: string } {
  const name = opts.name ?? CORP
  const version = opts.version ?? '1.0.0'
  const sha = opts.sha ?? SHA_A
  const result = submitPluginVersion({
    db,
    userId: opts.userId ?? 'user-a',
    name,
    version,
    source: npmSource(name, version),
  })
  db.db.prepare(
    `UPDATE plugin_version SET mirror_state = 'ready', artifact_sha512 = ?, install_scripts = '[]'
     WHERE id = ?`,
  ).run(sha, result.versionId)
  return { ...result, name, sha }
}

function approve(
  db: PluginsDb,
  versionId: string,
  opts: {
    scope?: { kind: 'company'; target: '*' } | { kind: 'group'; target: string }
    allowedBuilds?: readonly string[]
    sha?: string
  } = {},
): void {
  const row = db.db.prepare('SELECT artifact_sha512 FROM plugin_version WHERE id = ?').get(versionId) as {
    artifact_sha512: string
  }
  approveSubmission({
    db,
    adminUserId: 'admin-1',
    versionId,
    expectedArtifactSha512: opts.sha ?? row.artifact_sha512,
    scope: opts.scope ?? { kind: 'company', target: '*' },
    allowedBuilds: opts.allowedBuilds,
  })
}

function insertState(
  db: PluginsDb,
  opts: {
    userId: string
    packageId: string
    state: string
    updatedAt: number
    installedVersion?: string | null
    targetVersion?: string | null
  },
): void {
  db.db.prepare(
    `INSERT INTO plugin_default_state
      (user_id, package_id, state, installed_version, target_version, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    opts.userId,
    opts.packageId,
    opts.state,
    opts.installedVersion ?? null,
    opts.targetVersion ?? null,
    opts.updatedAt,
  )
}

function stateOf(db: PluginsDb, userId: string, packageId: string) {
  return db.db.prepare(
    'SELECT state, installed_version, target_version FROM plugin_default_state WHERE user_id = ? AND package_id = ?',
  ).get(userId, packageId) as {
    state: string
    installed_version: string | null
    target_version: string | null
  } | undefined
}

describe('buildSyncPlan', () => {
  it('plans_install_for_new_default_absent_from_state', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.2.0', sha: SHA_A })
    approve(db, pkg.versionId, { allowedBuilds: ['esbuild'] })
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })

    const plan = buildSyncPlan({ db, userId: 'user-a', groups: new Set() })
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({
      name: CORP,
      version: '1.2.0',
      fromVersion: null,
      sha512: SHA_A,
      action: 'install',
      allowedBuilds: ['esbuild'],
    })
  })

  it('plans_update_when_listed_newer_than_installed', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', sha: SHA_A })
    approve(db, v1.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: v1.packageId,
      scope: { kind: 'company', target: '*' },
    })
    const v2 = submitReady(db, { version: '2.0.0', sha: SHA_B, userId: 'user-a' })
    approve(db, v2.versionId, { allowedBuilds: ['sharp'] })
    insertState(db, {
      userId: 'user-a',
      packageId: v1.packageId,
      state: 'installed',
      installedVersion: '1.0.0',
      targetVersion: '1.0.0',
      updatedAt: 10,
    })

    const plan = buildSyncPlan({ db, userId: 'user-a', groups: new Set() })
    expect(plan.entries).toEqual([
      expect.objectContaining({
        name: CORP,
        version: '2.0.0',
        fromVersion: '1.0.0',
        sha512: SHA_B,
        action: 'update',
        allowedBuilds: ['sharp'],
      }),
    ])
  })

  it('plans_downgrade_after_listing_rollback', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', sha: SHA_A })
    approve(db, v1.versionId)
    const v2 = submitReady(db, { version: '2.0.0', sha: SHA_B, userId: 'user-a' })
    approve(db, v2.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: v1.packageId,
      scope: { kind: 'company', target: '*' },
    })
    rollbackListing({ db, adminUserId: 'admin-1', packageId: v1.packageId, now: 50 })
    insertState(db, {
      userId: 'user-a',
      packageId: v1.packageId,
      state: 'installed',
      installedVersion: '2.0.0',
      targetVersion: '2.0.0',
      updatedAt: 40,
    })

    const plan = buildSyncPlan({ db, userId: 'user-a', groups: new Set() })
    expect(plan.entries).toEqual([
      expect.objectContaining({
        name: CORP,
        version: '1.0.0',
        fromVersion: '2.0.0',
        sha512: SHA_A,
        action: 'downgrade',
      }),
    ])
  })

  it('skips_opted_out_and_user_managed', () => {
    const db = fixture()
    const opted = submitReady(db, { name: `${COMPANY_SCOPE_PREFIX}opted`, version: '1.0.0' })
    approve(db, opted.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: opted.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: opted.packageId,
      state: 'opted-out',
      updatedAt: 1,
    })

    const managed = submitReady(db, {
      name: `${COMPANY_SCOPE_PREFIX}managed`,
      version: '1.0.0',
      userId: 'user-b',
    })
    approve(db, managed.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: managed.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: managed.packageId,
      state: 'user-managed',
      installedVersion: '0.9.0',
      updatedAt: 2,
    })

    const plan = buildSyncPlan({ db, userId: 'user-a', groups: new Set() })
    expect(plan.entries).toEqual([])
  })

  it('omits_entry_when_already_at_listed_version', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.5.0' })
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: pkg.packageId,
      state: 'installed',
      installedVersion: '1.5.0',
      targetVersion: '1.5.0',
      updatedAt: 1,
    })

    expect(buildSyncPlan({ db, userId: 'user-a', groups: new Set() }).entries).toEqual([])
  })
})

describe('applySyncReport', () => {
  it('maps_user_removed_to_opted_out_only', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: pkg.packageId,
      state: 'installed',
      installedVersion: '1.0.0',
      updatedAt: 1,
    })

    const other = submitReady(db, {
      name: `${COMPANY_SCOPE_PREFIX}other`,
      version: '1.0.0',
      userId: 'user-b',
    })
    approve(db, other.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: other.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: other.packageId,
      state: 'installed',
      installedVersion: '1.0.0',
      updatedAt: 2,
    })

    const result = applySyncReport({
      db,
      userId: 'user-a',
      groups: new Set(),
      report: {
        installed: [{ name: other.name, version: '1.0.0' }],
        opLog: [{ type: 'user-removed', name: CORP }],
        results: [],
      },
      now: 100,
    })

    expect(stateOf(db, 'user-a', pkg.packageId)).toMatchObject({
      state: 'opted-out',
      installed_version: null,
    })
    // Absent without user-removed is not opted-out
    expect(stateOf(db, 'user-a', other.packageId)?.state).not.toBe('opted-out')
    expect(result.optedOut).toEqual([CORP])
  })

  it('marks_open_or_failed_applies_as_failed', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '2.0.0', sha: SHA_B })
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'user-a',
      packageId: pkg.packageId,
      state: 'pending',
      installedVersion: '1.0.0',
      targetVersion: '2.0.0',
      updatedAt: 1,
    })

    applySyncReport({
      db,
      userId: 'user-a',
      groups: new Set(),
      report: {
        installed: [{ name: CORP, version: '1.0.0' }],
        opLog: [{ type: 'intent', name: CORP, version: '2.0.0' }],
        results: [{ name: CORP, action: 'update', outcome: 'failed', reason: 'integrity' }],
      },
      now: 200,
    })
    expect(stateOf(db, 'user-a', pkg.packageId)).toMatchObject({ state: 'failed' })
  })

  it('derives_user_managed_and_installed_count', () => {
    const db = fixture()
    const def = submitReady(db, { version: '1.0.0' })
    approve(db, def.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: def.packageId,
      scope: { kind: 'company', target: '*' },
    })

    openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-a',
      accountUid: 2001,
      ports: { min: 31_100, max: 31_110 },
    })

    const result = applySyncReport({
      db,
      userId: 'user-a',
      groups: new Set(),
      report: {
        installed: [
          { name: CORP, version: '0.8.0' },
          { name: `${COMPANY_SCOPE_PREFIX}extra`, version: '3.0.0' },
        ],
        opLog: [],
        results: [],
      },
      now: 300,
    })

    expect(stateOf(db, 'user-a', def.packageId)).toMatchObject({
      state: 'user-managed',
      installed_version: '0.8.0',
    })
    expect(result.userManaged).toEqual([CORP])
    expect(result.installedCount).toBe(2)

    const endpoint = db.db.prepare(
      'SELECT last_report FROM plugin_endpoint WHERE user_id = ?',
    ).get('user-a') as { last_report: string }
    const stored = JSON.parse(endpoint.last_report) as { installedCount: number }
    expect(stored.installedCount).toBe(2)
  })

  it('marks_successful_apply_as_installed', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.0.0' })
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })

    applySyncReport({
      db,
      userId: 'user-a',
      groups: new Set(),
      report: {
        installed: [{ name: CORP, version: '1.0.0' }],
        opLog: [{ type: 'done', name: CORP, version: '1.0.0' }],
        results: [{ name: CORP, action: 'install', outcome: 'done' }],
      },
      now: 400,
    })
    expect(stateOf(db, 'user-a', pkg.packageId)).toMatchObject({
      state: 'installed',
      installed_version: '1.0.0',
      target_version: '1.0.0',
    })
  })
})

describe('reconcilePlan', () => {
  it('returns_name_at_exact_semver_sha512_and_user_registry', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.4.0', sha: SHA_A })
    approve(db, pkg.versionId, { allowedBuilds: ['node-gyp'] })
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    const ep = openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-r',
      accountUid: 2100,
      ports: { min: 31_200, max: 31_210 },
    })

    const plan = reconcilePlan({
      db,
      userId: 'user-a',
      groups: new Set(),
      registryHost: '127.0.0.1',
    })
    expect(plan.registry).toBe(`http://127.0.0.1:${ep.port}/npm/`)
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({
      name: CORP,
      version: '1.4.0',
      sha512: SHA_A,
      action: 'install',
      allowedBuilds: ['node-gyp'],
      spec: `${CORP}@1.4.0`,
    })
  })

  it('accepts_hostAddress_as_registry_host', () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.0.0' })
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    const ep = openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-h',
      accountUid: 2101,
      ports: { min: 31_220, max: 31_230 },
    })

    const plan = reconcilePlan({
      db,
      userId: 'user-a',
      groups: new Set(),
      registryHost: '192.168.200.1',
      hostAddress: '192.168.200.1',
    })
    expect(plan.registry).toBe(`http://192.168.200.1:${ep.port}/npm/`)
  })

  it('rejects_bad_registry_host_or_missing_endpoint', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-bad',
      accountUid: 2102,
      ports: { min: 31_240, max: 31_250 },
    })

    expect(() => reconcilePlan({
      db,
      userId: 'user-a',
      groups: new Set(),
      registryHost: '8.8.8.8',
      hostAddress: '192.168.200.1',
    })).toThrow(SyncPlanError)
    try {
      reconcilePlan({
        db,
        userId: 'user-a',
        groups: new Set(),
        registryHost: '8.8.8.8',
        hostAddress: '192.168.200.1',
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'bad-registry', status: 400 })
    }

    expect(() => reconcilePlan({
      db,
      userId: 'user-missing',
      groups: new Set(),
      registryHost: '127.0.0.1',
    })).toThrow(SyncPlanError)
    try {
      reconcilePlan({
        db,
        userId: 'user-missing',
        groups: new Set(),
        registryHost: '127.0.0.1',
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'no-endpoint', status: 409 })
    }
  })
})

describe('market HTTP /sync routes', () => {
  it('GET_sync_and_POST_sync_report_require_bearer', async () => {
    const db = fixture()
    const pkg = submitReady(db, { version: '1.0.0' })
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    const minted = mintMarketToken()
    const server = await startMarketHttpServer({
      host: '127.0.0.1',
      port: 0,
      lookup: () => ({
        userId: 'user-a',
        accountUid: 2200,
        tokenSha256: minted.tokenSha256,
      }),
      buildIndex: () => ({ format: 1, plugins: [] }),
      lookupPackument: () => undefined,
      lookupTarball: () => undefined,
      buildSyncPlan: (userId) => buildSyncPlan({ db, userId, groups: new Set() }),
      applySyncReport: (userId, report) => applySyncReport({
        db,
        userId,
        groups: new Set(),
        report: report as Parameters<typeof applySyncReport>[0]['report'],
      }),
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    const noAuth = await fetch(`${base}/sync`)
    expect(noAuth.status).toBe(404)

    const ok = await fetch(`${base}/sync`, { headers: { authorization: `Bearer ${minted.token}` } })
    expect(ok.status).toBe(200)
    const plan = await ok.json() as { entries: Array<{ action: string }> }
    expect(plan.entries[0]?.action).toBe('install')

    const reportRes = await fetch(`${base}/sync/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${minted.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        installed: [{ name: CORP, version: '1.0.0' }],
        opLog: [{ type: 'done', name: CORP, version: '1.0.0' }],
        results: [{ name: CORP, action: 'install', outcome: 'done' }],
      }),
    })
    expect(reportRes.status).toBe(200)
    expect(stateOf(db, 'user-a', pkg.packageId)?.state).toBe('installed')
  })
})
