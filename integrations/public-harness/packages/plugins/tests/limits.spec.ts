/** Task 1E.1: plugin limits — generalized resolver, CRUD, enforcement, admin shapes. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveLimits, atLimit } from '@public-harness/kb'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { insertPackage, insertVersion } from '../src/migrate.ts'
import { newId } from '../src/ids.ts'
import { submitPluginVersion, SubmitError } from '../src/submit.ts'
import { buildSyncPlan, applySyncReport } from '../src/sync-plan.ts'
import { createMarketBuildIndex } from '../src/index-builder.ts'
import { listPendingAudit } from '../src/audit.ts'
import {
  PLUGIN_LIMIT_NAMES,
  DEFAULT_PLUGIN_LIMITS,
  effectivePluginLimits,
  listPluginLimits,
  setPluginLimit,
  deletePluginLimit,
  seedPluginLimits,
  countUserSubmissions,
  countUserSubmissionBytes,
  assertSubmissionWithinLimits,
  installedCountFromReport,
  packumentAllowed,
  createMarketLookupPackument,
  PluginLimitError,
  type PluginLimitRow,
  handlePluginLimitsAdmin,
} from '../src/limits.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plim-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const row = (
  scopeType: PluginLimitRow['scopeType'],
  scopeId: string,
  name: PluginLimitRow['name'],
  value: number | null,
): PluginLimitRow => ({ scopeType, scopeId, name, value, updatedBy: 't', updatedAt: 0 })

describe('generalized effectiveLimits (kb)', () => {
  it('resolves_plugin_limit_names_with_user_group_global_precedence', () => {
    const GiB = 1024 ** 3
    const names = PLUGIN_LIMIT_NAMES
    const defaults = DEFAULT_PLUGIN_LIMITS
    const rows = [
      row('global', '*', 'max_installed', 50),
      row('global', '*', 'max_submissions', 20),
      row('global', '*', 'max_submission_bytes', GiB),
      row('group', 'wecom:1', 'max_installed', 10),
      row('group', 'wecom:2', 'max_installed', 80),
      row('group', 'wecom:3', 'max_submissions', null),
      row('user', 'u1', 'max_submission_bytes', 100),
    ]
    expect(effectiveLimits(rows, 'u1', ['wecom:1', 'wecom:2', 'wecom:3'], names, defaults)).toEqual({
      max_installed: { value: 80, source: 'group:wecom:2' },
      max_submissions: { value: null, source: 'group:wecom:3' },
      max_submission_bytes: { value: 100, source: 'user' },
    })
    expect(effectivePluginLimits(rows, 'u2', ['wecom:1'])).toEqual({
      max_installed: { value: 10, source: 'group:wecom:1' },
      max_submissions: { value: 20, source: 'global' },
      max_submission_bytes: { value: GiB, source: 'global' },
    })
    expect(atLimit({ value: 50, source: 'global' }, 50)).toBe(true)
    expect(atLimit({ value: null, source: 'global' }, 999)).toBe(false)
  })
})

describe('seed and defaults', () => {
  it('seeds_global_defaults_50_20_1GiB_on_open', () => {
    const db = fixture()
    const view = listPluginLimits(db)
    expect(view.global).toEqual({
      max_installed: 50,
      max_submissions: 20,
      max_submission_bytes: 1024 ** 3,
    })
    expect(PLUGIN_LIMIT_NAMES).toEqual(['max_installed', 'max_submissions', 'max_submission_bytes'])
    expect(DEFAULT_PLUGIN_LIMITS.max_submission_bytes).toBe(1024 ** 3)
  })

  it('seedPluginLimits_is_idempotent', () => {
    const db = fixture()
    seedPluginLimits(db, 'reseed', 1)
    expect(listPluginLimits(db).global.max_installed).toBe(50)
  })
})

describe('set and delete admin shapes', () => {
  it('setPluginLimit_writes_override_and_audits_without_deleting_existing', () => {
    const db = fixture()
    const now = 1_700_000_000_000
    // Existing submission stays after lowering.
    submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}keep`, version: '1.0.0',
      source: { type: 'npm', registry: 'https://registry.npmjs.org', name: `${COMPANY_SCOPE_PREFIX}keep`, version: '1.0.0' },
    })
    const beforeCount = countUserSubmissions(db, 'user-a')
    expect(beforeCount).toBe(1)

    const view = setPluginLimit({
      db,
      scope: { type: 'user', id: 'user-a' },
      name: 'max_submissions',
      value: 1,
      actor: 'admin@example.com',
      now,
    })
    expect(view.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: expect.objectContaining({ type: 'user', id: 'user-a' }),
        values: expect.objectContaining({ max_submissions: 1 }),
      }),
    ]))
    expect(countUserSubmissions(db, 'user-a')).toBe(1)
    const pkg = db.db.prepare('SELECT name FROM plugin_package WHERE owner_user_id = ?').get('user-a') as { name: string }
    expect(pkg.name).toBe(`${COMPANY_SCOPE_PREFIX}keep`)

    const audit = listPendingAudit(db)
    expect(audit.some(r => r.event === 'admin-plugin-limit-change')).toBe(true)
    const change = audit.find(r => r.event === 'admin-plugin-limit-change')!
    expect(change.actor).toBe('admin@example.com')
    expect(change.detail).toMatch(/max_submissions/)
  })

  it('deletePluginLimit_removes_override_and_audits', () => {
    const db = fixture()
    setPluginLimit({
      db, scope: { type: 'group', id: 'wecom:eng' }, name: 'max_installed', value: 5,
      actor: 'admin@example.com', now: 1,
    })
    const view = deletePluginLimit({
      db, scope: { type: 'group', id: 'wecom:eng' }, name: 'max_installed',
      actor: 'admin@example.com', now: 2,
    })
    expect(view.overrides.every(o => o.scope.id !== 'wecom:eng' || o.values.max_installed === undefined)).toBe(true)
    expect(listPendingAudit(db).some(r => r.event === 'admin-plugin-limit-delete')).toBe(true)
  })

  it('delete_refuses_global_and_missing_override', () => {
    const db = fixture()
    expect(() => deletePluginLimit({
      db, scope: { type: 'global', id: '*' }, name: 'max_installed',
      actor: 'admin@example.com', now: 1,
    })).toThrow(PluginLimitError)
    expect(() => deletePluginLimit({
      db, scope: { type: 'user', id: 'nobody' }, name: 'max_installed',
      actor: 'admin@example.com', now: 1,
    })).toThrow(/override-not-found/)
  })

  it('handlePluginLimitsAdmin_covers_get_put_delete_effective', () => {
    const db = fixture()
    const get = handlePluginLimitsAdmin({
      db, method: 'GET', path: '/admin/plugins/limits',
      actor: { userId: 'admin', email: 'admin@example.com' },
    })
    expect(get.status).toBe(200)
    expect((get.body as { global: Record<string, number> }).global.max_installed).toBe(50)

    const put = handlePluginLimitsAdmin({
      db, method: 'PUT', path: '/admin/plugins/limits',
      actor: { userId: 'admin', email: 'admin@example.com' },
      body: { scope: { type: 'user', id: 'u1' }, name: 'max_installed', value: 3 },
    })
    expect(put.status).toBe(200)

    const effective = handlePluginLimitsAdmin({
      db, method: 'GET', path: '/admin/plugins/limits/effective',
      actor: { userId: 'admin', email: 'admin@example.com' },
      query: new URLSearchParams({ user: 'u1' }),
      groupsFor: id => (id === 'u1' ? ['wecom:1'] : []),
      emailFor: id => (id === 'u1' ? 'u1@example.com' : null),
    })
    expect(effective.status).toBe(200)
    const body = effective.body as {
      user: { id: string; email: string | null }
      limits: Record<string, { value: number | null; source: string }>
    }
    expect(body.user).toEqual({ id: 'u1', email: 'u1@example.com', groups: ['wecom:1'] })
    expect(body.limits.max_installed).toEqual({ value: 3, source: 'user' })

    const del = handlePluginLimitsAdmin({
      db, method: 'DELETE', path: '/admin/plugins/limits',
      actor: { userId: 'admin', email: 'admin@example.com' },
      body: { scope: { type: 'user', id: 'u1' }, name: 'max_installed' },
    })
    expect(del.status).toBe(200)
  })
})

describe('submit and upload enforcement', () => {
  it('refuses_submit_at_max_submissions_from_effective_rows', () => {
    const db = fixture()
    setPluginLimit({
      db, scope: { type: 'user', id: 'user-a' }, name: 'max_submissions', value: 1,
      actor: 'admin@example.com', now: 1,
    })
    const limits = effectivePluginLimits(listLimitRows(db), 'user-a', [])
    submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}one`, version: '1.0.0',
      source: { type: 'npm', registry: 'https://registry.npmjs.org', name: `${COMPANY_SCOPE_PREFIX}one`, version: '1.0.0' },
      limits: {
        maxSubmissions: limits.max_submissions.value,
        maxSubmissionBytes: limits.max_submission_bytes.value,
      },
    })
    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}two`, version: '1.0.0',
      source: { type: 'npm', registry: 'https://registry.npmjs.org', name: `${COMPANY_SCOPE_PREFIX}two`, version: '1.0.0' },
      limits: {
        maxSubmissions: limits.max_submissions.value,
        maxSubmissionBytes: limits.max_submission_bytes.value,
      },
    })).toThrow(SubmitError)
    try {
      submitPluginVersion({
        db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}two`, version: '1.0.0',
        source: { type: 'npm', registry: 'https://registry.npmjs.org', name: `${COMPANY_SCOPE_PREFIX}two`, version: '1.0.0' },
        limits: { maxSubmissions: 1 },
      })
    } catch (error) {
      expect((error as SubmitError).code).toBe('limit-reached')
      expect((error as SubmitError).detail).toBe('max_submissions')
      expect((error as SubmitError).status).toBe(409)
    }
  })

  it('refuses_upload_submit_at_max_submission_bytes', () => {
    const db = fixture()
    setPluginLimit({
      db, scope: { type: 'global', id: '*' }, name: 'max_submission_bytes', value: 2048,
      actor: 'admin@example.com', now: 1,
    })
    const limits = effectivePluginLimits(listLimitRows(db), 'user-a', [])
    expect(() => assertSubmissionWithinLimits({
      db, userId: 'user-a', limits, additionalBytes: 2049, isNewPackage: true,
    })).toThrow(/limit-reached/)
    expect(() => submitPluginVersion({
      db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}big`, version: '1.0.0',
      source: {
        type: 'upload', name: `${COMPANY_SCOPE_PREFIX}big`, version: '1.0.0', sizeBytes: 2049,
      },
      limits: {
        maxSubmissions: limits.max_submissions.value,
        maxSubmissionBytes: limits.max_submission_bytes.value,
      },
    })).toThrow(/limit-reached/)
  })

  it('lowering_limit_never_deletes_existing_submissions', () => {
    const db = fixture()
    for (const n of ['a', 'b', 'c']) {
      submitPluginVersion({
        db, userId: 'user-a', name: `${COMPANY_SCOPE_PREFIX}${n}`, version: '1.0.0',
        source: { type: 'npm', registry: 'https://registry.npmjs.org', name: `${COMPANY_SCOPE_PREFIX}${n}`, version: '1.0.0' },
      })
    }
    setPluginLimit({
      db, scope: { type: 'user', id: 'user-a' }, name: 'max_submissions', value: 1,
      actor: 'admin@example.com', now: 1,
    })
    expect(countUserSubmissions(db, 'user-a')).toBe(3)
    const names = db.db.prepare('SELECT name FROM plugin_package WHERE owner_user_id = ? ORDER BY name').all('user-a') as Array<{ name: string }>
    expect(names).toHaveLength(3)
  })
})

describe('max_installed packument and index', () => {
  it('packument_refuses_new_package_when_report_at_limit', () => {
    expect(packumentAllowed({
      maxInstalled: 2,
      installedCount: 2,
      alreadyInstalled: false,
    })).toBe(false)
    expect(packumentAllowed({
      maxInstalled: 2,
      installedCount: 2,
      alreadyInstalled: true,
    })).toBe(true)
    expect(packumentAllowed({
      maxInstalled: null,
      installedCount: 99,
      alreadyInstalled: false,
    })).toBe(true)
    expect(packumentAllowed({
      maxInstalled: 2,
      installedCount: null,
      alreadyInstalled: false,
    })).toBe(true)
  })

  it('index_marks_entries_at_max_installed', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = newId('plg')
    const versionId = newId('plv')
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    insertPackage(db, {
      id: packageId, name, kind: 'bundle', origin: 'admin',
      ownerUserId: null, claimedAt: now, display: JSON.stringify({ title: 'Demo' }),
      iconSha512: null, createdAt: now,
    })
    insertVersion(db, {
      id: versionId, packageId, version: '1.0.0', source: JSON.stringify({ type: 'upload' }),
      state: 'approved', mirrorState: 'ready', mirrorError: null,
      artifactSha512: 'ab'.repeat(64), upstreamIntegrity: null, sizeBytes: 10,
      enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
      requestedBy: 'admin', requestNote: '', reviewedBy: 'admin', reviewedAt: now, reviewNote: null, createdAt: now,
    })
    db.db.prepare(
      `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
       VALUES (?, ?, NULL, 1, 'admin', ?)`,
    ).run(packageId, versionId, now)
    db.db.prepare(
      `INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, 'company', '*')`,
    ).run(packageId)
    db.db.prepare(
      `INSERT INTO plugin_endpoint (user_id, port, instance_id, account_uid, token_sha256, opened_at, last_report)
       VALUES (?, 30100, 'i1', 1000, 'deadbeef', ?, ?)`,
    ).run('user-a', now, JSON.stringify({ installedCount: 50, installed: [] }))

    setPluginLimit({
      db, scope: { type: 'global', id: '*' }, name: 'max_installed', value: 50,
      actor: 'admin@example.com', now,
    })

    // Adapter must mark on the built index (not only after a manual post-process).
    const buildIndex = createMarketBuildIndex(db, {
      registryUrl: 'http://127.0.0.1:30100/npm/',
      groupsFor: () => [],
    })
    const index = buildIndex('user-a')
    expect(index.plugins[0]?.name).toBe(name)
    expect(index.plugins[0]?.['x-dsh-at-limit']).toBe(true)

    // Already-installed names stay unmarked.
    db.db.prepare(
      `UPDATE plugin_endpoint SET last_report = ? WHERE user_id = ?`,
    ).run(JSON.stringify({ installedCount: 50, installed: [name] }), 'user-a')
    const indexInstalled = buildIndex('user-a')
    expect(indexInstalled.plugins[0]?.['x-dsh-at-limit']).toBeUndefined()
  })

  it('createMarketLookupPackument_refuses_when_report_at_limit', () => {
    const db = fixture()
    const now = Date.now()
    const name = `${COMPANY_SCOPE_PREFIX}demo`
    const other = `${COMPANY_SCOPE_PREFIX}other`
    const packument = { name, versions: { '1.0.0': { name, version: '1.0.0' } } }
    db.db.prepare(
      `INSERT INTO plugin_endpoint (user_id, port, instance_id, account_uid, token_sha256, opened_at, last_report)
       VALUES (?, 30102, 'i1', 1002, 'deadbeef', ?, ?)`,
    ).run('user-a', now, JSON.stringify({ installedCount: 2, installed: [other] }))
    setPluginLimit({
      db, scope: { type: 'global', id: '*' }, name: 'max_installed', value: 2,
      actor: 'admin@example.com', now,
    })

    const lookup = createMarketLookupPackument(db, {
      groupsFor: () => [],
      lookup: (n) => (n === name ? packument : undefined),
    })
    expect(lookup(name, 'user-a')).toBeUndefined()
    expect(lookup(other, 'user-a')).toBeUndefined() // underlying miss

    // Already installed escapes the gate.
    db.db.prepare(
      `UPDATE plugin_endpoint SET last_report = ? WHERE user_id = ?`,
    ).run(JSON.stringify({ installedCount: 2, installed: [name] }), 'user-a')
    expect(lookup(name, 'user-a')).toEqual(packument)

    // Missing / stale report escapes (best-effort).
    db.db.prepare(
      `UPDATE plugin_endpoint SET last_report = NULL WHERE user_id = ?`,
    ).run('user-a')
    expect(lookup(name, 'user-a')).toEqual(packument)
  })

  it('defaults_still_plan_past_limit_and_report_records_overage', () => {
    const db = fixture()
    const now = Date.now()
    const packageId = newId('plg')
    const versionId = newId('plv')
    const name = `${COMPANY_SCOPE_PREFIX}defaulted`
    insertPackage(db, {
      id: packageId, name, kind: 'bundle', origin: 'admin',
      ownerUserId: null, claimedAt: now, display: JSON.stringify({ title: 'D' }),
      iconSha512: null, createdAt: now,
    })
    insertVersion(db, {
      id: versionId, packageId, version: '1.0.0', source: JSON.stringify({ type: 'upload' }),
      state: 'approved', mirrorState: 'ready', mirrorError: null,
      artifactSha512: 'cd'.repeat(64), upstreamIntegrity: null, sizeBytes: 10,
      enginesDsh: null, installScripts: '[]', allowedBuilds: '[]',
      requestedBy: 'admin', requestNote: '', reviewedBy: 'admin', reviewedAt: now, reviewNote: null, createdAt: now,
    })
    db.db.prepare(
      `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
       VALUES (?, ?, NULL, 1, 'admin', ?)`,
    ).run(packageId, versionId, now)
    db.db.prepare(
      `INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, 'company', '*')`,
    ).run(packageId)
    db.db.prepare(
      `INSERT INTO plugin_default (package_id, kind, target, set_by, set_at, reset_at) VALUES (?, 'company', '*', 'admin', ?, NULL)`,
    ).run(packageId, now)
    db.db.prepare(
      `INSERT INTO plugin_endpoint (user_id, port, instance_id, account_uid, token_sha256, opened_at, last_report)
       VALUES (?, 30101, 'i1', 1001, 'deadbeef', ?, NULL)`,
    ).run('user-a', now)

    setPluginLimit({
      db, scope: { type: 'user', id: 'user-a' }, name: 'max_installed', value: 1,
      actor: 'admin@example.com', now,
    })

    // Defaults still appear in the plan even when the user is already at the cap.
    const plan = buildSyncPlan({ db, userId: 'user-a', groups: new Set() })
    expect(plan.entries.some(e => e.name === name && e.action === 'install')).toBe(true)

    // Report installs the default plus another market package → past max_installed=1.
    const result = applySyncReport({
      db, userId: 'user-a', groups: new Set(), now: now + 2,
      report: {
        installed: [
          { name, version: '1.0.0' },
          { name: `${COMPANY_SCOPE_PREFIX}other`, version: '1.0.0' },
        ],
        opLog: [],
        results: [{ name, outcome: 'ok' }],
      },
      limits: effectivePluginLimits(listLimitRows(db), 'user-a', []),
    })
    expect(result.installedCount).toBe(2)
    expect(result.overLimitDefaults).toBe(true)
    const endpoint = db.db.prepare('SELECT last_report FROM plugin_endpoint WHERE user_id = ?').get('user-a') as { last_report: string }
    const stored = JSON.parse(endpoint.last_report) as { installedCount: number; overLimitDefaults?: boolean }
    expect(stored.installedCount).toBe(2)
    expect(stored.overLimitDefaults).toBe(true)
  })
})

function listLimitRows(db: PluginsDb): PluginLimitRow[] {
  return (db.db.prepare(
    `SELECT scope_type AS scopeType, scope_id AS scopeId, name, value, updated_by AS updatedBy, updated_at AS updatedAt
     FROM dsh_plugin_limit`,
  ).all() as Array<Record<string, unknown>>).map(r => ({
    scopeType: r.scopeType as PluginLimitRow['scopeType'],
    scopeId: String(r.scopeId),
    name: r.name as PluginLimitRow['name'],
    value: r.value === null ? null : Number(r.value),
    updatedBy: String(r.updatedBy),
    updatedAt: Number(r.updatedAt),
  }))
}
