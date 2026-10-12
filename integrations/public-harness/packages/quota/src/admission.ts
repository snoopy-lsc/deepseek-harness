/** Request checks completed before a quota reservation or upstream call. */
import type { UserId } from '@public-harness/contracts'
import type { QuotaLedger, Reservation } from './ledger.ts'
import type { TokenIssuer } from './tokens.ts'

/** Explicit request and image limits for the supported Messages operation. */
export interface AdmissionConfig {
  readonly modelContextWindows: Readonly<Record<string, number>>
  /** Largest output per call for each model; a larger `max_tokens` is lowered to it before forwarding. */
  readonly modelMaxOutputTokens: Readonly<Record<string, number>>
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

/**
 * Admission result consumed by the bounded Messages forwarder. `body` is the request to forward: the caller's bytes,
 * or a re-encoded copy when `max_tokens` was lowered to the model's configured maximum output.
 */
export interface AdmittedRequest { readonly userId: UserId; readonly reservation: Reservation; readonly body: Uint8Array }

/**
 * Conservative input-token estimate from the encoded request size: one token per three UTF-8 bytes (about four
 * characters of English or one CJK character per token, so it overestimates typical text), capped by the context
 * window. It sizes the reservation and settles calls that end before upstream reports usage; reported usage wins.
 */
export function estimateInputTokens(bodyBytes: number, contextWindow: number): number {
  return Math.max(1, Math.min(contextWindow, Math.ceil(bodyBytes / 3)))
}

/** A caller supplied an unsupported or over-limit Messages request. */
export class QuotaRequestError extends Error {}

/** A caller did not present a valid instance-bound credential. */
export class QuotaAuthenticationError extends Error {}

function reject(message: string): never { throw new QuotaRequestError(message) }

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
}

function imagesWithinLimits(body: unknown, config: AdmissionConfig): string[] {
  const pending: unknown[] = [body]
  const fileIds: string[] = []
  let count = 0
  let inlineBytes = 0
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { pending.push(...value); continue }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (record.type === 'image') {
      count += 1
      if (count > config.maxImagesPerRequest) reject('request image count exceeds limit')
      const source = record.source
      if (typeof source !== 'object' || source === null || Array.isArray(source)) reject('invalid request image')
      const image = source as Record<string, unknown>
      if (image.type === 'file' && typeof image.file_id === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(image.file_id)) fileIds.push(image.file_id)
      else if (image.type === 'base64' && typeof image.data === 'string'
        && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        inlineBytes += Math.ceil(image.data.length * 3 / 4)
        if (inlineBytes > config.maxInlineImageBytes) reject('request image bytes exceed limit')
      } else reject('unsupported request image')
    }
    pending.push(...Object.values(record))
  }
  return fileIds
}

/** Construct a fail-closed Messages admission service. */
export function createAdmission(dependencies: {
  readonly config: AdmissionConfig
  readonly issuer: TokenIssuer
  readonly ledger: QuotaLedger
  readonly ownsFile?: (userId: UserId, fileId: string) => boolean
}): { admit(request: AdmissionRequest): Promise<AdmittedRequest> } {
  const { config, issuer, ledger } = dependencies
  positive('maxBodyBytes', config.maxBodyBytes)
  positive('maxImagesPerRequest', config.maxImagesPerRequest)
  positive('maxInlineImageBytes', config.maxInlineImageBytes)
  if (Object.keys(config.modelContextWindows).length === 0) throw new Error('model context windows are required')
  for (const [model, context] of Object.entries(config.modelContextWindows)) {
    if (!model || !Number.isSafeInteger(context) || context <= 0) throw new Error('model context window must be positive')
    const output = config.modelMaxOutputTokens[model]
    if (output === undefined || !Number.isSafeInteger(output) || output <= 0) throw new Error('model maximum output must be positive')
  }
  if (Object.keys(config.modelMaxOutputTokens).some(model => !Object.hasOwn(config.modelContextWindows, model))) {
    throw new Error('model maximum output names an unknown model')
  }
  return {
    async admit(request) {
      if (request.method !== 'POST') reject('unsupported request method')
      if (request.path !== '/v1/messages') reject('unsupported request path')
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType ?? '')) reject('unsupported content type')
      if (request.body.byteLength > config.maxBodyBytes) reject('request body exceeds limit')
      const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.authorization ?? '')
      if (match === null) throw new QuotaAuthenticationError('invalid quota authorization')
      let userId: UserId
      try { userId = issuer.verify(match[1]!, request.instanceId) }
      catch (error) { throw new QuotaAuthenticationError(error instanceof Error ? error.message : 'invalid quota credential') }
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)) }
      catch { reject('invalid request JSON') }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) reject('invalid request JSON')
      const data = parsed as Record<string, unknown>
      if (typeof data.model !== 'string' || !Object.hasOwn(config.modelContextWindows, data.model)) reject('unsupported model')
      const context = config.modelContextWindows[data.model]
      if (context === undefined) throw new Error('model context window is missing')
      if (!Number.isSafeInteger(data.max_tokens) || Number(data.max_tokens) <= 0) reject('max_tokens is required')
      if (!Array.isArray(data.messages)) reject('request messages are required')
      const fileIds = imagesWithinLimits(data, config)
      for (const fileId of fileIds) {
        if (dependencies.ownsFile?.(userId, fileId) !== true) reject('request image file ownership denied')
      }
      // Clamp rather than reject: clients ask for their own default output size, and the platform bound is what we pay for.
      const maxOutput = config.modelMaxOutputTokens[data.model]!
      const outputTokens = Math.min(Number(data.max_tokens), maxOutput)
      const body = outputTokens === data.max_tokens ? request.body
        : new TextEncoder().encode(JSON.stringify({ ...data, max_tokens: outputTokens }))
      const estimatedInputTokens = estimateInputTokens(body.byteLength, context)
      const maximumTokens = estimatedInputTokens + outputTokens
      if (!Number.isSafeInteger(maximumTokens)) reject('request has no safe token bound')
      const reservation = await ledger.reserve(userId, maximumTokens)
      return { userId, reservation: { ...reservation, estimatedInputTokens }, body }
    },
  }
}
