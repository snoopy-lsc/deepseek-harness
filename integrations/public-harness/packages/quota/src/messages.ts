/** Pinned-origin Messages forwarding; settles by reported usage, or by what was received when a call is cut short. */
import type { QuotaLedger, Reservation } from './ledger.ts'

/** One configured upstream and the platform credential held only by the quota service. */
export interface MessagesForwarderConfig {
  readonly upstreamUrl: string
  readonly platformKey: string
  readonly maxEventBytes: number
  readonly ledger: QuotaLedger
  readonly fetcher?: typeof fetch
}

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

class UsageParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private data = ''
  private stopped = false
  private readonly usage: Usage = {}
  private outputBytes = 0

  constructor(private readonly maxEventBytes: number) {}

  write(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true })
    for (const character of text) {
      if (character === '\n') {
        this.consumeLine(this.line.endsWith('\r') ? this.line.slice(0, -1) : this.line)
        this.line = ''
      } else {
        this.line += character
        if (Buffer.byteLength(this.line, 'utf8') > this.maxEventBytes) throw new Error('Messages SSE event exceeds limit')
      }
    }
  }

  private consumeLine(line: string): void {
    if (!line) {
      if (this.data) this.consumeEvent(this.data.slice(0, -1))
      this.data = ''
    } else if (line.startsWith('data:')) {
      this.data += `${line.slice(5).trimStart()}\n`
      if (Buffer.byteLength(this.data, 'utf8') > this.maxEventBytes) throw new Error('Messages SSE event exceeds limit')
    }
  }

  private consumeEvent(data: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(data) }
    catch { throw new Error('invalid Messages SSE JSON') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid Messages SSE event')
    const event = parsed as Record<string, unknown>
    if (event.type === 'message_stop') { this.stopped = true; return }
    if (event.type === 'content_block_delta' && typeof event.delta === 'object' && event.delta !== null) {
      const delta = event.delta as Record<string, unknown>
      for (const key of ['text', 'partial_json', 'thinking'] as const) {
        if (typeof delta[key] === 'string') this.outputBytes += Buffer.byteLength(delta[key], 'utf8')
      }
    }
    const candidate = event.type === 'message_start' && typeof event.message === 'object' && event.message !== null
      ? (event.message as Record<string, unknown>).usage
      : event.type === 'message_delta' ? event.usage : undefined
    if (candidate === undefined) return
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) throw new Error('invalid Messages SSE usage')
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
      const value = (candidate as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid Messages SSE usage')
      this.usage[key] = Number(value)
    }
  }

  /** What arrived so far, without requiring a complete stream. */
  partial(): { input: number | undefined; output: number; outputBytes: number } {
    const input = this.usage.input_tokens === undefined ? undefined
      : this.usage.input_tokens + (this.usage.cache_read_input_tokens ?? 0) + (this.usage.cache_creation_input_tokens ?? 0)
    return { input, output: this.usage.output_tokens ?? 0, outputBytes: this.outputBytes }
  }

  result(): number | undefined {
    this.decoder.decode()
    if (this.line || this.data) throw new Error('incomplete Messages SSE event')
    if (!this.stopped || this.usage.input_tokens === undefined || this.usage.output_tokens === undefined) return undefined
    const total = this.usage.input_tokens + this.usage.output_tokens
      + (this.usage.cache_read_input_tokens ?? 0) + (this.usage.cache_creation_input_tokens ?? 0)
    if (!Number.isSafeInteger(total)) throw new Error('invalid Messages SSE usage total')
    return total
  }
}

/**
 * Charge for a call that ended without a complete usage report (client gone, stream error, upstream failure): reported
 * input usage if it arrived, otherwise admission's input estimate, plus the larger of reported output so far and one
 * token per three bytes of streamed text; never more than the reservation.
 */
function interruptedCharge(parser: UsageParser | undefined, reservation: Reservation): number {
  const partial = parser?.partial()
  const input = partial?.input ?? reservation.estimatedInputTokens ?? reservation.maximumTokens
  const output = partial === undefined ? 0 : Math.max(partial.output, Math.ceil(partial.outputBytes / 3))
  return Math.min(reservation.maximumTokens, input + output)
}

/** Build a forwarder that never accepts an upstream URL from the caller. */
export function createMessagesForwarder(config: MessagesForwarderConfig):
  (request: Request, reservation: Reservation) => Promise<Response> {
  const url = new URL(config.upstreamUrl)
  if (!((url.protocol === 'https:') || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || !url.pathname.endsWith('/v1/messages') || url.username || url.password || url.search || url.hash
    || !config.platformKey || !Number.isSafeInteger(config.maxEventBytes) || config.maxEventBytes <= 0) {
    throw new Error('invalid pinned Messages upstream configuration')
  }
  const upstreamUrl = url.href
  const fetcher = config.fetcher ?? fetch
  return async (request, reservation) => {
    let settled = false
    const settle = async (actual?: number): Promise<void> => {
      if (settled) return
      settled = true
      await config.ledger.settle(reservation.id, actual)
    }
    let upstream: Response
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': config.platformKey }
      for (const key of ['anthropic-version', 'anthropic-beta']) {
        const value = request.headers.get(key)
        if (value !== null) headers[key] = value
      }
      upstream = await fetcher(upstreamUrl, { method: 'POST', body: await request.arrayBuffer(), headers,
        redirect: 'manual', signal: request.signal })
      if (upstream.status >= 300 && upstream.status < 400) throw new Error('Messages upstream redirect refused')
      if (!upstream.ok || upstream.body === null) throw new Error('Messages upstream failed')
    } catch (error) {
      await settle(interruptedCharge(undefined, reservation))
      throw error
    }
    const reader = upstream.body.getReader()
    const parser = new UsageParser(config.maxEventBytes)
    const charge = (): number => interruptedCharge(parser, reservation)
    const output = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            await settle(parser.result() ?? charge())
            controller.close()
          } else {
            parser.write(value)
            controller.enqueue(value)
          }
        } catch (error) {
          try { await reader.cancel(error) } catch { /* The read failure remains the client-visible cause. */ }
          try { await settle(charge()) } finally { controller.error(error) }
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } finally { await settle(charge()) }
      },
    })
    return new Response(output, { status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' } })
  }
}
