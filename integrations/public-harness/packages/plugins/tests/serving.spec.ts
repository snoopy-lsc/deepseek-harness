/** 1B.1: per-user market ports, bearer tokens, loopback HTTP routes. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { MAX_PLUGIN_ACCOUNTS } from '../src/schema.ts'
import {
  closeEndpoint,
  openEndpoint,
  startMarketHttpServer,
  validateMarketPorts,
  type MarketHttpServer,
} from '../src/listen.ts'
import { bearerMatches, hashMarketToken, mintMarketToken } from '../src/token.ts'

const roots: string[] = []
const opened: PluginsDb[] = []
const servers: MarketHttpServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureDb(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-serving-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const tinyPorts = { min: 31_000, max: 31_003 }

async function get(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string; contentType: string | null }> {
  const response = await fetch(url, { headers })
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
  }
}

describe('validateMarketPorts', () => {
  it('accepts_range_within_cap_and_ephemeral_band', () => {
    expect(validateMarketPorts({ min: 20_000, max: 20_099 })).toEqual({ min: 20_000, max: 20_099 })
    expect(MAX_PLUGIN_ACCOUNTS).toBe(4096)
  })

  it('refuses_more_than_4096_ports_or_out_of_band', () => {
    expect(() => validateMarketPorts({ min: 10_000, max: 10_000 + 4096 })).toThrow(/4096/)
    expect(() => validateMarketPorts({ min: 1000, max: 1100 })).toThrow(/1024/)
    expect(() => validateMarketPorts({ min: 30_000, max: 40_000 })).toThrow(/32767/)
  })
})

describe('openEndpoint port allocation', () => {
  it('assigns_stable_unique_port_per_user_and_rotates_token', () => {
    const db = fixtureDb()
    const first = openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-a1',
      accountUid: 2001,
      ports: tinyPorts,
    })
    expect(first.port).toBeGreaterThanOrEqual(tinyPorts.min)
    expect(first.port).toBeLessThanOrEqual(tinyPorts.max)
    expect(first.token.length).toBeGreaterThanOrEqual(32)

    const again = openEndpoint(db, {
      userId: 'user-a',
      instanceId: 'inst-a2',
      accountUid: 2001,
      ports: tinyPorts,
    })
    expect(again.port).toBe(first.port)
    expect(again.token).not.toBe(first.token)

    const other = openEndpoint(db, {
      userId: 'user-b',
      instanceId: 'inst-b1',
      accountUid: 2002,
      ports: tinyPorts,
    })
    expect(other.port).not.toBe(first.port)

    const row = db.db.prepare('SELECT port, token_sha256, instance_id FROM plugin_endpoint WHERE user_id = ?').get('user-a') as {
      port: number
      token_sha256: string
      instance_id: string
    }
    expect(row.port).toBe(first.port)
    expect(row.instance_id).toBe('inst-a2')
    expect(row.token_sha256).toBe(hashMarketToken(again.token))
    expect(row.token_sha256).not.toBe(again.token)
  })

  it('refuses_when_range_is_exhausted', () => {
    const db = fixtureDb()
    const ports = { min: 31_010, max: 31_011 }
    openEndpoint(db, { userId: 'u1', instanceId: 'i1', accountUid: 1, ports })
    openEndpoint(db, { userId: 'u2', instanceId: 'i2', accountUid: 2, ports })
    expect(() => openEndpoint(db, { userId: 'u3', instanceId: 'i3', accountUid: 3, ports })).toThrow(/no free|exhaust|full/i)
  })

  it('closeEndpoint_clears_token_keeps_port', () => {
    const db = fixtureDb()
    const openedRow = openEndpoint(db, {
      userId: 'user-c',
      instanceId: 'inst-c1',
      accountUid: 2003,
      ports: tinyPorts,
    })
    closeEndpoint(db, 'inst-c1')
    const row = db.db.prepare('SELECT port, token_sha256, instance_id FROM plugin_endpoint WHERE user_id = ?').get('user-c') as {
      port: number
      token_sha256: string | null
      instance_id: string | null
    }
    expect(row.port).toBe(openedRow.port)
    expect(row.token_sha256).toBeNull()
    expect(row.instance_id).toBeNull()
  })
})

describe('bearer token', () => {
  it('mint_and_compare_constant_time', () => {
    const { token, tokenSha256 } = mintMarketToken()
    expect(tokenSha256).toBe(createHash('sha256').update(token, 'utf8').digest('hex'))
    expect(bearerMatches(`Bearer ${token}`, tokenSha256)).toBe(true)
    expect(bearerMatches(`Bearer ${token}x`, tokenSha256)).toBe(false)
    expect(bearerMatches('Bearer deadbeef', tokenSha256)).toBe(false)
    expect(bearerMatches(undefined, tokenSha256)).toBe(false)
    expect(bearerMatches(`Bearer ${token}`, null)).toBe(false)
    expect(bearerMatches(`Bearer ${token}`, undefined)).toBe(false)
  })
})

describe('market HTTP server', () => {
  it('refuses_non_loopback_host', async () => {
    await expect(startMarketHttpServer({
      host: '0.0.0.0',
      port: 0,
      lookup: () => undefined,
      buildIndex: () => ({ format: 1, plugins: [] }),
      lookupPackument: () => undefined,
      lookupTarball: () => undefined,
    })).rejects.toThrow(/127\.0\.0\.1|loopback/i)
  })

  it('serves_index_and_npm_shapes_with_bearer_gate', async () => {
    const db = fixtureDb()
    const minted = mintMarketToken()
    const indexBody = {
      format: 1,
      plugins: [{ name: '@corp-dsh/demo', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' }, engines: {} }] }],
    }
    const packument = { name: '@corp-dsh/demo', versions: { '1.0.0': { name: '@corp-dsh/demo', version: '1.0.0', dist: { tarball: 'ignored' } } } }
    const tarball = Buffer.from('tarball-bytes')

    const server = await startMarketHttpServer({
      host: '127.0.0.1',
      port: 0,
      lookup: () => ({
        userId: 'user-http',
        accountUid: 2100,
        tokenSha256: minted.tokenSha256,
      }),
      buildIndex: () => indexBody,
      lookupPackument: (name) => (name === '@corp-dsh/demo' ? packument : undefined),
      lookupTarball: (name, version) => (name === '@corp-dsh/demo' && version === '1.0.0' ? tarball : undefined),
    })
    servers.push(server)
    expect(server.address).toBe('127.0.0.1')
    expect(server.port).toBeGreaterThan(0)

    const base = `http://127.0.0.1:${server.port}`
    const index = await get(`${base}/index.json`)
    expect(index.status).toBe(200)
    expect(index.contentType).toMatch(/application\/json/)
    expect(JSON.parse(index.body)).toEqual(indexBody)

    const missingAuth = await get(`${base}/npm/@corp-dsh%2Fdemo`)
    expect(missingAuth.status).toBe(404)
    expect(missingAuth.body).toBe(await get(`${base}/npm/@corp-dsh%2Fmissing`, { authorization: `Bearer ${minted.token}` }).then(r => r.body))

    const wrongAuth = await get(`${base}/npm/@corp-dsh%2Fdemo`, { authorization: 'Bearer wrong-token-value-here!!!!' })
    expect(wrongAuth.status).toBe(404)

    const pack = await get(`${base}/npm/@corp-dsh%2Fdemo`, { authorization: `Bearer ${minted.token}` })
    expect(pack.status).toBe(200)
    expect(JSON.parse(pack.body).name).toBe('@corp-dsh/demo')

    const slash = await get(`${base}/npm/@corp-dsh/demo`, { authorization: `Bearer ${minted.token}` })
    expect(slash.status).toBe(200)

    const tg = await get(`${base}/npm/@corp-dsh%2Fdemo/-/demo-1.0.0.tgz`, { authorization: `Bearer ${minted.token}` })
    expect(tg.status).toBe(200)
    expect(tg.body).toBe('tarball-bytes')

    const unknown = await get(`${base}/nope`)
    expect(unknown.status).toBe(404)

    // silence unused db (endpoint table exercised above)
    expect(db).toBeTruthy()
  })
})
