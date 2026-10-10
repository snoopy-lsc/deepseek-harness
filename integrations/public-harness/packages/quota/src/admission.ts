/** Request checks completed before a quota reservation or upstream call. */
import type { UserId } from '@public-harness/contracts'
import type { QuotaLedger, Reservation } from './ledger.ts'
import type { TokenIssuer } from './tokens.ts'

/** Explicit request and image limits for the supported Messages operation. */
export interface AdmissionConfig {
  readonly modelContextWindows: Readonly<Record<string, number>>
  readonly maxBodyBytes: number
  readonly maxImagesPerRequest: number
  readonly maxInlineImageBytes: number
}

/** Values parsed from a private model-proxy HTTP request. */
export interface AdmissionRequest {
  readonly method: string
  readonly path: string
  readonly instanceId: string
  readonly authorization: string | undefined
  readonly contentType: string | undefined
  readonly body: Uint8Array
}

/** Admission result consumed by the bounded Messages forwarder. */
export interface AdmittedRequest { readonly userId: UserId; readonly reservation: Reservation }

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
}

function imagesWithinLimits(body: unknown, config: AdmissionConfig): void {
  const pending: unknown[] = [body]
  let count = 0
  let inlineBytes = 0
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { pending.push(...value); continue }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (record.type === 'image') {
      count += 1
      if (count > config.maxImagesPerRequest) throw new Error('request image count exceeds limit')
      const source = record.source
      if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('invalid request image')
      const image = source as Record<string, unknown>
      if (image.type !== 'base64' || typeof image.data !== 'string'
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('unsupported request image')
      inlineBytes += Math.ceil(image.data.length * 3 / 4)
      if (inlineBytes > config.maxInlineImageBytes) throw new Error('request image bytes exceed limit')
    }
    pending.push(...Object.values(record))
  }
}

/** Construct a fail-closed Messages admission service. */
export function createAdmission(dependencies: {
  readonly config: AdmissionConfig
  readonly issuer: TokenIssuer
  readonly ledger: QuotaLedger
}): { admit(request: AdmissionRequest): Promise<AdmittedRequest> } {
  const { config, issuer, ledger } = dependencies
  positive('maxBodyBytes', config.maxBodyBytes)
  positive('maxImagesPerRequest', config.maxImagesPerRequest)
  positive('maxInlineImageBytes', config.maxInlineImageBytes)
  if (Object.keys(config.modelContextWindows).length === 0) throw new Error('model context windows are required')
  for (const [model, context] of Object.entries(config.modelContextWindows)) {
    if (!model || !Number.isSafeInteger(context) || context <= 0) throw new Error('model context window must be positive')
  }
  return {
    async admit(request) {
      if (request.method !== 'POST') throw new Error('unsupported request method')
      if (request.path !== '/v1/messages') throw new Error('unsupported request path')
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType ?? '')) throw new Error('unsupported content type')
      if (request.body.byteLength > config.maxBodyBytes) throw new Error('request body exceeds limit')
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.authorization ?? '')
      if (match === null) throw new Error('invalid quota authorization')
      const userId = issuer.verify(match[1]!, request.instanceId)
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)) }
      catch { throw new Error('invalid request JSON') }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid request JSON')
      const data = parsed as Record<string, unknown>
      if (typeof data.model !== 'string' || !Object.hasOwn(config.modelContextWindows, data.model)) throw new Error('unsupported model')
      const context = config.modelContextWindows[data.model]
      if (context === undefined) throw new Error('model context window is missing')
      if (!Number.isSafeInteger(data.max_tokens) || Number(data.max_tokens) <= 0) throw new Error('max_tokens is required')
      if (!Array.isArray(data.messages)) throw new Error('request messages are required')
      imagesWithinLimits(data, config)
      const maximumTokens = context + Number(data.max_tokens)
      if (!Number.isSafeInteger(maximumTokens)) throw new Error('request has no safe token bound')
      return { userId, reservation: await ledger.reserve(userId, maximumTokens) }
    },
  }
}
