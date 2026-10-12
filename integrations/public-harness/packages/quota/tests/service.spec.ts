import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserId } from '@public-harness/contracts'
import { createQuotaControlClient, startQuotaControlServer } from '../src/control.ts'
import { createRejectionCounter, sanitizeDiagnostic } from '../src/health.ts'
import { createQuotaService, validateQuotaServiceConfig, type QuotaService, type QuotaServiceConfig } from '../src/service.ts'

const alice = parseUserId('alice')
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

const sse = (event: Record<string, unknown>): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const upstreamBody = [
  { type: 'message_start', message: { id: 'msg_1', model: 'm', usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }].map(sse).join('')

async function setup(overrides: Partial<QuotaServiceConfig> = {}): Promise<{ config: QuotaServiceConfig; calls: Array<{ url: string; key: string | null }> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-'))
  await chmod(dir, 0o700)
  const secret = async (name: string, value: string, mode = 0o600): Promise<string> => {
    const path = join(dir, name); await writeFile(path, value, { mode }); await chmod(path, mode); return path
  }
  const config: QuotaServiceConfig = { stateDir: dir, upstreamRoot: 'https://upstream.example.test/anthropic/v1',
    platformKeyFile: await secret('platform.key', 'platform-secret-key'), tokenSecretFile: await secret('token.key', 'x'.repeat(48)),
    healthSecretFile: await secret('health.key', 'h'.repeat(24)), modelId: 'platform-model', contextWindow: 4096, maxOutputTokens: 1024,
    personalDailyTokens: 6000, siteDailyTokens: 100_000, personalConcurrency: 2, siteConcurrency: 8, busyTimeoutMs: 1000,
    maxBodyBytes: 100_000, maxImagesPerRequest: 2, maxInlineImageBytes: 10_000, maxEventBytes: 65_536, maxFileBodyBytes: 100_000,
    maxFilesPerUser: 10, maxFileMetadataBytes: 4096, maxFileListLimit: 20, credentialLifetimeMs: 600_000, listenPorts: { min: 29100, max: 29139 }, ...overrides }
  return { config, calls: [] }
}

async function start(config: QuotaServiceConfig, calls: Array<{ url: string; key: string | null }>): Promise<QuotaService> {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') })
    return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const service = await createQuotaService(config, { fetcher })
  closers.push(() => service.shutdown())
  return service
}

describe('production quota service', () => {
  it.each([
    ['plain HTTP upstream', { upstreamRoot: 'http://upstream.example.test/v1' }],
    ['upstream without /v1', { upstreamRoot: 'https://upstream.example.test/' }],
    ['zero concurrency', { personalConcurrency: 0 }],
    ['credential lifetime over fifteen minutes', { credentialLifetimeMs: 900_001 }],
    ['budget below one request', { personalDailyTokens: 100 }],
    ['relative secret path', { platformKeyFile: 'platform.key' }],
  ])('refuses to start with %s', async (_name, override) => {
    const { config } = await setup()
    expect(() => validateQuotaServiceConfig({ ...config, ...override })).toThrow()
  })

  it.skipIf(process.platform === 'win32')('refuses a world-readable or short secret file', async () => {
    const { config } = await setup()
    await chmod(config.platformKeyFile, 0o644)
    await expect(createQuotaService(config)).rejects.toThrow(/private regular/)
    await chmod(config.platformKeyFile, 0o600)
    await writeFile(config.tokenSecretFile, 'short', { mode: 0o600 })
    await expect(createQuotaService(config)).rejects.toThrow(/too short/)
  })

  it('opens listeners only inside the configured range, never reuses a live port, and frees it on close', async () => {
    const { config, calls } = await setup({ listenPorts: { min: 29150, max: 29151 } })
    const service = await start(config, calls)
    const first = (await service.open(alice, 'i1')).port
    const second = (await service.open(parseUserId('bob'), 'i2')).port
    expect([first, second].sort()).toEqual([29150, 29151])
    await expect(service.open(parseUserId('carol'), 'i3')).rejects.toThrow(/no free listener port/)
    await service.close(alice)
    expect((await service.open(parseUserId('carol'), 'i3')).port).toBe(first)
    // Reopening for the same user replaces that user's listener inside the range.
    expect([first, second]).toContain((await service.open(parseUserId('bob'), 'i4')).port)
  })

  it.each([undefined, { min: 80, max: 90 }, { min: 40000, max: 40010 }, { min: 3000, max: 2000 }])('rejects listenPorts %j', async listenPorts => {
    const { config } = await setup({ listenPorts: listenPorts as never })
    expect(() => validateQuotaServiceConfig(config)).toThrow(/listenPorts/)
  })

  it('meters a model call end to end, keeps the platform key upstream-only, and reports aggregate health', async () => {
    const { config, calls } = await setup({ personalDailyTokens: 5000 })
    const service = await start(config, calls)
    const { port } = await service.open(alice, 'instance-1')
    const { token } = service.issue(alice, 'instance-1')
    const body = JSON.stringify({ model: 'platform-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(calls).toEqual([{ url: 'https://upstream.example.test/anthropic/v1/messages', key: 'platform-secret-key' }])
    expect((await service.inspect())).toMatchObject({ available: true, siteTokensUsed: 17, rejections: { 'personal-daily': 0 } })
    // A credential for another instance is refused and counted.
    const other = service.issue(alice, 'instance-2')
    expect((await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body,
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' } })).status).toBe(401)
    // A request with a context-sized input (capped at 4096) plus the clamped 1024 output exceeds 5000 - 17 tokens.
    const refused = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
      body: JSON.stringify({ model: 'platform-model', max_tokens: 3000, messages: [{ role: 'user', content: 'x'.repeat(15_000) }] }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    expect(refused.status).toBe(402)
    expect(await refused.json()).toMatchObject({ type: 'error', error: { type: 'quota_exceeded' },
      quota: { limit: 'personal-daily', remainingTokens: 4983, requestedTokens: 5120 } })
    const health = await service.inspect()
    expect(health).toMatchObject({ available: true, rejections: { unauthenticated: 1, 'personal-daily': 1 } })
    expect(JSON.stringify(health)).not.toMatch(/alice|platform-secret|instance/)
    const privateHealth = await fetch(`http://127.0.0.1:${port}/internal/health`, { headers: { authorization: `Bearer ${service.healthSecret}` } })
    expect(privateHealth.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('exposes only open, issue, close, and health to the provisioner over a private socket', async () => {
    const { config, calls } = await setup()
    const service = await start(config, calls)
    const socket = join(config.stateDir, 'control.sock')
    const server = await startQuotaControlServer(socket, service)
    closers.push(() => server.close())
    const client = createQuotaControlClient(socket)
    expect(await client.healthy()).toBe(true)
    const { port } = await client.open(alice, 'instance-1')
    expect(port).toBeGreaterThan(0)
    const issued = await client.issue(alice, 'instance-1')
    expect(issued.token).toMatch(/\./)
    await client.close(alice)
    const { requestLine } = await import('@public-harness/contracts')
    await expect(requestLine(socket, { op: 'shell', cmd: 'id' })).rejects.toThrow('invalid request')
    await expect(requestLine(socket, { op: 'issue', userId: '../x', instanceId: 'a' })).rejects.toThrow()
    await expect(requestLine(socket, { op: 'issue', userId: 'alice', instanceId: 'a/b' })).rejects.toThrow('invalid request')
  })
})

describe('diagnostics', () => {
  it('redacts bearer tokens, credentials, key-value secrets, and paths', () => {
    const text = sanitizeDiagnostic(new Error('upstream failed at /var/lib/dsh/quota/ledger.sqlite with Authorization: Bearer abcdefgh12345678 and api_key=sk-live-1234567890abcdef token="eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9abc"'))
    expect(text).not.toMatch(/ledger\.sqlite|abcdefgh12345678|sk-live|eyJhbGci|\/var\/lib/)
    expect(text).toContain('[redacted]')
    expect(sanitizeDiagnostic(42)).toBe('unknown failure')
    expect(sanitizeDiagnostic('x'.repeat(1000)).length).toBe(200)
  })

  it('counts refusals by category only', () => {
    const counter = createRejectionCounter()
    counter.record('site-daily'); counter.record('site-daily')
    expect(counter.snapshot()).toMatchObject({ 'site-daily': 2, unavailable: 0 })
  })
})
