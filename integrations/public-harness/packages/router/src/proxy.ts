/** Streaming HTTP and bounded WebSocket forwarding to one selected instance. */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { InstanceEndpoint, UserId } from '@public-harness/contracts'

/** Cookie exchange needed only when the selected Web root rejects the browser. */
export interface BrowserLaunch {
  open(userId: UserId, endpoint: InstanceEndpoint, authority: string, secure: boolean): Promise<{
    readonly location: string; readonly setCookie: string
  }>
}

function target(endpoint: InstanceEndpoint): { socketPath: string } | { host: string; port: number } {
  return endpoint.kind === 'unix' ? { socketPath: endpoint.path } : { host: endpoint.host, port: endpoint.port }
}

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Identity and proxy-chain headers a browser could forge; the user's Harness never sees them. */
const strippedHeaders = /^(x-authentik-|x-forwarded-|x-real-ip$|forwarded$|x-original-)/

/** Remove named cookies (the router's own identity cookies) from a Cookie header; undefined when nothing is left. */
export function stripCookies(header: string, names: readonly string[]): string | undefined {
  const kept = header.split(';').map(part => part.trim()).filter(part => {
    const name = part.slice(0, part.indexOf('='))
    return part !== '' && !names.includes(name)
  })
  return kept.length ? kept.join('; ') : undefined
}

function requestHeaders(request: IncomingMessage, upgrade: boolean, cookies: readonly string[]): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || strippedHeaders.test(name) || (!upgrade && hopHeaders.has(name))) continue
    if (name === 'cookie' && typeof value === 'string') {
      const remaining = stripCookies(value, cookies)
      if (remaining !== undefined) output[name] = remaining
      continue
    }
    output[name] = value
  }
  return output
}

/** Default request-body ceiling: generous for uploads, finite so one client cannot stream without bound. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

/** Forwarding behavior shared by HTTP and upgrade paths. */
export interface ForwardOptions {
  /** True when the browser-facing leg is HTTPS; the scoped Harness cookie then carries `Secure`. */
  readonly secure: boolean
  /** Largest accepted request body; larger bodies receive 413 and never finish reaching the instance. */
  readonly maxBodyBytes: number
  /** Router-owned cookies removed before forwarding. */
  readonly stripCookies: readonly string[]
}

function responseHeaders(request: IncomingMessage, headers: IncomingMessage['headers'], userId: UserId): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'set-cookie' || hopHeaders.has(name)) continue
    if (name === 'location' && typeof value === 'string' && value.startsWith('/')) {
      output[name] = `/u/${userId}${value}`
    } else output[name] = value
  }
  if (request.method === 'HEAD') delete output['content-length']
  return output
}

/** Forward one HTTP request with native stream backpressure and cancellation. */
export function forwardHttp(request: IncomingMessage, response: ServerResponse, userId: UserId,
  endpoint: InstanceEndpoint, upstreamPath: string, launch: BrowserLaunch, options: ForwardOptions): void {
  const authority = request.headers.host
  if (authority === undefined) { response.writeHead(400).end(); return }
  const { secure, maxBodyBytes } = options
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBodyBytes)) {
    response.writeHead(413, { connection: 'close' }).end()
    response.once('finish', () => request.destroy())
    return
  }
  const upstream = httpRequest({ ...target(endpoint), method: request.method, path: upstreamPath,
    headers: requestHeaders(request, false, options.stripCookies), agent: false }, backend => {
    if (request.method === 'GET' && upstreamPath === '/' && backend.statusCode === 401) {
      backend.resume()
      void launch.open(userId, endpoint, authority, secure).then(result => {
        if (!response.destroyed) response.writeHead(303, { location: result.location,
          'set-cookie': result.setCookie, 'cache-control': 'no-store' }).end()
      }, () => { if (!response.destroyed) response.writeHead(503).end() })
      return
    }
    if (response.destroyed) { backend.destroy(); return }
    response.writeHead(backend.statusCode ?? 502, responseHeaders(request, backend.headers, userId))
    backend.pipe(response)
  })
  upstream.once('error', () => { if (!response.headersSent && !response.destroyed) response.writeHead(502).end() })
  request.once('aborted', () => upstream.destroy())
  response.once('close', () => upstream.destroy())
  let received = 0
  request.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received <= maxBodyBytes) return
    // Chunked or lying bodies are cut off here: stop feeding the instance and refuse.
    request.unpipe(upstream)
    upstream.destroy()
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(413, { connection: 'close' }).end()
      response.once('finish', () => request.destroy())
    } else request.destroy()
  })
  request.pipe(upstream)
}

/** Forward one authenticated upgrade and close it within the configured lifetime. */
export function forwardUpgrade(request: IncomingMessage, browser: Duplex, browserHead: Buffer,
  endpoint: InstanceEndpoint, upstreamPath: string, maxLifetimeMs: number, cookies: readonly string[] = ['team_dev']): void {
  const upstream = httpRequest({ ...target(endpoint), method: 'GET', path: upstreamPath,
    headers: requestHeaders(request, true, cookies), agent: false })
  let established = false
  upstream.once('upgrade', (response, backend, backendHead) => {
    if (response.statusCode !== 101) { backend.destroy(); browser.destroy(); return }
    established = true
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index]!
      if (name.toLowerCase() === 'set-cookie') continue
      lines.push(`${name}: ${response.rawHeaders[index + 1]!}`)
    }
    browser.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (backendHead.length) browser.write(backendHead)
    if (browserHead.length) backend.write(browserHead)
    const timer = setTimeout(() => { browser.destroy(); backend.destroy() }, maxLifetimeMs)
    browser.once('close', () => { clearTimeout(timer); backend.destroy() })
    backend.once('close', () => { clearTimeout(timer); browser.destroy() })
    browser.on('error', () => backend.destroy())
    backend.on('error', () => browser.destroy())
    browser.pipe(backend).pipe(browser)
  })
  upstream.once('response', backend => {
    backend.resume()
    if (!established) { browser.end(`HTTP/1.1 ${backend.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`) }
  })
  upstream.once('error', () => { if (!established) browser.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
  browser.once('close', () => upstream.destroy())
  upstream.end()
}
