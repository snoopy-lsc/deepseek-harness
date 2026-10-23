/** 1B.3: personalized market index from visibility scopes (KB-view style). */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '../src/ids.ts'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { insertPackage, insertVersion } from '../src/migrate.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import {
  buildPersonalizedIndex,
  createMarketBuildIndex,
  type PersonalizedMarketIndex,
} from '../src/index-builder.ts'
import { handleMarketRequest } from '../src/routes.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-index-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const REGISTRY = 'http://127.0.0.1:20210/npm/'
const DISPLAY = JSON.stringify({
  title: { en: 'Demo plugin' },
  description: { en: 'A demo' },
  author: 'corp',
  homepage: 'https://corp.example/demo',
  repository: { url: 'https://git.corp.example/demo' },
  metadata: { category: 'tools', keywords: ['demo'], labels: [], sortKeys: {} },
})

function addListedBundle(
  db: PluginsDb,
  opts: {
    name: string
    version?: string
    scope: { kind: 'company'; target: '*' } | { kind: 'group'; target: string }
    kind?: 'bundle' | 'skill'
    state?: 'approved' | 'revoked' | 'pending'
    mirrorState?: 'ready' | 'queued' | 'failed'
    delisted?: boolean
    generation?: number
    createdAt?: number
    enginesDsh?: string | null
    artifactSha512?: string
    extraApprovedVersions?: readonly string[]
  },
): { packageId: string; versionId: string } {
  const now = opts.createdAt ?? 1_792_000_000
  const packageId = newId('plg')
  const versionId = newId('plv')
  const version = opts.version ?? '1.0.0'
  const kind = opts.kind ?? 'bundle'
  const state = opts.state ?? 'approved'
  const mirrorState = opts.mirrorState ?? 'ready'
  const artifact = opts.artifactSha512 ?? createHash('sha512').update(opts.name + version).digest('hex')

  insertPackage(db, {
    id: packageId,
    name: opts.name,
    kind,
    origin: 'admin',
    ownerUserId: null,
    claimedAt: now,
    display: DISPLAY,
    iconSha512: null,
    createdAt: now,
  })
  if (opts.delisted) {
    db.db.prepare('UPDATE plugin_package SET delisted_at = ?, delist_reason = ? WHERE id = ?').run(
      now + 10,
      'test',
      packageId,
    )
  }

  insertVersion(db, {
    id: versionId,
    packageId,
    version,
    source: JSON.stringify({ type: 'upload' }),
    state,
    mirrorState,
    mirrorError: null,
    artifactSha512: state === 'approved' ? artifact : null,
    upstreamIntegrity: null,
    sizeBytes: 100,
    enginesDsh: opts.enginesDsh ?? '>=0.40.0',
    installScripts: '[]',
    allowedBuilds: '[]',
    requestedBy: 'admin',
    requestNote: '',
    reviewedBy: 'admin',
    reviewedAt: now,
    reviewNote: null,
    createdAt: now,
  })

  for (const extra of opts.extraApprovedVersions ?? []) {
    const vid = newId('plv')
    insertVersion(db, {
      id: vid,
      packageId,
      version: extra,
      source: JSON.stringify({ type: 'upload' }),
      state: 'approved',
      mirrorState: 'ready',
      mirrorError: null,
      artifactSha512: createHash('sha512').update(opts.name + extra).digest('hex'),
      upstreamIntegrity: null,
      sizeBytes: 100,
      enginesDsh: '>=0.40.0',
      installScripts: '[]',
      allowedBuilds: '[]',
      requestedBy: 'admin',
      requestNote: '',
      reviewedBy: 'admin',
      reviewedAt: now + 1,
      reviewNote: null,
      createdAt: now + 1,
    })
  }

  db.db.prepare(
    `INSERT INTO plugin_listing (package_id, current_version_id, previous_version_id, generation, listed_by, listed_at)
     VALUES (?, ?, NULL, ?, 'admin', ?)`,
  ).run(packageId, versionId, opts.generation ?? 1, now)

  db.db.prepare('INSERT INTO plugin_scope (package_id, kind, target) VALUES (?, ?, ?)').run(
    packageId,
    opts.scope.kind,
    opts.scope.target,
  )

  return { packageId, versionId }
}

function assertFormat1Shape(index: PersonalizedMarketIndex): void {
  expect(index.format).toBe(1)
  expect(index.title).toEqual(expect.objectContaining({ en: expect.any(String) }))
  expect(index.metadata).toEqual(
    expect.objectContaining({
      categories: expect.any(Object),
      labels: expect.any(Object),
      sortKeys: expect.any(Object),
    }),
  )
  expect(Array.isArray(index.plugins)).toBe(true)
  for (const plugin of index.plugins) {
    expect(plugin.name).toMatch(/^@/)
    expect(plugin.metadata).toEqual(
      expect.objectContaining({
        keywords: expect.any(Array),
        labels: expect.any(Array),
        sortKeys: expect.any(Object),
      }),
    )
    expect(plugin.versions.length).toBeGreaterThan(0)
    for (const version of plugin.versions) {
      expect(version.publishTimestamp).toBeLessThan(1e11)
      expect(version.source).toEqual({ type: 'npm', registry: REGISTRY })
      expect(version.engines).toEqual(expect.objectContaining({}))
    }
  }
}

describe('buildPersonalizedIndex visibility', () => {
  it('includes_company_scope_for_every_user_and_group_scope_only_for_members', () => {
    const db = fixture()
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}company-wide`,
      scope: { kind: 'company', target: '*' },
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}eng-only`,
      scope: { kind: 'group', target: 'dept:eng' },
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}sales-only`,
      scope: { kind: 'group', target: 'dept:sales' },
    })

    const eng = buildPersonalizedIndex(db, 'user-eng', ['dept:eng'], { registryUrl: REGISTRY })
    assertFormat1Shape(eng.index)
    expect(eng.index.plugins.map(p => p.name).sort()).toEqual([
      `${COMPANY_SCOPE_PREFIX}company-wide`,
      `${COMPANY_SCOPE_PREFIX}eng-only`,
    ])

    const sales = buildPersonalizedIndex(db, 'user-sales', ['dept:sales'], { registryUrl: REGISTRY })
    expect(sales.index.plugins.map(p => p.name).sort()).toEqual([
      `${COMPANY_SCOPE_PREFIX}company-wide`,
      `${COMPANY_SCOPE_PREFIX}sales-only`,
    ])

    const none = buildPersonalizedIndex(db, 'user-none', [], { registryUrl: REGISTRY })
    expect(none.index.plugins.map(p => p.name)).toEqual([`${COMPANY_SCOPE_PREFIX}company-wide`])
  })

  it('omits_delisted_packages_and_skill_kinds_and_revoked_or_unready_versions', () => {
    const db = fixture()
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}listed`,
      scope: { kind: 'company', target: '*' },
      version: '2.0.0',
      extraApprovedVersions: ['1.0.0'],
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}gone`,
      scope: { kind: 'company', target: '*' },
      delisted: true,
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}skill-pack`,
      scope: { kind: 'company', target: '*' },
      kind: 'skill',
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}revoked-only`,
      scope: { kind: 'company', target: '*' },
      state: 'revoked',
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}not-ready`,
      scope: { kind: 'company', target: '*' },
      mirrorState: 'queued',
    })

    // Mark one approved version of listed as revoked — it must leave the index.
    const revokedVid = db.db.prepare(
      `SELECT v.id AS id FROM plugin_version v
       JOIN plugin_package p ON p.id = v.package_id
       WHERE p.name = ? AND v.version = '1.0.0'`,
    ).get(`${COMPANY_SCOPE_PREFIX}listed`) as { id: string }
    db.db.prepare(`UPDATE plugin_version SET state = 'revoked' WHERE id = ?`).run(revokedVid.id)

    const result = buildPersonalizedIndex(db, 'user-a', ['dept:eng'], { registryUrl: REGISTRY })
    expect(result.index.plugins.map(p => p.name)).toEqual([`${COMPANY_SCOPE_PREFIX}listed`])
    expect(result.index.plugins[0]!.versions.map(v => v.version)).toEqual(['2.0.0'])
    expect(result.index.plugins[0]!.versions[0]!.publishTimestamp).toBe(1_792_000_000)
  })

  it('orders_plugins_by_name_and_versions_by_semver_descending', () => {
    const db = fixture()
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}zeta`,
      scope: { kind: 'company', target: '*' },
      version: '1.0.0',
    })
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}alpha`,
      scope: { kind: 'company', target: '*' },
      version: '1.9.0',
      extraApprovedVersions: ['1.10.0', '1.2.0'],
    })

    const { index } = buildPersonalizedIndex(db, 'u', [], { registryUrl: REGISTRY })
    expect(index.plugins.map(p => p.name)).toEqual([
      `${COMPANY_SCOPE_PREFIX}alpha`,
      `${COMPANY_SCOPE_PREFIX}zeta`,
    ])
    expect(index.plugins[0]!.versions.map(v => v.version)).toEqual(['1.10.0', '1.9.0', '1.2.0'])
  })
})

describe('buildPersonalizedIndex cache digest', () => {
  it('returns_stable_digest_and_serves_from_cache_until_generation_or_groups_change', () => {
    const db = fixture()
    const { packageId } = addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}cached`,
      scope: { kind: 'company', target: '*' },
      generation: 1,
    })

    const cache = new Map<string, { fingerprint: string; digest: string; index: PersonalizedMarketIndex }>()
    const first = buildPersonalizedIndex(db, 'user-a', ['dept:eng'], { registryUrl: REGISTRY, cache })
    expect(first.fromCache).toBe(false)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)

    const second = buildPersonalizedIndex(db, 'user-a', ['dept:eng'], { registryUrl: REGISTRY, cache })
    expect(second.fromCache).toBe(true)
    expect(second.digest).toBe(first.digest)
    expect(second.index).toEqual(first.index)

    db.db.prepare('UPDATE plugin_listing SET generation = generation + 1 WHERE package_id = ?').run(packageId)
    const afterGen = buildPersonalizedIndex(db, 'user-a', ['dept:eng'], { registryUrl: REGISTRY, cache })
    expect(afterGen.fromCache).toBe(false)
    // Content digest is of the index body; generation alone may not change plugins, but the
    // fingerprint (cache) must miss so we rebuild.
    expect(afterGen.index).toEqual(first.index)
    expect(afterGen.digest).toBe(first.digest)

    const sameGenAgain = buildPersonalizedIndex(db, 'user-a', ['dept:eng'], { registryUrl: REGISTRY, cache })
    expect(sameGenAgain.fromCache).toBe(true)

    const otherGroups = buildPersonalizedIndex(db, 'user-a', ['dept:sales'], { registryUrl: REGISTRY, cache })
    expect(otherGroups.fromCache).toBe(false)
    // Company-only listing → same plugins, but groups change must still bust the cache
    // fingerprint even when the visible set (and content digest) is identical.
    expect(otherGroups.digest).toBe(afterGen.digest)
    const otherGroupsAgain = buildPersonalizedIndex(db, 'user-a', ['dept:sales'], { registryUrl: REGISTRY, cache })
    expect(otherGroupsAgain.fromCache).toBe(true)
  })

  it('busts_cache_when_user_defaults_change', () => {
    const db = fixture()
    const { packageId } = addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}def`,
      scope: { kind: 'company', target: '*' },
    })
    const cache = new Map()
    const first = buildPersonalizedIndex(db, 'user-a', [], { registryUrl: REGISTRY, cache })
    db.db.prepare(
      `INSERT INTO plugin_default_state (user_id, package_id, state, installed_version, target_version, last_error, updated_at)
       VALUES ('user-a', ?, 'installed', '1.0.0', '1.0.0', NULL, 100)`,
    ).run(packageId)
    const second = buildPersonalizedIndex(db, 'user-a', [], { registryUrl: REGISTRY, cache })
    expect(second.fromCache).toBe(false)
    expect(second.digest).toBe(first.digest) // defaults do not alter index body yet
  })
})

describe('createMarketBuildIndex wires routes', () => {
  it('GET_index_json_uses_builder_not_empty_stub', async () => {
    const db = fixture()
    addListedBundle(db, {
      name: `${COMPANY_SCOPE_PREFIX}via-http`,
      scope: { kind: 'group', target: 'dept:eng' },
    })
    const buildIndex = createMarketBuildIndex(db, {
      registryUrl: REGISTRY,
      groupsFor: (userId) => (userId === 'user-http' ? ['dept:eng'] : []),
    })

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleMarketRequest(req, res, {
        lookup: () => ({ userId: 'user-http', accountUid: 2100, tokenSha256: null }),
        buildIndex,
        lookupPackument: () => undefined,
        lookupTarball: () => undefined,
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/index.json`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as PersonalizedMarketIndex
      expect(body.format).toBe(1)
      expect(body.plugins.map(p => p.name)).toEqual([`${COMPANY_SCOPE_PREFIX}via-http`])
      expect(body.plugins[0]!.versions[0]!.source).toEqual({ type: 'npm', registry: REGISTRY })
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
