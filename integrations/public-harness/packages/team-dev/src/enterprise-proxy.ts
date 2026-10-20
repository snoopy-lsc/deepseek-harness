/** Loopback HTTP entry for account APIs and the authenticated per-user router. */
import { createServer, request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { renderStatusPage } from '@public-harness/ui'
import { connect, type AddressInfo, type Socket } from 'node:net'

/** Running local ingress; callers attach services after reserving its port. */
export interface EnterpriseEntry {
  readonly origin: string
  activate(identitySocket: string, routerPort: number): void
  close(): Promise<void>
}

/** Reserve a loopback port and return 503 until the private services are ready.
 * @param port Configured port; zero atomically selects a free test port.
 * @param retryAfterSeconds Waiting-page refresh interval.
 * @returns Ingress with bounded forwarding and awaited shutdown.
 */
export async function startEnterpriseEntry(port: number, retryAfterSeconds: number): Promise<EnterpriseEntry> {
  let services: { identitySocket: string; routerPort: number } | undefined
  let origin = ''
  const sockets = new Set<Socket>()
  const validHost = (req: IncomingMessage) => req.headers.host === new URL(origin).host
  const unavailable = (res: ServerResponse) => { res.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', 'retry-after': String(retryAfterSeconds) }).end(renderStatusPage('service-unavailable', 'en', retryAfterSeconds)) }
  const server = createServer((req, res) => {
    if (!validHost(req)) { res.writeHead(421).end(); return }
    if (services === undefined) { unavailable(res); return }
    if (req.url === '/') { res.writeHead(303, { location: '/account/login', 'cache-control': 'no-store' }).end(); return }
    const account = /^\/(account\/|api\/(auth|admin)\/)/.test(req.url ?? '')
    const upstream = request({ ...account ? { socketPath: services.identitySocket } : { host: '127.0.0.1', port: services.routerPort },
      method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1' }, agent: false }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(res)
      reply.once('error', () => res.destroy())
    })
    upstream.once('error', () => { if (!res.headersSent) unavailable(res); else res.destroy() })
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket: Socket, head) => {
    if (services === undefined || !validHost(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const upstream = connect(services.routerPort, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\r\n')}\r\n\r\n`)
      upstream.write(head); upstream.pipe(socket); socket.pipe(upstream)
    })
    upstream.once('error', () => socket.destroy())
    socket.once('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) { server.close(); throw error }
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let closing: Promise<void> | undefined
  return { origin, activate(identitySocket, routerPort) { services = { identitySocket, routerPort } },
    close() { return closing ??= (async () => {
      services = undefined
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })() } }
}
