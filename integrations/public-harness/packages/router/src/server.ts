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
  readonly developmentSelector?: { readonly users: readonly UserId[]; issue(userId: string): string }
}

const selectorCopy = {
  en: { title: 'Choose a test user', caption: 'Local development only' },
  zh: { title: '选择测试用户', caption: '仅用于本机开发' },
} as const

function selectorPage(users: readonly UserId[], chinese: boolean): string {
  const copy = selectorCopy[chinese ? 'zh' : 'en']
  const links = users.map(userId => `<li><a href="/dev/select/${userId}">${userId}</a></li>`).join('')
  return `<!doctype html><html lang="${chinese ? 'zh' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${copy.title}</title><style>body{font:16px system-ui,sans-serif;background:#f7f8fb;color:#1c2330;margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(28rem,calc(100vw - 2rem));padding:2rem;border:1px solid #d7dce5;border-radius:1rem;background:#fff;box-shadow:0 12px 32px #17294a12}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#526174;margin:0 0 1.5rem}ul{list-style:none;padding:0;margin:0;display:grid;gap:.75rem}a{display:block;padding:.8rem 1rem;border:1px solid #b8c5d8;border-radius:.6rem;color:#174c91;text-decoration:none}a:hover,a:focus-visible{background:#eaf2ff;outline:2px solid #2d6ac4;outline-offset:2px}@media(prefers-color-scheme:dark){body{background:#101722;color:#f3f6fb}main{background:#1a2534;border-color:#3b4b60}p{color:#b4c1d1}a{border-color:#60748f;color:#a8c9ff}a:hover,a:focus-visible{background:#233b59}}</style><main><h1>${copy.title}</h1><p>${copy.caption}</p><ul>${links}</ul></main></html>`
}

function selectDevelopmentUser(request: IncomingMessage, response: ServerResponse,
  selector: NonNullable<RouterServerConfig['developmentSelector']>): boolean {
  if (request.method !== 'GET') return false
  if (request.url === '/dev') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(selectorPage(selector.users, request.headers['accept-language']?.includes('zh') ?? false))
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
