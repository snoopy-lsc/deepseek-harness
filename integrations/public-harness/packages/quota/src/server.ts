/** Loopback quota ingress with a server-owned instance identity. */
import { once } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { QuotaAuthenticationError, QuotaRequestError, type AdmissionRequest, type AdmittedRequest } from './admission.ts'
import type { FilesProxy } from './files.ts'
import type { QuotaHealth } from './health.ts'
import { QuotaExceededError, type Reservation } from './ledger.ts'
import type { TokenIssuer } from './tokens.ts'

/** One private listener serves one bound Harness instance. */
export interface QuotaHttpConfig {
  readonly host: string
  readonly instanceId: string
  readonly issuer: TokenIssuer
  readonly admission: { admit(request: AdmissionRequest): Promise<AdmittedRequest> }
  readonly forwardMessages: (request: Request, reservation: Reservation) => Promise<Response>
  readonly files: Pick<FilesProxy, 'handle' | 'owns'>
  readonly maxBodyBytes: number
  readonly maxFileBodyBytes: number
  readonly health?: { readonly secret: string; inspect(): Promise<QuotaHealth> }
}

function privateSecretMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(`Bearer ${expected}`)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > limit) throw new Error('request body exceeds limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, length)
}

async function send(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/octet-stream' })
  if (result.body === null) { response.end(); return }
  const reader = result.body.getReader()
  let done = false
  try {
    while (!response.destroyed) {
      const next = await reader.read()
      if (next.done) { done = true; break }
      if (!response.write(next.value)) await once(response, 'drain')
    }
    if (!response.destroyed) response.end()
  } finally {
    if (!done) await reader.cancel().catch(() => { /* Quota settlement owns cancellation failure. */ })
  }
}

function bearer(request: IncomingMessage): string | undefined {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') count += 1
  }
  if (count !== 1 || typeof request.headers.authorization !== 'string') return undefined
  return request.headers.authorization
}

/** Start one local-only model proxy listener and return its bound port. */
export async function startQuotaHttpServer(config: QuotaHttpConfig): Promise<{ port: number; close(): Promise<void> }> {
  if (config.host !== '127.0.0.1') throw new Error('quota development ingress requires loopback')
  for (const value of [config.maxBodyBytes, config.maxFileBodyBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('quota HTTP body limits must be positive')
  }
  if (config.health !== undefined && config.health.secret.length < 16) throw new Error('private health secret is required')
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    const abort = new AbortController()
    response.once('close', () => abort.abort())
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const authorization = bearer(request)
      if (path === '/internal/health' && config.health !== undefined) {
        if (request.method !== 'GET' || !privateSecretMatches(authorization, config.health.secret)) {
          response.writeHead(401).end(); return
        }
        const report = await config.health.inspect()
        response.writeHead(report.available ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(report))
        return
      }
      if (authorization === undefined) { response.writeHead(401).end(); return }
      const isMessages = path === '/v1/messages'
      const isFiles = path === '/v1/files' || /^\/v1\/files\/[A-Za-z0-9_-]{1,128}$/.test(path)
      if (!isMessages && !isFiles) { response.writeHead(404).end(); return }
      let bytes: Buffer
      try { bytes = await readBounded(request, isMessages ? config.maxBodyBytes : config.maxFileBodyBytes) }
      catch { response.writeHead(413).end(); return }
      const headers = new Headers()
      for (const name of ['content-type', 'anthropic-version', 'anthropic-beta']) {
        const value = request.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      if (isMessages) {
        try {
          const admitted = await config.admission.admit({ method: request.method ?? '', path,
            instanceId: config.instanceId, authorization, contentType: headers.get('content-type') ?? undefined, body: bytes })
          const forwarded = new Request(`http://127.0.0.1${path}`, { method: 'POST',
            headers, body: Uint8Array.from(bytes), signal: abort.signal })
          await send(response, await config.forwardMessages(forwarded, admitted.reservation))
        } catch (error) {
          if (response.headersSent) { response.destroy(); return }
          response.writeHead(error instanceof QuotaExceededError
            ? error.reason === 'personal daily' || error.reason === 'site daily' ? 402 : 429
            : error instanceof QuotaAuthenticationError ? 401
              : error instanceof QuotaRequestError ? 400 : 503).end()
        }
        return
      }
      try {
        const match = /^Bearer (.+)$/.exec(authorization)
        if (match === null) throw new Error('invalid authorization')
        const userId = config.issuer.verify(match[1]!, config.instanceId)
        const target = new Request(`http://127.0.0.1${request.url ?? path}`, {
          method: request.method, headers,
          ...request.method === 'POST' ? { body: Uint8Array.from(bytes) } : {}, signal: abort.signal,
        })
        await send(response, await config.files.handle(userId, target))
      } catch {
        if (response.headersSent) response.destroy()
        else response.writeHead(401).end()
      }
    })().catch(() => { if (!response.destroyed) response.destroy() })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, config.host, () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  return { port, async close() {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
