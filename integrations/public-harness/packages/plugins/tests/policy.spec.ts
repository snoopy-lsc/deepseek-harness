/** Task 1E.2: market_only / install_scripts policies (egress_lock schema/name only). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginMarketRows } from '../../contracts/src/web-rows.ts'
import { renderInstanceMarketNpmrc } from '../../provisioner/src/market-files.ts'
import { listPendingAudit } from '../src/audit.ts'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import {
  PluginPolicyError,
  assertRegistryUnderMarketOnly,
  effectivePolicy,
  getGlobalPluginPolicy,
  handlePluginPolicyAdmin,
  instanceMarketOptionsFromPolicy,
  listPluginPolicyRows,
  setPluginPolicy,
  setPluginPolicyRow,
  type PluginPolicyRow,
} from '../src/policy.ts'

const roots: string[] = []
const opened: PluginsDb[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): PluginsDb {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppol-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  return db
}

const row = (
  name: PluginPolicyRow['name'],
  scopeType: PluginPolicyRow['scopeType'],
  scopeId: string,
  value: boolean,
): PluginPolicyRow => ({ name, scopeType, scopeId, value, updatedBy: 't', updatedAt: 0 })

describe('effectivePolicy resolution', () => {
  it('defaults_install_scripts_deny_and_market_only_off', () => {
    expect(effectivePolicy([], 'u1', [])).toEqual({
      market_only: false,
      install_scripts: false,
      egress_lock: false,
    })
    expect(effectivePolicy([], 'u1', ['wecom:eng']).install_scripts).toBe(false)
  })

  it('market_only_on_when_global_or_any_effective_group_turns_it_on', () => {
    const globalOn = [
      row('market_only', 'global', '*', true),
      row('install_scripts', 'global', '*', false),
    ]
    expect(effectivePolicy(globalOn, 'u1', []).market_only).toBe(true)
    expect(effectivePolicy(globalOn, 'u1', ['wecom:eng']).market_only).toBe(true)

    const groupOn = [
      row('market_only', 'global', '*', false),
      row('market_only', 'group', 'wecom:eng', true),
      row('market_only', 'group', 'wecom:sales', false),
    ]
    expect(effectivePolicy(groupOn, 'u1', ['wecom:sales']).market_only).toBe(false)
    expect(effectivePolicy(groupOn, 'u1', ['wecom:eng']).market_only).toBe(true)
    expect(effectivePolicy(groupOn, 'u1', ['wecom:sales', 'wecom:eng']).market_only).toBe(true)
  })

  it('install_scripts_allow_when_any_effective_group_or_global_turns_it_on', () => {
    const rows = [
      row('install_scripts', 'global', '*', false),
      row('install_scripts', 'group', 'wecom:eng', true),
    ]
    expect(effectivePolicy(rows, 'u1', []).install_scripts).toBe(false)
    expect(effectivePolicy(rows, 'u1', ['wecom:eng']).install_scripts).toBe(true)
  })

  it('egress_lock_effective_stays_false_in_phase_1', () => {
    const rows = [row('egress_lock', 'global', '*', true)]
    expect(effectivePolicy(rows, 'u1', []).egress_lock).toBe(false)
  })
})

describe('admin GET/PUT /plugins/policy', () => {
  it('get_returns_global_defaults_and_put_writes_with_audit', () => {
    const db = fixture()
    const get = handlePluginPolicyAdmin({
      db, method: 'GET', path: '/admin/plugins/policy',
      actor: { userId: 'admin', email: 'admin@example.com' },
    })
    expect(get.status).toBe(200)
    expect(get.body).toEqual({ market_only: false, install_scripts: false, egress_lock: false })

    const put = handlePluginPolicyAdmin({
      db, method: 'PUT', path: '/admin/plugins/policy',
      actor: { userId: 'admin', email: 'admin@example.com' },
      body: { market_only: true, install_scripts: true, egress_lock: false },
      now: 1_700_000_000_000,
    })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ market_only: true, install_scripts: true, egress_lock: false })
    expect(getGlobalPluginPolicy(db)).toEqual({ market_only: true, install_scripts: true, egress_lock: false })

    const audit = listPendingAudit(db)
    expect(audit.some(r => r.event === 'admin-plugin-policy-change')).toBe(true)
    const change = audit.find(r => r.event === 'admin-plugin-policy-change')!
    expect(change.actor).toBe('admin@example.com')
    expect(change.detail).toMatch(/market_only/)
  })

  it('put_refuses_egress_lock_true_as_phase_2_stub', () => {
    const db = fixture()
    const put = handlePluginPolicyAdmin({
      db, method: 'PUT', path: '/admin/plugins/policy',
      actor: { userId: 'admin', email: 'admin@example.com' },
      body: { market_only: false, install_scripts: false, egress_lock: true },
    })
    expect(put.status).toBe(400)
    expect(put.body).toEqual(expect.objectContaining({ error: 'egress-lock-phase-2' }))
    expect(getGlobalPluginPolicy(db).egress_lock).toBe(false)
    expect(() => setPluginPolicy({
      db,
      policy: { market_only: false, install_scripts: false, egress_lock: true },
      actor: 'admin@example.com',
    })).toThrow(PluginPolicyError)
  })

  it('setPluginPolicyRow_group_override_feeds_effectivePolicy', () => {
    const db = fixture()
    setPluginPolicyRow({
      db,
      name: 'market_only',
      scope: { type: 'group', id: 'wecom:eng' },
      value: true,
      actor: 'admin@example.com',
      now: 1,
    })
    const rows = listPluginPolicyRows(db)
    expect(effectivePolicy(rows, 'u1', ['wecom:eng']).market_only).toBe(true)
    expect(effectivePolicy(rows, 'u1', ['wecom:sales']).market_only).toBe(false)
    const audit = listPendingAudit(db)
    expect(audit.some(r => r.event === 'admin-plugin-policy-change' && r.detail.includes('group:wecom:eng'))).toBe(true)
  })
})

describe('market_only drives npmrc and pluginMarketRows', () => {
  const common = {
    host: '127.0.0.1',
    port: 31_000,
    syncPlugin: 'file:///opt/dsh/release/packages/plugin-sync/lib/index.js',
    syncUrl: 'http://127.0.0.1:31000/reconcile-plan',
  }

  it('resolved_market_only_binds_registry_and_empty_fallbackRegistries', () => {
    const policy = effectivePolicy([row('market_only', 'global', '*', true)], 'u1', [])
    const opts = instanceMarketOptionsFromPolicy(policy, common)
    expect(opts.marketOnly).toBe(true)

    const npmrc = renderInstanceMarketNpmrc({ ...opts, token: 't' })
    expect(npmrc).toMatch(/^registry=http:\/\/127\.0\.0\.1:31000\/npm\/$/m)
    expect(npmrc).toContain(`${COMPANY_SCOPE_PREFIX.slice(0, -1)}:registry=http://127.0.0.1:31000/npm/`)

    const rows = pluginMarketRows(opts)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'plugin-manager',
        config: { registry: 'http://127.0.0.1:31000/npm/', fallbackRegistries: [] },
      }),
    ]))
  })

  it('without_market_only_leaves_default_registry_and_no_manager_override', () => {
    const policy = effectivePolicy([], 'u1', [])
    const opts = instanceMarketOptionsFromPolicy(policy, common)
    expect(opts.marketOnly).toBe(false)
    const npmrc = renderInstanceMarketNpmrc({ ...opts, token: 't' })
    expect(npmrc).not.toMatch(/^registry=/m)
    expect(pluginMarketRows(opts).some(r => 'id' in r && r.id === 'plugin-manager')).toBe(false)
  })
})

describe('market_only registry fail-closed without egress_lock', () => {
  it('non_mirror_registry_spec_fails_closed_not_found_style', () => {
    expect(() => assertRegistryUnderMarketOnly({
      marketOnly: true,
      registry: 'https://registry.npmjs.org/',
      mirrorRegistry: 'http://127.0.0.1:31000/npm/',
    })).toThrow(/not-found/)

    expect(() => assertRegistryUnderMarketOnly({
      marketOnly: true,
      registry: 'http://127.0.0.1:31000/npm/',
      mirrorRegistry: 'http://127.0.0.1:31000/npm/',
    })).not.toThrow()

    // Soft policy: when market_only is off, public registries stay allowed (no egress_lock).
    expect(() => assertRegistryUnderMarketOnly({
      marketOnly: false,
      registry: 'https://registry.npmjs.org/',
      mirrorRegistry: 'http://127.0.0.1:31000/npm/',
    })).not.toThrow()
  })

  it('company_scope_prefix_remains_forced', () => {
    expect(COMPANY_SCOPE_PREFIX).toBe('@corp-dsh/')
  })
})

describe('no firewall mutation from policy module', () => {
  it('policy_module_does_not_export_nft_or_egress_lock_appliers', async () => {
    const mod = await import('../src/policy.ts')
    const names = Object.keys(mod)
    expect(names.some(n => /nft|firewall|egress_locked|applyEgressLock/i.test(n))).toBe(false)
  })
})
