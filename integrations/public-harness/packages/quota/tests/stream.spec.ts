import { describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createMessagesForwarder } from '../src/messages.ts'
import type { QuotaLedger, Reservation, ReservationId } from '../src/ledger.ts'

const reservation = (id: string): Reservation => ({ id: id as ReservationId,
  userId: parseUserId('alice'), day: '2026-10-11', maximumTokens: 100 })
const request = () => new Request('http://attacker.invalid/arbitrary', {
  method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test', max_tokens: 10, messages: [] }),
})
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const stream = (events: string[]) => new ReadableStream<Uint8Array>({
  start(controller) { for (const value of events) controller.enqueue(Buffer.from(value)); controller.close() },
})

function setup(fetcher: typeof fetch) {
  const settlements: [string, number | undefined][] = []
  const ledger: QuotaLedger = {
    reserve: vi.fn(), async settle(id, actual) { settlements.push([id, actual]) }, close() {},
  }
  return { forward: createMessagesForwarder({
    upstreamUrl: 'https://api.example.test/anthropic/v1/messages', platformKey: 'platform-secret',
    maxEventBytes: 4096, ledger, fetcher,
  }), settlements }
}

describe('metered Messages forwarding', () => {
  it('streams bytes unchanged, pins the upstream URL, and charges final usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream([
      event({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } } }),
      event({ type: 'message_delta', usage: { output_tokens: 3, cache_creation_input_tokens: 1 } }),
      event({ type: 'message_stop' }),
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const { forward, settlements } = setup(fetcher)
    const response = await forward(request(), reservation('a'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(settlements).toEqual([['a', 11]])
    expect(fetcher).toHaveBeenCalledWith('https://api.example.test/anthropic/v1/messages',
      expect.objectContaining({ redirect: 'manual', headers: expect.objectContaining({ 'x-api-key': 'platform-secret' }) }))
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('user-token')
  })

  it('charges the reservation when final usage is missing or SSE is malformed', async () => {
    const missing = setup(async () => new Response(stream([event({ type: 'message_stop' })]), { status: 200 }))
    await (await missing.forward(request(), reservation('missing'))).text()
    expect(missing.settlements).toEqual([['missing', undefined]])
    const malformed = setup(async () => new Response(stream(['data: {bad json\n\n']), { status: 200 }))
    await expect((await malformed.forward(request(), reservation('bad'))).text()).rejects.toThrow(/SSE/i)
    expect(malformed.settlements).toEqual([['bad', undefined]])
  })

  it('charges once after client cancellation', async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Buffer.from(event({ type: 'message_start', message: {} }))) } })
    const { forward, settlements } = setup(async () => new Response(body, { status: 200 }))
    const response = await forward(request(), reservation('cancel'))
    await response.body?.getReader().cancel()
    expect(settlements).toEqual([['cancel', undefined]])
  })

  it('rejects redirects, upstream failures, and retries without releasing reservations', async () => {
    let attempt = 0
    const { forward, settlements } = setup(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('network unavailable')
      if (attempt === 2) return Response.redirect('https://attacker.invalid/', 302)
      return new Response(stream([event({ type: 'message_stop' })]), { status: 200 })
    })
    await expect(forward(request(), reservation('network'))).rejects.toThrow(/network unavailable/)
    await expect(forward(request(), reservation('redirect'))).rejects.toThrow(/redirect/i)
    await (await forward(request(), reservation('retry'))).text()
    expect(settlements).toEqual([['network', undefined], ['redirect', undefined], ['retry', undefined]])
  })
})
