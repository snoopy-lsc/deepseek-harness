import { join } from 'node:path'
import { startLineServer } from '@public-harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { startIdentity } from '../src/index.ts'
import { createQuotaAccountClient, parseLimits } from '../src/quota-account.ts'
import { call, linkIn, localEnv, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0)) await item.close() })
const USAGE = { day: '2026-10-14', usedTokens: 17, limitTokens: 400000, resetAt: '2026-10-15T00:00:00.000Z', history: [{ day: '2026-10-14', tokens: 17 }] }

async function fakeQuota(path: string) {
  const seen: unknown[] = []
  let limits = { configuredDailyTokens: 400000, defaultDailyTokens: 400000, overrides: [] as Array<{ userId: string; dailyTokens: number }> }
  const server = await startLineServer(path, async raw => {
    seen.push(raw); const r = raw as Record<string, unknown>
    if (r.op === 'usage') return USAGE
    if (r.op === 'set-user') limits = { ...limits, overrides: [{ userId: String(r.userId), dailyTokens: Number(r.dailyTokens) }] }
    return limits
  })
  open.push(server)
  return seen
}

describe('quota account socket (production usage source)', () => {
  it('config_reads_an_absolute_socket_path_from_the_environment', async () => {
    const { dir } = await setup()
    const env = { ...localEnv(dir), DSH_QUOTA_ACCOUNT_SOCKET: join(dir, 'account.sock') }
    expect((await setup({}, env)).config.quotaAccountSocket).toMatch(/account\.sock$/)
    await expect(setup({}, { ...env, DSH_QUOTA_ACCOUNT_SOCKET: 'relative.sock' })).rejects.toThrow(/DSH_QUOTA_ACCOUNT_SOCKET/)
    expect((await setup()).config.quotaAccountSocket).toBeUndefined()
  })

  it('client_validates_replies', async () => {
    expect(() => parseLimits({ configuredDailyTokens: -1, defaultDailyTokens: 1, overrides: [] })).toThrow()
    const { dir } = await setup()
    const seen = await fakeQuota(join(dir, 'q.sock'))
    const client = createQuotaAccountClient(join(dir, 'q.sock'))
    expect((await client.setUser('u1', 5000)).overrides).toEqual([{ userId: 'u1', dailyTokens: 5000 }])
    expect(seen).toEqual([{ op: 'set-user', userId: 'u1', dailyTokens: 5000 }])
  })

  it('start_identity_serves_personal_usage_from_the_socket_without_an_override', async () => {
    const { dir } = await setup()
    const socket = join(dir, 'q.sock')
    const { config } = await setup({}, { ...localEnv(dir), DSH_QUOTA_ACCOUNT_SOCKET: socket })
    const box = mailbox()
    const service = await startIdentity(config, { mail: box.mail }); open.push(service)
    const headers = { 'x-forwarded-for': '203.0.113.9', 'x-captcha-response': 'pass-captcha' }
    await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'Ann', email: 'ann@example.test', password: 'correct horse battery', callbackURL: '/account/verified' }, headers)
    const verify = linkIn(box.sent[0]!); await call(config.publicSocket, 'GET', verify.pathname + verify.search)
    const cookie = sessionCookie(await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email: 'ann@example.test', password: 'correct horse battery' }, headers))!
    // The quota service starts after identity, as it may in production; until then the usage panel answers 503.
    expect((await call(config.publicSocket, 'GET', '/account/api/me/usage', undefined, { cookie })).status).toBe(503)
    const seen = await fakeQuota(socket)
    const reply = await call(config.publicSocket, 'GET', '/account/api/me/usage', undefined, { cookie })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual(USAGE)
    expect(seen).toEqual([{ op: 'usage', userId: expect.any(String) }])
  })
})
