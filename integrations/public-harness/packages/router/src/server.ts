/** Loopback browser entry with identity and owner checks on every transport. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { UserId } from '@public-harness/contracts'
import { renderSelectorPage, renderStatusPage, type TeamLocale } from '@public-harness/ui'
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
  readonly retryAfterSeconds: number
  readonly developmentSelector?: { readonly users: readonly UserId[]; issue(userId: string): string }
}

function locale(request: IncomingMessage): TeamLocale {
  return request.headers['accept-language']?.includes('zh') ? 'zh' : 'en'
}

function selectDevelopmentUser(request: IncomingMessage, response: ServerResponse,
  selector: NonNullable<RouterServerConfig['developmentSelector']>): boolean {
  if (request.method !== 'GET') return false
  if (request.url === '/dev') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(renderSelectorPage(selector.users, locale(request)))
    return true
  }
  const match = /^\/dev\/select\/([A-Za-z0-9_-]{1,128})$/.exec(request.url ?? '')
  if (match === null) return false
  if (!selector.users.includes(match[1] as UserId)) { response.writeHead(404).end(); return true }
  const cookie = selector.issue(match[1]!)
  if (!/^team_dev=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie)) throw new Error('invalid development selector cookie')
  response.writeHead(303, { location: `/u/${match[1]}/`, 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict`,
    'cache-control': 'no-store' }).end()
  return true
}

function deny(request: IncomingMessage, response: ServerResponse,
  route: Exclude<OwnerRoute, { kind: 'ready' }>, retryAfterSeconds: number): void {
  switch (route.kind) {
    case 'redirect': response.writeHead(303, { location: route.location }).end(); return
    case 'starting': response.writeHead(503, { 'retry-after': String(retryAfterSeconds),
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(renderStatusPage('starting', locale(request), retryAfterSeconds)); return
    case 'rejected':
      if (route.status === 503) {
        response.writeHead(route.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(renderStatusPage(route.reason === 'capacity' ? 'capacity-full' : 'service-unavailable', locale(request), retryAfterSeconds))
      } else response.writeHead(route.status).end()
      return
  }
}

/** Open one local-only browser listener and return its ephemeral port. */
export async function startRouterServer(config: RouterServerConfig): Promise<{ port: number; close(): Promise<void> }> {
  if (config.host !== '127.0.0.1') throw new Error('development router requires loopback')
  if (!Number.isSafeInteger(config.maxSocketLifetimeMs) || config.maxSocketLifetimeMs <= 0
    || config.maxSocketLifetimeMs > 60_000) throw new Error('router socket lifetime must be at most 60 seconds')
  if (!Number.isSafeInteger(config.retryAfterSeconds) || config.retryAfterSeconds < 1) throw new Error('invalid router retry interval')
  const sockets = new Set<Socket>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (config.developmentSelector !== undefined
        && selectDevelopmentUser(request, response, config.developmentSelector)) return
      let userId: UserId
      try { userId = await config.identity.verify(request.headers) }
      catch {
        if (request.method === 'GET' && request.url === '/' && config.developmentSelector !== undefined) {
          response.writeHead(303, { location: '/dev' }).end()
        } else response.writeHead(401).end()
        return
      }
      const route = await config.ownerRouter.route(request.url ?? '/', userId)
      if (route.kind !== 'ready') { deny(request, response, route, config.retryAfterSeconds); return }
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
