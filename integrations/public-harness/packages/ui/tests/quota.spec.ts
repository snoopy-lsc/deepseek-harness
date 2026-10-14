import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Toast: 'Toast' }))
import { overLimitText, dictionaries } from '../src/client/quota.tsx'
import type { AccountUsage } from '../src/client/me.ts'

const t = (key: keyof typeof dictionaries.en) => dictionaries.en[key]
const usage = (extra: Partial<AccountUsage>): AccountUsage => ({ day: '2026-10-14', usedTokens: 1200, limitTokens: 1000, resetAt: '2026-10-15T00:00:00.000Z', history: [], ...extra })

describe('over-limit copy', () => {
  it('is_silent_under_the_limit_or_without_a_policy', () => {
    expect(overLimitText(usage({ state: 'ok', overLimit: 'grace' }), t)).toBeUndefined()
    expect(overLimitText(usage({}), t)).toBeUndefined()
  })

  it('names_the_remaining_grace_the_advisory_limit_and_the_refusal', () => {
    expect(overLimitText(usage({ state: 'grace', overLimit: 'grace', hardLimitTokens: 1500 }), t)).toMatch(/grace of 300 tokens remains/)
    expect(overLimitText(usage({ state: 'over', overLimit: 'warn', hardLimitTokens: null }), t)).toMatch(/Requests still run/)
    expect(overLimitText(usage({ state: 'blocked', overLimit: 'block', hardLimitTokens: 1000 }), t)).toMatch(/^Your daily allowance \(1,000 tokens\) is used up/)
  })

  it('every_locale_has_the_same_keys', () => {
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
  })
})
