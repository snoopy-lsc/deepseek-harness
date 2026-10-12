import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createTokenIssuer } from '../src/tokens.ts'
import { createAdmission } from '../src/admission.ts'
import { startQuotaHttpServer } from '../src/server.ts'
import { createQuotaLedger } from '../src/ledger.ts'
import { createMessagesForwarder } from '../src/messages.ts'
import type { QuotaLedger, ReservationId } from '../src/ledger.ts'

const alice = parseUserId('alice')

describe('loopback quota HTTP ingress', () => {
  it('cancels a backpressured model body before shutdown returns', async () => {
    const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'test-dev', lifetimeMs: 60_000 })
    let cancellations = 0
    const server = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
      admission: { async admit() { return { userId: alice, reservation: {
        id: 'reservation' as ReservationId, userId: alice, day: '2026-10-11', maximumTokens: 100,
      }, body: new Uint8Array() } } },
      forwardMessages: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024)) },
        cancel() { cancellations += 1 },
      })), files: { handle: vi.fn(), owns: vi.fn() }, maxBodyBytes: 100, maxFileBodyBytes: 100,
    })
    try {
      const abort = new AbortController()
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${issuer.issue(alice, 'instance-a').token}` },
        body: '{}', signal: abort.signal,
      })
      await response.body!.getReader().read()
      abort.abort()
      await expect.poll(() => cancellations, { timeout: 1000 }).toBe(1)
      await server.close()
      expect(cancellations).toBe(1)
    } finally { await server.close() }
  })
  it('binds each credential to the receiving instance before forwarding', async () => {
    const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'test-dev', lifetimeMs: 60_000 })
    const ledger: QuotaLedger = { async reserve(userId, maximumTokens) {
      return { id: 'reservation' as ReservationId, userId, day: '2026-10-11', maximumTokens }
    }, async settle() {}, close() {} }
    const admission = createAdmission({ config: { modelContextWindows: { test: 100 }, modelMaxOutputTokens: { test: 100 },
      maxBodyBytes: 4096, maxImagesPerRequest: 2, maxInlineImageBytes: 1024 }, issuer, ledger })
    const forwardMessages = vi.fn(async () => new Response('accepted', { status: 200 }))
    const files = { handle: vi.fn(async () => new Response('file', { status: 200 })), owns: vi.fn(() => true), close() {} }
    const first = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
      admission, forwardMessages, files, maxBodyBytes: 4096, maxFileBodyBytes: 4096 })
    const second = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-b', issuer,
      admission, forwardMessages, files, maxBodyBytes: 4096, maxFileBodyBytes: 4096 })
    try {
      const token = issuer.issue(alice, 'instance-a').token
      const send = (port: number) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
      })
      expect((await send(second.port)).status).toBe(401)
      expect(forwardMessages).not.toHaveBeenCalled()
      expect(await (await send(first.port)).text()).toBe('accepted')
      expect(forwardMessages).toHaveBeenCalledTimes(1)
    } finally { await Promise.all([first.close(), second.close()]) }
  })

  it('rejects a public bind before opening a listener', async () => {
    const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'test-dev', lifetimeMs: 60_000 })
    await expect(startQuotaHttpServer({ host: '0.0.0.0', instanceId: 'instance-a', issuer,
      admission: { admit: vi.fn() }, forwardMessages: vi.fn(),
      files: { handle: vi.fn(), owns: vi.fn() }, maxBodyBytes: 100, maxFileBodyBytes: 100 }))
      .rejects.toThrow(/loopback/i)
  })

  it('accounts for real streamed usage, estimates missing usage, and explains the refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-server-'))
    const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'test-dev', lifetimeMs: 60_000 })
    const ledger = createQuotaLedger({ databasePath: join(root, 'quota.sqlite'),
      personalDailyTokens: 49, siteDailyTokens: 49, personalConcurrency: 1,
      siteConcurrency: 1, busyTimeoutMs: 1000 })
    const admission = createAdmission({ config: { modelContextWindows: { test: 100 }, modelMaxOutputTokens: { test: 100 },
      maxBodyBytes: 4096, maxImagesPerRequest: 2, maxInlineImageBytes: 1024 }, issuer, ledger })
    let calls = 0
    const upstream = vi.fn<typeof fetch>(async () => {
      calls += 1
      const frames = calls === 1
        ? 'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"type":"message_stop"}\n\n'
      return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const forwardMessages = createMessagesForwarder({ upstreamUrl: 'https://api.example.test/anthropic/v1/messages',
      platformKey: 'platform-secret', maxEventBytes: 4096, ledger, fetcher: upstream })
    const server = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
      admission, forwardMessages, files: { handle: vi.fn(), owns: vi.fn() },
      maxBodyBytes: 4096, maxFileBodyBytes: 4096 })
    try {
      const token = issuer.issue(alice, 'instance-a').token
      const send = () => fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', max_tokens: 10, messages: [] }) })
      expect((await (await send()).text())).toContain('message_stop')
      expect((await (await send()).text())).toContain('message_stop')
      // 8 reported + 16 estimated (47-byte request, no usage) = 24 used; the next 26-token reservation exceeds 49.
      const refused = await send()
      expect(refused.status).toBe(402)
      const body = await refused.json() as { error: { message: string }; quota: Record<string, unknown> }
      expect(body.quota).toEqual({ limit: 'personal-daily', remainingTokens: 25, requestedTokens: 26, resetAt: expect.stringMatching(/T00:00:00\.000Z$/) })
      expect(body.error.message).toMatch(/^Platform model quota exhausted \(personal daily limit\): 25 tokens left today/)
      expect(body.error.message).not.toMatch(/deepseek/i)
      expect(upstream).toHaveBeenCalledTimes(2)
    } finally {
      await server.close()
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
