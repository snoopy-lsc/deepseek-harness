import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createTokenIssuer } from '../src/tokens.ts'
import { inspectQuotaHealth, type QuotaHealth } from '../src/health.ts'
import { startQuotaHttpServer } from '../src/server.ts'
import { QuotaRequestError } from '../src/admission.ts'
import { QuotaExceededError } from '../src/ledger.ts'

const issuer = createTokenIssuer({ secret: randomBytes(32), issuer: 'test-dev', lifetimeMs: 60_000 })

function service(health: { secret: string; inspect(): Promise<QuotaHealth> }) {
  return startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
    admission: { admit: vi.fn() }, forwardMessages: vi.fn(),
    files: { handle: vi.fn(), owns: vi.fn() }, maxBodyBytes: 100, maxFileBodyBytes: 100, health })
}

describe('private quota health and public errors', () => {
  it('returns aggregate capacity only to the private health credential', async () => {
    const health = { secret: 'private-health-secret', inspect: vi.fn(async () => ({
      available: true, siteTokensUsed: 8, siteTokensLimit: 100,
      siteInFlight: 1, siteConcurrencyLimit: 2,
    })) }
    const server = await service(health)
    try {
      const url = `http://127.0.0.1:${server.port}/internal/health`
      expect((await fetch(url)).status).toBe(401)
      expect(health.inspect).not.toHaveBeenCalled()
      const response = await fetch(url, { headers: { authorization: 'Bearer private-health-secret' } })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual(await health.inspect())
      expect(body).not.toMatch(/alice|prompt|credential|private-health-secret/i)
    } finally { await server.close() }
  })

  it('reports ledger failure without exposing its error or private data', async () => {
    const ledger = { status: vi.fn(async () => { throw new Error('secret sqlite path /private/alice') }) }
    const result = await inspectQuotaHealth(ledger)
    expect(result).toEqual({ available: false })
    expect(JSON.stringify(result)).not.toContain('alice')
  })

  it('maps upstream and storage failures to service unavailable', async () => {
    const token = issuer.issue('alice' as Parameters<typeof issuer.issue>[0], 'instance-a').token
    const server = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
      admission: { admit: vi.fn(async () => { throw new Error('sqlite /private/alice') }) },
      forwardMessages: vi.fn(), files: { handle: vi.fn(), owns: vi.fn() },
      maxBodyBytes: 100, maxFileBodyBytes: 100 })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('')
    } finally { await server.close() }
  })

  it.each([
    [new QuotaExceededError('personal daily'), 429],
    [new QuotaRequestError('invalid private prompt'), 400],
    [new Error('upstream credential secret'), 503],
  ])('returns only a public category for %s', async (failure, status) => {
    const token = issuer.issue('alice' as Parameters<typeof issuer.issue>[0], 'instance-a').token
    const server = await startQuotaHttpServer({ host: '127.0.0.1', instanceId: 'instance-a', issuer,
      admission: { admit: vi.fn(async () => { throw failure }) },
      forwardMessages: vi.fn(), files: { handle: vi.fn(), owns: vi.fn() },
      maxBodyBytes: 100, maxFileBodyBytes: 100 })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
    } finally { await server.close() }
  })

  it('rejects missing private health limits at startup', async () => {
    await expect(service({ secret: '', inspect: async () => ({ available: false }) })).rejects.toThrow(/health/i)
  })
})
