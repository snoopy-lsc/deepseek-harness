import { describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/client/admin-api.ts'
import { pluginAdminCopy } from '../src/client/admin-plugins-text.ts'
import { createPluginsApi } from '../src/client/plugins-api.ts'
import { pluginsCopy } from '../src/client/plugins-copy.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function recorder(body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status: 200 }) }) as unknown as typeof fetch
  return { calls, api: createAdminApi(fetcher), me: createPluginsApi(fetcher) }
}

describe('System Admin plugin market client', () => {
  it('uses_the_admin_plugin_paths_and_carries_the_reauth_proof', async () => {
    const r = recorder({ requests: [], plugins: [], policy: {}, limits: {}, global: {} })
    await r.api.pluginRequests('pending')
    await r.api.pluginRequestDetail('plv_a')
    await r.api.pluginRequestFile('plv_a', 'package.json')
    await r.api.approvePlugin('plv_a', { kind: 'company', target: '*' }, 'sha512-abc', ['@company/helper'], { password: 'pw' })
    await r.api.rejectPlugin('plv_a', 'needs review')
    await r.api.uploadPlugin({ name: '@company/tool', version: '1.0.0', source: { type: 'npm', registry: 'https://npm.example', name: '@company/tool', version: '1.0.0' }, scope: { kind: 'group', target: 'local:ops' } }, { password: 'pw' })
    await r.api.setPluginScope('plg_a', [{ kind: 'company', target: '*' }], { password: 'pw' })
    await r.api.rollbackPlugin('plg_a', { password: 'pw' })
    await r.api.delistPlugin('plg_a', 'retired', { password: 'pw' })
    await r.api.relistPlugin('plg_a', { password: 'pw' })
    await r.api.revokePlugin('plv_b', 'vulnerable', { password: 'pw' })
    await r.api.setPluginDefaults({ packageId: 'plg_a', scope: { kind: 'company', target: '*' }, enabled: true }, { password: 'pw' })
    await r.api.resetPluginDefaults({ packageId: 'plg_a', scope: { kind: 'company', target: '*' } }, { password: 'pw' })
    await r.api.pluginPolicy()
    await r.api.setPluginPolicy({ market_only: true, install_scripts: false, egress_lock: true }, { password: 'pw' })
    await r.api.pluginLimits()
    await r.api.setPluginLimit({ type: 'global', id: '*' }, 'max_submissions', 10, { password: 'pw' })
    await r.api.deletePluginLimit({ type: 'user', id: 'u1' }, 'max_submission_bytes', { password: 'pw' })
    await r.api.pluginEffective('u1')
    await r.api.pluginInventory()
    await r.api.restorePlugin('u1', 'snap_a', { password: 'pw' })
    expect(r.calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/admin/plugins/requests?state=pending',
      'GET /api/admin/plugins/requests/detail?id=plv_a',
      'GET /api/admin/plugins/requests/file?id=plv_a&path=package.json',
      'POST /api/admin/plugins/requests/approve',
      'POST /api/admin/plugins/requests/reject',
      'POST /api/admin/plugins/upload',
      'POST /api/admin/plugins/scope',
      'POST /api/admin/plugins/rollback',
      'POST /api/admin/plugins/delist',
      'POST /api/admin/plugins/relist',
      'POST /api/admin/plugins/revoke',
      'POST /api/admin/plugins/defaults',
      'POST /api/admin/plugins/defaults/reset',
      'GET /api/admin/plugins/policy',
      'PUT /api/admin/plugins/policy',
      'GET /api/admin/plugins/limits',
      'PUT /api/admin/plugins/limits',
      'DELETE /api/admin/plugins/limits',
      'GET /api/admin/plugins/limits/effective?user=u1',
      'GET /api/admin/plugins',
      'POST /api/admin/plugins/restore',
    ])
    expect(JSON.parse(String(r.calls[3]!.init.body))).toEqual({
      id: 'plv_a', scope: { kind: 'company', target: '*' }, expectedArtifactSha512: 'sha512-abc', allowedBuilds: ['@company/helper'], password: 'pw',
    })
    expect(JSON.parse(String(r.calls[4]!.init.body))).toEqual({ id: 'plv_a', reason: 'needs review' })
    expect(JSON.parse(String(r.calls[5]!.init.body))).toMatchObject({ name: '@company/tool', password: 'pw' })
    expect(JSON.parse(String(r.calls[6]!.init.body))).toEqual({ packageId: 'plg_a', scopes: [{ kind: 'company', target: '*' }], password: 'pw' })
    expect(JSON.parse(String(r.calls[7]!.init.body))).toEqual({ packageId: 'plg_a', password: 'pw' })
    expect(JSON.parse(String(r.calls[8]!.init.body))).toEqual({ packageId: 'plg_a', reason: 'retired', password: 'pw' })
    expect(JSON.parse(String(r.calls[10]!.init.body))).toEqual({ versionId: 'plv_b', reason: 'vulnerable', password: 'pw' })
    expect(JSON.parse(String(r.calls[14]!.init.body))).toEqual({ market_only: true, install_scripts: false, egress_lock: true, password: 'pw' })
    expect(JSON.parse(String(r.calls[16]!.init.body))).toEqual({ scope: { type: 'global', id: '*' }, name: 'max_submissions', value: 10, password: 'pw' })
    expect(JSON.parse(String(r.calls[20]!.init.body))).toEqual({ userId: 'u1', snapshotId: 'snap_a', password: 'pw' })
  })

  it('has_paired_admin_copy_and_a_plugin_market_section', () => {
    expect(Object.keys(pluginAdminCopy.zh).sort()).toEqual(Object.keys(pluginAdminCopy.en).sort())
    expect(Object.values(pluginAdminCopy.zh).every(v => v.length > 0)).toBe(true)
    expect(pluginAdminCopy.en.plugins).toBe('Plugin market')
    const adminSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/admin.tsx'), 'utf8')
    expect(adminSrc).toMatch(/ADMIN_SECTIONS = \[[^\]]*['"]plugins['"]/)
    expect(adminSrc).toContain('PluginMarket')
    expect(adminSrc.indexOf("'plugins'")).toBeGreaterThan(adminSrc.indexOf("'kb'"))
  })
})

describe('Personal My plugins client', () => {
  it('uses_the_me_plugin_paths', async () => {
    const r = recorder({ submissions: [], defaults: [], snapshots: [] })
    await r.me.overview()
    await r.me.submit({ name: '@company/tool', version: '1.0.0', source: { type: 'npm', registry: 'https://npm.example', name: '@company/tool', version: '1.0.0' }, note: 'please' })
    await r.me.withdraw('plv_a')
    await r.me.delistRequest('plg_a')
    await r.me.reenableDefault('plg_a')
    await r.me.snapshots()
    await r.me.restore('snap_a')
    expect(r.calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /account/api/me/plugins',
      'POST /account/api/me/plugins/submit',
      'POST /account/api/me/plugins/withdraw',
      'POST /account/api/me/plugins/delist-request',
      'POST /account/api/me/plugins/defaults/reenable',
      'GET /account/api/me/plugins/snapshots',
      'POST /account/api/me/plugins/restore',
    ])
    expect(JSON.parse(String(r.calls[1]!.init.body))).toEqual({
      name: '@company/tool', version: '1.0.0', source: { type: 'npm', registry: 'https://npm.example', name: '@company/tool', version: '1.0.0' }, note: 'please',
    })
    expect(JSON.parse(String(r.calls[2]!.init.body))).toEqual({ versionId: 'plv_a' })
    expect(JSON.parse(String(r.calls[3]!.init.body))).toEqual({ packageId: 'plg_a' })
  })

  it('has_paired_personal_copy', () => {
    expect(Object.keys(pluginsCopy.zh).sort()).toEqual(Object.keys(pluginsCopy.en).sort())
    expect(Object.values(pluginsCopy.zh).every(v => v.length > 0)).toBe(true)
    expect(pluginsCopy.en.plg_title).toBeTruthy()
    const personalSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/personal.tsx'), 'utf8')
    expect(personalSrc).toContain('MyPlugins')
    expect(personalSrc).toContain('plg_title')
  })
})
