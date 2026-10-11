import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createQuotaLedger, type QuotaLedger } from '../src/ledger.ts'

const roots: string[] = []
const opened: QuotaLedger[] = []
afterEach(async () => {
  for (const ledger of opened.splice(0)) ledger.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(overrides: Record<string, number> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'public-harness-quota-'))
  roots.push(root)
  let instant = new Date('2026-10-10T23:59:59.000Z')
  const config = {
    databasePath: join(root, 'quota.sqlite'),
    personalDailyTokens: 100, siteDailyTokens: 200,
    personalConcurrency: 2, siteConcurrency: 3,
    busyTimeoutMs: 1000, ...overrides,
  }
  const open = () => {
    const ledger = createQuotaLedger(config, () => instant)
    opened.push(ledger)
    return ledger
  }
  return { open, config, nextDay: () => { instant = new Date('2026-10-11T00:00:01.000Z') } }
}

const alice = parseUserId('alice')
const bob = parseUserId('bob')

describe('durable quota ledger', () => {
  it('admits only one concurrent request for the last site tokens', async () => {
    const { open } = await fixture({ siteDailyTokens: 100 })
    const aliceLedger = open()
    const bobLedger = open()
    const results = await Promise.allSettled([aliceLedger.reserve(alice, 70), bobLedger.reserve(bob, 70)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/site daily/i)
  })

  it('counts personal and site daily usage after settlement', async () => {
    const { open } = await fixture({ personalDailyTokens: 60, siteDailyTokens: 80 })
    const ledger = open()
    await ledger.settle((await ledger.reserve(alice, 60)).id, 50)
    await expect(ledger.reserve(alice, 11)).rejects.toThrow(/personal daily/i)
    await ledger.settle((await ledger.reserve(bob, 30)).id, 30)
    await expect(ledger.reserve(bob, 1)).rejects.toThrow(/site daily/i)
  })

  it('counts per-user and site in-flight requests', async () => {
    const { open } = await fixture({ personalConcurrency: 1, siteConcurrency: 2 })
    const ledger = open()
    await ledger.reserve(alice, 10)
    await expect(ledger.reserve(alice, 10)).rejects.toThrow(/personal concurrency/i)
    await ledger.reserve(bob, 10)
    await expect(ledger.reserve(parseUserId('charlie'), 10)).rejects.toThrow(/site concurrency/i)
  })

  it('retains an old-day reservation while the new day has fresh capacity', async () => {
    const { open, nextDay } = await fixture({ personalDailyTokens: 50, siteDailyTokens: 60 })
    const ledger = open()
    const old = await ledger.reserve(alice, 50)
    nextDay()
    const fresh = await ledger.reserve(alice, 50)
    await ledger.settle(old.id, 40)
    await expect(ledger.reserve(alice, 1)).rejects.toThrow(/personal daily/i)
    await ledger.settle(fresh.id, 20)
    await ledger.reserve(alice, 30)
  })

  it('settles once and charges a cancelled stream at its reservation', async () => {
    const { open } = await fixture({ personalDailyTokens: 50 })
    const ledger = open()
    const first = await ledger.reserve(alice, 40)
    await ledger.settle(first.id, 10)
    await ledger.settle(first.id, 40)
    const second = await ledger.reserve(alice, 40)
    await ledger.settle(second.id)
    await expect(ledger.reserve(alice, 1)).rejects.toThrow(/personal daily/i)
  })

  it('charges unresolved reservations on restart and frees concurrency', async () => {
    const { open } = await fixture({ personalDailyTokens: 50, personalConcurrency: 1 })
    const first = open()
    const pending = await first.reserve(alice, 40)
    first.close()
    const restarted = open()
    await restarted.settle(pending.id, 0)
    await expect(restarted.reserve(alice, 11)).rejects.toThrow(/personal daily/i)
    await restarted.reserve(alice, 10)
  })

  it('rejects invalid limits and fails closed when storage is unavailable', async () => {
    const { open, config } = await fixture()
    expect(() => createQuotaLedger({ ...config, siteDailyTokens: 0 })).toThrow(/positive/i)
    const ledger = open()
    ledger.close()
    await expect(ledger.reserve(alice, 1)).rejects.toThrow(/closed/i)
  })

  it('reports aggregate site capacity and availability without user records', async () => {
    const { open, nextDay } = await fixture()
    const ledger = open()
    const pending = await ledger.reserve(alice, 40)
    await ledger.settle((await ledger.reserve(bob, 20)).id, 5)
    expect(await ledger.status()).toEqual({ siteTokensUsed: 45, siteTokensLimit: 200,
      siteInFlight: 1, siteConcurrencyLimit: 3 })
    await ledger.settle(pending.id, 10)
    nextDay()
    expect(await ledger.status()).toEqual({ siteTokensUsed: 0, siteTokensLimit: 200,
      siteInFlight: 0, siteConcurrencyLimit: 3 })
    ledger.close()
    await expect(ledger.status()).rejects.toThrow(/closed/i)
  })
})
