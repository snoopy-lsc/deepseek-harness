/** Loopback browser entry with identity and owner checks on every transport. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { UserId } from '@public-harness/contracts'
import type { IdentityVerifier } from './config.ts'
import type { OwnerRoute } from './routes.ts'
import { forwardHttp, forwardUpgrade, type BrowserLaunch } from './proxy.ts'

/** Development ingress dependencies shared by HTTP requests and upgrades. */
export interface RouterServerConfig {
  readonly host: string
  readonly identity: IdentityVerifier
  readonly ownerRouter: { route(rawUrl: string, userId: UserId): Promise<OwnerRoute> }
  readonly launch: BrowserLaunch
  readonly maxSocketLifetimeMs: number
}

function deny(response: ServerResponse, route: Exclude<OwnerRoute, { kind: 'ready' }>): void {
  switch (route.kind) {
    case 'redirect': response.writeHead(303, { location: route.location }).end(); return
    case 'starting': response.writeHead(503, { 'retry-after': '1' }).end(); return
    case 'rejected': response.writeHead(route.status).end(); return
  }
}

/** Open one local-only browser listener and return its ephemeral port. */
export async function startRouterServer(config: RouterServerConfig): Promise<{ port: number; close(): Promise<void> }> {
  if (config.host !== '127.0.0.1') throw new Error('development router requires loopback')
  if (!Number.isSafeInteger(config.maxSocketLifetimeMs) || config.maxSocketLifetimeMs <= 0
    || config.maxSocketLifetimeMs > 60_000) throw new Error('router socket lifetime must be at most 60 seconds')
  const sockets = new Set<Socket>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      let userId: UserId
      try { userId = await config.identity.verify(request.headers) }
      catch { response.writeHead(401).end(); return }
      const route = await config.ownerRouter.route(request.url ?? '/', userId)
      if (route.kind !== 'ready') { deny(response, route); return }
      forwardHttp(request, response, userId, route.endpoint, route.upstreamPath, config.launch, false)
    })().catch(() => { if (!response.headersSent && !response.destroyed) response.writeHead(503).end() })
  })
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      let userId: UserId
      try { userId = await config.identity.verify(request.headers) }
      catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
      const route = await config.ownerRouter.route(request.url ?? '/', userId)
      if (route.kind !== 'ready') {
        const status = route.kind === 'rejected' ? route.status : 503
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
        return
      }
      forwardUpgrade(request, socket, head, route.endpoint, route.upstreamPath, config.maxSocketLifetimeMs)
    })().catch(() => socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, config.host, () => { server.off('error', reject); resolve() })
  })
  return { port: (server.address() as AddressInfo).port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}
