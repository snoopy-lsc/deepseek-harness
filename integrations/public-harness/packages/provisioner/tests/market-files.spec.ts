import { describe, expect, it } from 'vitest'
import { renderInstanceMarketNpmrc, renderInstanceMarketYml } from '../src/market-files.ts'

describe('instance-market file builders', () => {
  const common = {
    host: '127.0.0.1',
    port: 31_000,
    syncPlugin: 'file:///opt/dsh/release/packages/plugin-sync/lib/index.js',
    syncUrl: 'http://127.0.0.1:31000/reconcile-plan',
  }

  it('renders_npmrc_with_corp_scope_registry_auth_and_loopback_host', () => {
    const text = renderInstanceMarketNpmrc({ ...common, token: 'test-token-value' })
    expect(text).toContain('@corp-dsh:registry=http://127.0.0.1:31000/npm/')
    expect(text).toContain('//127.0.0.1:31000/npm/:_authToken=test-token-value')
    expect(text).not.toMatch(/^registry=/m)
    expect(text).toContain('127.0.0.1')
  })

  it('under_market_only_also_sets_default_registry_to_the_mirror', () => {
    const text = renderInstanceMarketNpmrc({ ...common, token: 't', marketOnly: true })
    expect(text).toMatch(/^registry=http:\/\/127\.0\.0\.1:31000\/npm\/$/m)
  })

  it('renders_yml_patch_as_json_document_with_indexes_url', () => {
    const yml = renderInstanceMarketYml(common)
    const parsed = JSON.parse(yml) as unknown[]
    expect(yml.endsWith('\n')).toBe(true)
    expect(JSON.stringify(parsed)).toContain('http://127.0.0.1:31000/index.json')
    expect(JSON.stringify(parsed)).toContain('plugin-market')
    expect(JSON.stringify(parsed)).toContain('public-harness-plugin-sync')
  })
})
