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

function requestHeaders(request: IncomingMessage, upgrade: boolean): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name.startsWith('x-authentik-') || (!upgrade && hopHeaders.has(name))) continue
    output[name] = value
  }
  return output
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
  endpoint: InstanceEndpoint, upstreamPath: string, launch: BrowserLaunch, secure: boolean): void {
  const authority = request.headers.host
  if (authority === undefined) { response.writeHead(400).end(); return }
  const upstream = httpRequest({ ...target(endpoint), method: request.method, path: upstreamPath,
    headers: requestHeaders(request, false), agent: false }, backend => {
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
  request.pipe(upstream)
}

/** Forward one authenticated upgrade and close it within the configured lifetime. */
export function forwardUpgrade(request: IncomingMessage, browser: Duplex, browserHead: Buffer,
  endpoint: InstanceEndpoint, upstreamPath: string, maxLifetimeMs: number): void {
  const upstream = httpRequest({ ...target(endpoint), method: 'GET', path: upstreamPath,
    headers: requestHeaders(request, true), agent: false })
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
