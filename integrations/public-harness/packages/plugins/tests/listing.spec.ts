/** 1C.3: listing scope / delist / relist / rollback / revoke (design § Listing pointer rules). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { listPendingAudit } from '../src/audit.ts'
import { submitPluginVersion } from '../src/submit.ts'
import { approveSubmission } from '../src/approve.ts'
import { buildPersonalizedIndex } from '../src/index-builder.ts'
import {
  ListingError,
  changeScope,
  delistPackage,
  relistPackage,
  rollbackListing,
  revokeVersion,
} from '../src/listing.ts'
import {
  packageArtifactsVisible,
  packageVisibleInIndex,
  scopesVisibleToUser,
} from '../src/visibility.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-listing-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const CORP = `${COMPANY_SCOPE_PREFIX}listing-demo`
const SHA_A = 'a'.repeat(128)
const SHA_B = 'b'.repeat(128)
const SHA_C = 'c'.repeat(128)
const REGISTRY = 'http://127.0.0.1:20210/npm/'

function npmSource(name: string, version: string) {
  return { type: 'npm' as const, registry: 'https://registry.npmjs.org', name, version }
}

function submitReady(
  db: PluginsDb,
  opts: {
    userId?: string
    name?: string
    version: string
    artifactSha512?: string
  },
): { packageId: string; versionId: string } {
  const name = opts.name ?? CORP
  const userId = opts.userId ?? 'user-a'
  const result = submitPluginVersion({
    db,
    userId,
    name,
    version: opts.version,
    source: npmSource(name, opts.version),
  })
  const sha = opts.artifactSha512 ?? SHA_A
  db.db.prepare(
    `UPDATE plugin_version SET mirror_state = 'ready', artifact_sha512 = ?, install_scripts = '[]'
     WHERE id = ?`,
  ).run(sha, result.versionId)
  return result
}

function approve(
  db: PluginsDb,
  versionId: string,
  scope: { kind: 'company'; target: '*' } | { kind: 'group'; target: string } = { kind: 'company', target: '*' },
  sha = SHA_A,
): void {
  approveSubmission({
    db,
    adminUserId: 'admin-1',
    versionId,
    expectedArtifactSha512: sha,
    scope,
  })
}

function listingOf(db: PluginsDb, packageId: string) {
  return db.db.prepare(
    'SELECT current_version_id, previous_version_id, generation FROM plugin_listing WHERE package_id = ?',
  ).get(packageId) as {
    current_version_id: string
    previous_version_id: string | null
    generation: number
  } | undefined
}

function scopesOf(db: PluginsDb, packageId: string) {
  return db.db.prepare(
    'SELECT kind, target FROM plugin_scope WHERE package_id = ? ORDER BY kind, target',
  ).all(packageId) as Array<{ kind: string; target: string }>
}

function packageOf(db: PluginsDb, packageId: string) {
  return db.db.prepare(
    'SELECT delisted_at, delist_reason FROM plugin_package WHERE id = ?',
  ).get(packageId) as { delisted_at: number | null; delist_reason: string | null }
}

function historyActions(db: PluginsDb, packageId: string) {
  return (db.db.prepare(
    'SELECT action FROM plugin_listing_history WHERE package_id = ? ORDER BY id',
  ).all(packageId) as Array<{ action: string }>).map(r => r.action)
}

describe('visibility helpers', () => {
  it('company_scope_visible_to_any_groups', () => {
    expect(scopesVisibleToUser([{ kind: 'company', target: '*' }], new Set())).toBe(true)
    expect(scopesVisibleToUser([{ kind: 'company', target: '*' }], new Set(['eng']))).toBe(true)
  })

  it('group_scope_requires_membership', () => {
    const scopes = [{ kind: 'group', target: 'eng' }]
    expect(scopesVisibleToUser(scopes, new Set(['eng']))).toBe(true)
    expect(scopesVisibleToUser(scopes, new Set(['sales']))).toBe(false)
  })

  it('index_omits_delisted_but_artifacts_still_served_to_scope', () => {
    const scopes = [{ kind: 'group', target: 'eng' }]
    const groups = new Set(['eng'])
    expect(packageVisibleInIndex({ scopes, groups, delistedAt: null })).toBe(true)
    expect(packageVisibleInIndex({ scopes, groups, delistedAt: 1 })).toBe(false)
    expect(packageArtifactsVisible({ scopes, groups })).toBe(true)
    expect(packageArtifactsVisible({ scopes, groups: new Set(['sales']) })).toBe(false)
  })
})

describe('changeScope', () => {
  it('rewrites_scope_rows_bumps_generation_and_audits', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId, { kind: 'company', target: '*' })
    const before = listingOf(db, first.packageId)!

    const result = changeScope({
      db,
      adminUserId: 'admin-2',
      packageId: first.packageId,
      scopes: [{ kind: 'group', target: 'eng' }],
      now: 99,
    })
    expect(result.oldScopes).toEqual([{ kind: 'company', target: '*' }])
    expect(result.newScopes).toEqual([{ kind: 'group', target: 'eng' }])

    expect(scopesOf(db, first.packageId)).toEqual([{ kind: 'group', target: 'eng' }])
    expect(listingOf(db, first.packageId)!.generation).toBe(before.generation + 1)
    expect(historyActions(db, first.packageId)).toContain('scope')

    const audits = listPendingAudit(db)
    const scopeAudit = audits.find(a => a.event === 'admin-plugin-scope-change')
    expect(scopeAudit).toMatchObject({ actor: 'admin-2', outcome: 'ok' })
    expect(JSON.parse(scopeAudit!.detail)).toMatchObject({
      package: CORP,
      oldScope: [{ kind: 'company', target: '*' }],
      newScope: [{ kind: 'group', target: 'eng' }],
    })
  })

  it('scope_change_hides_package_from_index_and_artifacts_for_lost_groups', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId, { kind: 'group', target: 'eng' })

    changeScope({
      db,
      adminUserId: 'admin-1',
      packageId: first.packageId,
      scopes: [{ kind: 'group', target: 'sales' }],
    })

    const engIndex = buildPersonalizedIndex(db, 'u-eng', ['eng'], { registryUrl: REGISTRY })
    const salesIndex = buildPersonalizedIndex(db, 'u-sales', ['sales'], { registryUrl: REGISTRY })
    expect(engIndex.index.plugins.map(p => p.name)).not.toContain(CORP)
    expect(salesIndex.index.plugins.map(p => p.name)).toContain(CORP)

    expect(packageArtifactsVisible({
      scopes: scopesOf(db, first.packageId),
      groups: new Set(['eng']),
    })).toBe(false)
    expect(packageArtifactsVisible({
      scopes: scopesOf(db, first.packageId),
      groups: new Set(['sales']),
    })).toBe(true)
  })

  it('refuses_empty_scopes_and_missing_package', () => {
    const db = fixture()
    expect(() => changeScope({
      db, adminUserId: 'admin-1', packageId: 'missing', scopes: [{ kind: 'company', target: '*' }],
    })).toThrow(ListingError)
    try {
      changeScope({
        db, adminUserId: 'admin-1', packageId: 'missing', scopes: [{ kind: 'company', target: '*' }],
      })
    } catch (error) {
      expect((error as ListingError).code).toBe('not-found')
      expect((error as ListingError).status).toBe(404)
    }

    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId)
    expect(() => changeScope({
      db, adminUserId: 'admin-1', packageId: first.packageId, scopes: [],
    })).toThrow(/invalid-scope/)
  })
})

describe('delist and relist', () => {
  it('delist_keeps_scopes_hides_from_index_artifacts_still_visible_to_scope', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId, { kind: 'group', target: 'eng' })
    const beforeGen = listingOf(db, first.packageId)!.generation

    delistPackage({
      db, adminUserId: 'admin-1', packageId: first.packageId, reason: 'retired', now: 50,
    })

    const pkg = packageOf(db, first.packageId)
    expect(pkg.delisted_at).toBe(50)
    expect(pkg.delist_reason).toBe('retired')
    expect(scopesOf(db, first.packageId)).toEqual([{ kind: 'group', target: 'eng' }])
    expect(listingOf(db, first.packageId)!.generation).toBe(beforeGen + 1)
    expect(historyActions(db, first.packageId)).toContain('delist')

    const index = buildPersonalizedIndex(db, 'u-eng', ['eng'], { registryUrl: REGISTRY })
    expect(index.index.plugins.map(p => p.name)).not.toContain(CORP)

    expect(packageVisibleInIndex({
      scopes: scopesOf(db, first.packageId),
      groups: new Set(['eng']),
      delistedAt: pkg.delisted_at,
    })).toBe(false)
    expect(packageArtifactsVisible({
      scopes: scopesOf(db, first.packageId),
      groups: new Set(['eng']),
    })).toBe(true)

    const audits = listPendingAudit(db)
    expect(audits.some(a => a.event === 'admin-plugin-delist')).toBe(true)
  })

  it('relist_clears_delisted_at_and_restores_index', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId, { kind: 'company', target: '*' })
    delistPackage({ db, adminUserId: 'admin-1', packageId: first.packageId, reason: 'temp' })

    relistPackage({ db, adminUserId: 'admin-2', packageId: first.packageId, now: 77 })
    const pkg = packageOf(db, first.packageId)
    expect(pkg.delisted_at).toBeNull()
    expect(pkg.delist_reason).toBeNull()
    expect(historyActions(db, first.packageId)).toContain('relist')

    const index = buildPersonalizedIndex(db, 'u', [], { registryUrl: REGISTRY })
    expect(index.index.plugins.map(p => p.name)).toContain(CORP)

    const audits = listPendingAudit(db)
    expect(audits.some(a => a.event === 'admin-plugin-relist' && a.actor === 'admin-2')).toBe(true)
  })

  it('refuses_double_delist_and_relist_when_not_delisted', () => {
    const db = fixture()
    const first = submitReady(db, { version: '1.0.0' })
    approve(db, first.versionId)
    expect(() => relistPackage({
      db, adminUserId: 'admin-1', packageId: first.packageId,
    })).toThrow(/not-delisted/)

    delistPackage({ db, adminUserId: 'admin-1', packageId: first.packageId, reason: 'x' })
    expect(() => delistPackage({
      db, adminUserId: 'admin-1', packageId: first.packageId, reason: 'y',
    })).toThrow(/already-delisted/)
  })
})

describe('rollbackListing', () => {
  it('moves_previous_to_current_and_computes_new_previous', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    approve(db, v1.versionId, { kind: 'company', target: '*' }, SHA_A)
    const v15 = submitReady(db, { version: '1.5.0', artifactSha512: SHA_C })
    approve(db, v15.versionId, { kind: 'company', target: '*' }, SHA_C)
    const v2 = submitReady(db, { version: '2.0.0', artifactSha512: SHA_B })
    approve(db, v2.versionId, { kind: 'company', target: '*' }, SHA_B)

    // current=2.0.0, previous=1.0.0 (approve of 1.5 was history-only so previous stayed 1.0.0)
    // Wait — after 1.0 listed, 1.5 is history-only (lower? No 1.5 > 1.0 so it becomes current, previous=1.0)
    // then 2.0 becomes current, previous=1.5
    let listing = listingOf(db, v1.packageId)!
    expect(listing.current_version_id).toBe(v2.versionId)
    expect(listing.previous_version_id).toBe(v15.versionId)

    const result = rollbackListing({
      db, adminUserId: 'admin-1', packageId: v1.packageId, now: 10,
    })
    expect(result.fromVersionId).toBe(v2.versionId)
    expect(result.toVersionId).toBe(v15.versionId)
    expect(result.previousVersionId).toBe(v1.versionId)

    listing = listingOf(db, v1.packageId)!
    expect(listing.current_version_id).toBe(v15.versionId)
    expect(listing.previous_version_id).toBe(v1.versionId)
    expect(historyActions(db, v1.packageId)).toContain('rollback')

    const audits = listPendingAudit(db)
    const rb = audits.find(a => a.event === 'admin-plugin-rollback')
    expect(rb).toBeDefined()
    expect(JSON.parse(rb!.detail)).toMatchObject({
      package: CORP,
      fromVersion: '2.0.0',
      toVersion: '1.5.0',
    })
  })

  it('refuses_with_no_previous', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0' })
    approve(db, v1.versionId)
    expect(() => rollbackListing({
      db, adminUserId: 'admin-1', packageId: v1.packageId,
    })).toThrow(/no-previous/)
    try {
      rollbackListing({ db, adminUserId: 'admin-1', packageId: v1.packageId })
    } catch (error) {
      expect((error as ListingError).code).toBe('no-previous')
      expect((error as ListingError).status).toBe(409)
    }
  })
})

describe('revokeVersion', () => {
  it('non_current_revoke_removes_from_index_keeps_listing_pointers', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    approve(db, v1.versionId, { kind: 'company', target: '*' }, SHA_A)
    const v2 = submitReady(db, { version: '2.0.0', artifactSha512: SHA_B })
    approve(db, v2.versionId, { kind: 'company', target: '*' }, SHA_B)
    // also approve a history-only lower? use 1.5 as history under 2.0 by approving after?
    // Actually approve 1.5 after 2.0 → history only
    const v15 = submitReady(db, { version: '1.5.0', artifactSha512: SHA_C })
    approve(db, v15.versionId, { kind: 'company', target: '*' }, SHA_C)

    const before = listingOf(db, v1.packageId)!
    expect(before.current_version_id).toBe(v2.versionId)

    const result = revokeVersion({
      db, adminUserId: 'admin-1', versionId: v15.versionId, reason: 'bad patch', now: 11,
    })
    expect(result.rolledBack).toBe(false)
    expect(result.delisted).toBe(false)

    const ver = db.db.prepare('SELECT state FROM plugin_version WHERE id = ?').get(v15.versionId) as { state: string }
    expect(ver.state).toBe('revoked')

    const after = listingOf(db, v1.packageId)!
    expect(after.current_version_id).toBe(v2.versionId)
    expect(after.previous_version_id).toBe(v1.versionId)

    const index = buildPersonalizedIndex(db, 'u', [], { registryUrl: REGISTRY })
    const plugin = index.index.plugins.find(p => p.name === CORP)
    expect(plugin).toBeDefined()
    expect(plugin!.versions.map(v => v.version).sort()).toEqual(['1.0.0', '2.0.0'])

    expect(historyActions(db, v1.packageId)).toContain('revoke')
    const audits = listPendingAudit(db)
    expect(audits.some(a => a.event === 'admin-plugin-revoke')).toBe(true)
  })

  it('current_revoke_with_previous_rolls_back', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    approve(db, v1.versionId, { kind: 'company', target: '*' }, SHA_A)
    const v2 = submitReady(db, { version: '2.0.0', artifactSha512: SHA_B })
    approve(db, v2.versionId, { kind: 'company', target: '*' }, SHA_B)

    const result = revokeVersion({
      db, adminUserId: 'admin-1', versionId: v2.versionId, reason: 'critical',
    })
    expect(result.rolledBack).toBe(true)
    expect(result.delisted).toBe(false)
    expect(result.toVersionId).toBe(v1.versionId)

    const ver = db.db.prepare('SELECT state FROM plugin_version WHERE id = ?').get(v2.versionId) as { state: string }
    expect(ver.state).toBe('revoked')

    const listing = listingOf(db, v1.packageId)!
    expect(listing.current_version_id).toBe(v1.versionId)
    // new previous: highest approved unrevoked below 1.0.0 → none
    expect(listing.previous_version_id).toBeNull()

    const index = buildPersonalizedIndex(db, 'u', [], { registryUrl: REGISTRY })
    const plugin = index.index.plugins.find(p => p.name === CORP)!
    expect(plugin.versions.map(v => v.version)).toEqual(['1.0.0'])
  })

  it('current_revoke_without_previous_delists_with_reason_revoked', () => {
    const db = fixture()
    const v1 = submitReady(db, { version: '1.0.0', artifactSha512: SHA_A })
    approve(db, v1.versionId, { kind: 'company', target: '*' }, SHA_A)

    const result = revokeVersion({
      db, adminUserId: 'admin-1', versionId: v1.versionId, reason: 'gone', now: 33,
    })
    expect(result.rolledBack).toBe(false)
    expect(result.delisted).toBe(true)

    const ver = db.db.prepare('SELECT state FROM plugin_version WHERE id = ?').get(v1.versionId) as { state: string }
    expect(ver.state).toBe('revoked')

    const pkg = packageOf(db, v1.packageId)
    expect(pkg.delisted_at).toBe(33)
    expect(pkg.delist_reason).toBe('revoked')
    // scopes kept
    expect(scopesOf(db, v1.packageId)).toEqual([{ kind: 'company', target: '*' }])

    const index = buildPersonalizedIndex(db, 'u', [], { registryUrl: REGISTRY })
    expect(index.index.plugins.map(p => p.name)).not.toContain(CORP)
  })

  it('refuses_when_not_approved', () => {
    const db = fixture()
    const pending = submitReady(db, { version: '9.0.0' })
    expect(() => revokeVersion({
      db, adminUserId: 'admin-1', versionId: pending.versionId,
    })).toThrow(/not-approved/)
    try {
      revokeVersion({ db, adminUserId: 'admin-1', versionId: pending.versionId })
    } catch (error) {
      expect((error as ListingError).code).toBe('not-approved')
      expect((error as ListingError).status).toBe(409)
    }
  })
})
