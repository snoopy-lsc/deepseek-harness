import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserId, requestLine } from '../../contracts/src/index.ts'
import { createQuotaLedger } from '../src/ledger.ts'
import { parseAccountRequest, startQuotaAccountServer } from '../src/account.ts'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

describe('quota account channel', () => {
  it('answers_usage_and_limits_and_applies_limit_changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-quota-account-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const ledger = createQuotaLedger({ databasePath: join(root, 'ledger.sqlite'), personalDailyTokens: 100, siteDailyTokens: 500, personalConcurrency: 2, siteConcurrency: 4, busyTimeoutMs: 1000 },
      () => new Date('2026-10-14T03:00:00Z'))
    cleanup.push(() => ledger.close())
    await ledger.settle((await ledger.reserve(parseUserId('alice'), 30)).id, 25)
    const socket = join(root, 'account.sock')
    const server = await startQuotaAccountServer(socket, ledger); cleanup.push(() => server.close())
    expect(await requestLine(socket, { op: 'usage', userId: 'alice' })).toMatchObject({ day: '2026-10-14', usedTokens: 25, limitTokens: 100 })
    expect(await requestLine(socket, { op: 'set-user', userId: 'alice', dailyTokens: 200 })).toMatchObject({ overrides: [{ userId: 'alice', dailyTokens: 200 }] })
    expect(await requestLine(socket, { op: 'set-default', dailyTokens: 50 })).toMatchObject({ defaultDailyTokens: 50 })
    expect(await requestLine(socket, { op: 'limits' })).toEqual({ configuredDailyTokens: 100, defaultDailyTokens: 50, defaultOverride: 50, overrides: [{ userId: 'alice', dailyTokens: 200 }] })
  })

  it('refuses_anything_but_the_exact_request_shapes', () => {
    for (const bad of [null, [], { op: 'usage' }, { op: 'usage', userId: 'a', extra: 1 }, { op: 'set-default', dailyTokens: 0 }, { op: 'set-user', userId: 'a', dailyTokens: 1.5 },
      { op: 'set-user', userId: '../x', dailyTokens: 5 }, { op: 'reserve', userId: 'a' }]) expect(() => parseAccountRequest(bad)).toThrow()
  })
})
