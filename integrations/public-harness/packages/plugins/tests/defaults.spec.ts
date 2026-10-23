/** 1D.1: defaults CRUD + state (design § Default installs). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { listPendingAudit } from '../src/audit.ts'
import { submitPluginVersion } from '../src/submit.ts'
import { approveSubmission } from '../src/approve.ts'
import { delistPackage } from '../src/listing.ts'
import {
  DefaultError,
  applyCountsForPackage,
  clearDefault,
  defaultsVisibleToUser,
  listDefaults,
  reenableDefault,
  resetDefault,
  setDefault,
  type DefaultStateValue,
} from '../src/defaults.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-defaults-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}defaults-demo`
const SHA = 'a'.repeat(128)

function npmSource(name: string, version: string) {
  return { type: 'npm' as const, registry: 'https://registry.npmjs.org', name, version }
}

function submitReady(
  db: PluginsDb,
  opts: { name?: string; version?: string; userId?: string } = {},
): { packageId: string; versionId: string; name: string } {
  const name = opts.name ?? CORP
  const version = opts.version ?? '1.0.0'
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
  ).run(SHA, result.versionId)
  return { ...result, name }
}

function approve(
  db: PluginsDb,
  versionId: string,
  scope: { kind: 'company'; target: '*' } | { kind: 'group'; target: string } = { kind: 'company', target: '*' },
): void {
  approveSubmission({
    db,
    adminUserId: 'admin-1',
    versionId,
    expectedArtifactSha512: SHA,
    scope,
  })
}

function defaultRow(db: PluginsDb, packageId: string, kind: string, target: string) {
  return db.db.prepare(
    'SELECT package_id, kind, target, set_by, set_at, reset_at FROM plugin_default WHERE package_id = ? AND kind = ? AND target = ?',
  ).get(packageId, kind, target) as {
    package_id: string
    kind: string
    target: string
    set_by: string
    set_at: number
    reset_at: number | null
  } | undefined
}

function insertState(
  db: PluginsDb,
  opts: {
    userId: string
    packageId: string
    state: DefaultStateValue
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
    'SELECT state, installed_version, target_version, updated_at FROM plugin_default_state WHERE user_id = ? AND package_id = ?',
  ).get(userId, packageId) as {
    state: string
    installed_version: string | null
    target_version: string | null
    updated_at: number
  } | undefined
}

describe('setDefault / clearDefault', () => {
  it('sets_company_and_group_defaults_and_audits', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)

    const company = setDefault({
      db,
      adminUserId: 'admin-2',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
      now: 1000,
    })
    expect(company.scope).toEqual({ kind: 'company', target: '*' })
    expect(defaultRow(db, pkg.packageId, 'company', '*')).toMatchObject({
      set_by: 'admin-2',
      set_at: 1000,
      reset_at: null,
    })

    const group = setDefault({
      db,
      adminUserId: 'admin-2',
      packageId: pkg.packageId,
      scope: { kind: 'group', target: 'eng' },
      now: 1001,
    })
    expect(group.scope).toEqual({ kind: 'group', target: 'eng' })
    expect(defaultRow(db, pkg.packageId, 'group', 'eng')?.set_at).toBe(1001)

    const audits = listPendingAudit(db)
    const setAudits = audits.filter(a => a.event === 'admin-plugin-default-set')
    expect(setAudits).toHaveLength(2)
    expect(setAudits[0]).toMatchObject({ actor: 'admin-2', outcome: 'ok' })
    expect(JSON.parse(setAudits[0]!.detail)).toMatchObject({
      package: CORP,
      scope: { kind: 'company', target: '*' },
    })
  })

  it('clear_removes_row_and_audits', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'group', target: 'sales' },
      now: 10,
    })

    clearDefault({
      db,
      adminUserId: 'admin-3',
      packageId: pkg.packageId,
      scope: { kind: 'group', target: 'sales' },
      now: 20,
    })
    expect(defaultRow(db, pkg.packageId, 'group', 'sales')).toBeUndefined()

    const clearAudit = listPendingAudit(db).find(a => a.event === 'admin-plugin-default-clear')
    expect(clearAudit).toMatchObject({ actor: 'admin-3', outcome: 'ok' })
    expect(JSON.parse(clearAudit!.detail)).toMatchObject({
      package: CORP,
      scope: { kind: 'group', target: 'sales' },
    })
  })

  it('set_upserts_same_scope_without_clearing_reset_at', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
      now: 1,
    })
    db.db.prepare('UPDATE plugin_default SET reset_at = 50 WHERE package_id = ?').run(pkg.packageId)

    setDefault({
      db,
      adminUserId: 'admin-9',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
      now: 99,
    })
    const row = defaultRow(db, pkg.packageId, 'company', '*')!
    expect(row.set_by).toBe('admin-9')
    expect(row.set_at).toBe(99)
    expect(row.reset_at).toBe(50)
  })

  it('refuses_delisted_package_on_set', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    delistPackage({ db, adminUserId: 'admin-1', packageId: pkg.packageId, reason: 'gone', now: 5 })

    expect(() => setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })).toThrow(DefaultError)
    try {
      setDefault({
        db,
        adminUserId: 'admin-1',
        packageId: pkg.packageId,
        scope: { kind: 'company', target: '*' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'delisted', status: 409 })
    }
  })

  it('refuses_missing_package_and_invalid_scope', () => {
    const db = fixture()
    expect(() => setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: 'missing',
      scope: { kind: 'company', target: '*' },
    })).toThrow(DefaultError)

    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    expect(() => setDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: 'nope' as '*' },
    })).toThrow(DefaultError)
  })

  it('clear_missing_default_is_conflict', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    expect(() => clearDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })).toThrow(DefaultError)
    try {
      clearDefault({
        db,
        adminUserId: 'admin-1',
        packageId: pkg.packageId,
        scope: { kind: 'company', target: '*' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'not-default', status: 409 })
    }
  })
})

describe('defaultsVisibleToUser', () => {
  it('filters_by_default_scope_and_omits_delisted', () => {
    const db = fixture()
    const companyPkg = submitReady(db, { name: `${COMPANY_SCOPE_PREFIX}co-def`, version: '1.0.0' })
    approve(db, companyPkg.versionId)
    const engPkg = submitReady(db, { name: `${COMPANY_SCOPE_PREFIX}eng-def`, version: '1.0.0', userId: 'user-b' })
    approve(db, engPkg.versionId, { kind: 'group', target: 'eng' })
    const salesPkg = submitReady(db, { name: `${COMPANY_SCOPE_PREFIX}sales-def`, version: '1.0.0', userId: 'user-c' })
    approve(db, salesPkg.versionId)

    setDefault({
      db, adminUserId: 'admin-1', packageId: companyPkg.packageId,
      scope: { kind: 'company', target: '*' }, now: 1,
    })
    setDefault({
      db, adminUserId: 'admin-1', packageId: engPkg.packageId,
      scope: { kind: 'group', target: 'eng' }, now: 2,
    })
    setDefault({
      db, adminUserId: 'admin-1', packageId: salesPkg.packageId,
      scope: { kind: 'group', target: 'sales' }, now: 3,
    })

    const engVisible = defaultsVisibleToUser(db, 'u-eng', new Set(['eng']))
    expect(engVisible.map(d => d.name).sort()).toEqual([
      `${COMPANY_SCOPE_PREFIX}co-def`,
      `${COMPANY_SCOPE_PREFIX}eng-def`,
    ].sort())

    const salesVisible = defaultsVisibleToUser(db, 'u-sales', new Set(['sales']))
    expect(salesVisible.map(d => d.name).sort()).toEqual([
      `${COMPANY_SCOPE_PREFIX}co-def`,
      `${COMPANY_SCOPE_PREFIX}sales-def`,
    ].sort())

    delistPackage({ db, adminUserId: 'admin-1', packageId: companyPkg.packageId, reason: 'x', now: 9 })
    const afterDelist = defaultsVisibleToUser(db, 'u-eng', new Set(['eng']))
    expect(afterDelist.map(d => d.name)).toEqual([`${COMPANY_SCOPE_PREFIX}eng-def`])
  })

  it('attaches_per_user_state_and_opted_out_flag', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' }, now: 1,
    })
    insertState(db, {
      userId: 'u1', packageId: pkg.packageId, state: 'opted-out', updatedAt: 5,
    })
    insertState(db, {
      userId: 'u2', packageId: pkg.packageId, state: 'installed',
      installedVersion: '1.0.0', updatedAt: 6,
    })

    const forOpted = defaultsVisibleToUser(db, 'u1', new Set())
    expect(forOpted).toHaveLength(1)
    expect(forOpted[0]).toMatchObject({
      packageId: pkg.packageId,
      state: 'opted-out',
      optedOut: true,
    })

    const forInstalled = defaultsVisibleToUser(db, 'u2', new Set())
    expect(forInstalled[0]).toMatchObject({ state: 'installed', optedOut: false })

    const forNew = defaultsVisibleToUser(db, 'u3', new Set())
    expect(forNew[0]).toMatchObject({ state: null, optedOut: false })
  })
})

describe('resetDefault', () => {
  it('sets_reset_at_and_clears_older_opt_outs', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' }, now: 1,
    })
    insertState(db, { userId: 'old', packageId: pkg.packageId, state: 'opted-out', updatedAt: 10 })
    insertState(db, { userId: 'new', packageId: pkg.packageId, state: 'opted-out', updatedAt: 200 })
    insertState(db, {
      userId: 'kept', packageId: pkg.packageId, state: 'installed',
      installedVersion: '1.0.0', updatedAt: 10,
    })

    const result = resetDefault({
      db,
      adminUserId: 'admin-reset',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
      now: 100,
    })
    expect(result.clearedOptOuts).toBe(1)
    expect(defaultRow(db, pkg.packageId, 'company', '*')!.reset_at).toBe(100)

    // older opted-out cleared → pending path
    expect(stateOf(db, 'old', pkg.packageId)?.state).toBe('pending')
    // newer opted-out (updated_at >= reset_at) kept
    expect(stateOf(db, 'new', pkg.packageId)?.state).toBe('opted-out')
    // installed untouched
    expect(stateOf(db, 'kept', pkg.packageId)?.state).toBe('installed')

    const audit = listPendingAudit(db).find(a => a.event === 'admin-plugin-default-reset')
    expect(audit).toMatchObject({ actor: 'admin-reset', outcome: 'ok' })
    expect(JSON.parse(audit!.detail)).toMatchObject({
      package: CORP,
      scope: { kind: 'company', target: '*' },
      clearedOptOuts: 1,
    })
  })

  it('reset_requires_existing_default', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    expect(() => resetDefault({
      db,
      adminUserId: 'admin-1',
      packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })).toThrow(DefaultError)
  })
})

describe('reenableDefault', () => {
  it('restores_opted_out_to_pending_and_audits', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' }, now: 1,
    })
    insertState(db, { userId: 'me', packageId: pkg.packageId, state: 'opted-out', updatedAt: 8 })

    const result = reenableDefault({
      db,
      userId: 'me',
      packageId: pkg.packageId,
      now: 42,
    })
    expect(result).toMatchObject({ packageId: pkg.packageId, state: 'pending' })
    expect(stateOf(db, 'me', pkg.packageId)).toMatchObject({ state: 'pending', updated_at: 42 })

    const audit = listPendingAudit(db).find(a => a.event === 'plugin-default-reenable')
    expect(audit).toMatchObject({ actor: 'me', userId: 'me', outcome: 'ok' })
    expect(JSON.parse(audit!.detail)).toMatchObject({ package: CORP })
  })

  it('refuses_when_not_opted_out', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, {
      userId: 'me', packageId: pkg.packageId, state: 'installed',
      installedVersion: '1.0.0', updatedAt: 1,
    })
    expect(() => reenableDefault({ db, userId: 'me', packageId: pkg.packageId })).toThrow(DefaultError)
    try {
      reenableDefault({ db, userId: 'me', packageId: pkg.packageId })
    } catch (error) {
      expect(error).toMatchObject({ code: 'not-opted-out', status: 409 })
    }
  })
})

describe('listDefaults and applyCountsForPackage', () => {
  it('lists_defaults_for_admin_inventory', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' }, now: 7,
    })
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'group', target: 'eng' }, now: 8,
    })

    const rows = listDefaults(db)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.scope)).toEqual([
      { kind: 'company', target: '*' },
      { kind: 'group', target: 'eng' },
    ])
    expect(rows[0]).toMatchObject({ packageId: pkg.packageId, name: CORP, setBy: 'admin-1', setAt: 7 })
  })

  it('counts_states_per_package_for_admin_apply_counts', () => {
    const db = fixture()
    const pkg = submitReady(db)
    approve(db, pkg.versionId)
    setDefault({
      db, adminUserId: 'admin-1', packageId: pkg.packageId,
      scope: { kind: 'company', target: '*' },
    })
    insertState(db, { userId: 'a', packageId: pkg.packageId, state: 'installed', installedVersion: '1.0.0', updatedAt: 1 })
    insertState(db, { userId: 'b', packageId: pkg.packageId, state: 'installed', installedVersion: '1.0.0', updatedAt: 2 })
    insertState(db, { userId: 'c', packageId: pkg.packageId, state: 'pending', updatedAt: 3 })
    insertState(db, { userId: 'd', packageId: pkg.packageId, state: 'failed', updatedAt: 4 })
    insertState(db, { userId: 'e', packageId: pkg.packageId, state: 'opted-out', updatedAt: 5 })
    insertState(db, { userId: 'f', packageId: pkg.packageId, state: 'user-managed', updatedAt: 6 })

    expect(applyCountsForPackage(db, pkg.packageId)).toEqual({
      installed: 2,
      pending: 1,
      failed: 1,
      optedOut: 1,
      userManaged: 1,
      applied: 2,
    })
  })
})
