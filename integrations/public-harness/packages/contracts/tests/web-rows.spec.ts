import { describe, expect, it } from 'vitest'
import { platformModelRows } from '../src/index.ts'

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
