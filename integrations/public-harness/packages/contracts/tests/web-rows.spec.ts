import { describe, expect, it } from 'vitest'
import { platformModelRows, pluginMarketRows } from '../src/index.ts'

describe('platform model rows', () => {
  it('starts_fresh_agents_on_the_platform_model_and_hides_the_keyless_official_provider', () => {
    expect(platformModelRows({ provider: 'platform', model: 'm-1' })).toEqual([
      { id: 'agent-default-model', config: { provider: 'platform', model: 'm-1' } },
      { id: 'llm-deepseek', disabled: true },
    ])
  })

  it('keeps_the_official_provider_when_a_key_is_configured', () => {
    expect(platformModelRows({ provider: 'platform', model: 'm-1', officialKey: true })).toEqual([
      { id: 'agent-default-model', config: { provider: 'platform', model: 'm-1' } },
    ])
  })
})

describe('plugin market rows', () => {
  const base = {
    host: '127.0.0.1',
    port: 31_000,
    syncPlugin: 'file:///opt/dsh/release/packages/plugin-sync/lib/index.js',
    syncUrl: 'http://127.0.0.1:31000/reconcile-plan',
  }

  it('inserts_plugin_market_ui_and_sync_with_indexes_on_loopback', () => {
    const rows = pluginMarketRows(base)
    expect(rows).toEqual([
      {
        insert: [
          {
            id: 'plugin-market',
            name: '@deepseek-ai/dsh-plugin-market',
            config: { indexes: ['http://127.0.0.1:31000/index.json'] },
          },
          { id: 'ui-plugin-market', name: '@deepseek-ai/dsh-client-ui-plugin-market' },
          {
            id: 'public-harness-plugin-sync',
            name: base.syncPlugin,
            config: { syncUrl: base.syncUrl },
          },
        ],
      },
    ])
  })

  it('under_market_only_sets_plugin_manager_registry_to_the_mirror', () => {
    const rows = pluginMarketRows({ ...base, marketOnly: true })
    expect(rows).toContainEqual({
      id: 'plugin-manager',
      config: {
        registry: 'http://127.0.0.1:31000/npm/',
        fallbackRegistries: [],
      },
    })
  })
})
