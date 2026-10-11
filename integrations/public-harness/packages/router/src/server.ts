/** Browser entry (loopback in development, a permission-restricted Unix socket in production) with identity and owner checks on every transport. */
import { chmod, chown, lstat, stat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { dirname } from 'node:path'
import type { UserId } from '@public-harness/contracts'
import { renderSelectorPage, renderStatusPage, type TeamLocale } from '@public-harness/ui'
import type { IdentityVerifier } from './config.ts'
import type { OwnerRoute } from './routes.ts'
import { DEFAULT_MAX_BODY_BYTES, forwardHttp, forwardUpgrade, type BrowserLaunch } from './proxy.ts'

/** Development ingress dependencies shared by HTTP requests and upgrades. */
export interface RouterServerConfig {
  /** Loopback bind for development; ignored (and must be omitted) when `listen` selects a Unix socket. */
  readonly host?: string
  /**
   * Production ingress: a Unix socket whose parent directory is owner-only (plus group traverse) and whose
   * only extra access is one group (the Caddy service account's group). Never combinable with a development selector.
   */
  readonly listen?: { readonly kind: 'unix'; readonly path: string; readonly gid: number }
  /** True when the browser-facing leg is HTTPS, so scoped Harness cookies carry `Secure`. Required for Unix ingress. */
  readonly secureCookies?: boolean
  /** Exact public authority (`host[:port]`); other Host values receive 421. Required for Unix ingress. */
  readonly publicAuthority?: string
  /** Largest request body forwarded to an instance (bytes); default 32 MiB. */
  readonly maxRequestBodyBytes?: number
  /** Largest request header block (bytes); default 16 KiB. */
  readonly maxHeaderBytes?: number
  /** Cookies owned by the router and removed before forwarding; defaults to the development identity cookie. */
  readonly stripCookies?: readonly string[]
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

async function privateParent(path: string): Promise<void> {
  const parent = await stat(dirname(path))
  if (!parent.isDirectory() || (parent.mode & 0o027) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('router socket requires a private directory owned by the router account')
  }
}

/** Open one browser listener: loopback TCP (development) or restricted Unix socket (production). */
export async function startRouterServer(config: RouterServerConfig): Promise<{ port: number; socketPath?: string; close(): Promise<void> }> {
  const unix = config.listen
  if (unix === undefined) {
    if (config.host !== '127.0.0.1') throw new Error('development router requires loopback')
  } else {
    if (process.platform === 'win32') throw new Error('Unix router sockets require Linux or macOS')
    if (config.host !== undefined) throw new Error('a Unix router must not also bind a TCP host')
    if (config.developmentSelector !== undefined) throw new Error('the development selector cannot run on the production ingress')
    if (config.secureCookies !== true) throw new Error('production ingress requires Secure cookies')
    if (!config.publicAuthority || !/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(config.publicAuthority)) throw new Error('production ingress requires the public authority')
    if (!Number.isSafeInteger(unix.gid) || unix.gid < 0) throw new Error('invalid router socket group')
  }
  if (!Number.isSafeInteger(config.maxSocketLifetimeMs) || config.maxSocketLifetimeMs <= 0
    || config.maxSocketLifetimeMs > 60_000) throw new Error('router socket lifetime must be at most 60 seconds')
  if (!Number.isSafeInteger(config.retryAfterSeconds) || config.retryAfterSeconds < 1) throw new Error('invalid router retry interval')
  const maxBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxHeaderBytes = config.maxHeaderBytes ?? 16_384
  for (const value of [maxBodyBytes, maxHeaderBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('router request limits must be positive')
  }
  const forwarding = { secure: config.secureCookies === true, maxBodyBytes, stripCookies: config.stripCookies ?? ['team_dev'] }
  const wrongHost = (request: IncomingMessage): boolean =>
    config.publicAuthority !== undefined && request.headers.host !== config.publicAuthority
  const sockets = new Set<Socket>()
  const server = createServer({ maxHeaderSize: maxHeaderBytes }, (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (wrongHost(request)) { response.writeHead(421).end(); return }
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
      forwardHttp(request, response, userId, route.endpoint, route.upstreamPath, config.launch, forwarding)
    })().catch(() => { if (!response.headersSent && !response.destroyed) response.writeHead(503).end() })
  })
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (wrongHost(request)) { socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'); return }
      let userId: UserId
      try { userId = await config.identity.verify(request.headers) }
      catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
      const route = await config.ownerRouter.route(request.url ?? '/', userId)
      if (route.kind !== 'ready') {
        const status = route.kind === 'rejected' ? route.status : 503
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
        return
      }
      forwardUpgrade(request, socket, head, route.endpoint, route.upstreamPath, config.maxSocketLifetimeMs, forwarding.stripCookies)
    })().catch(() => socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  if (unix !== undefined) {
    await privateParent(unix.path)
    const stale = await lstat(unix.path).catch(() => undefined)
    if (stale !== undefined) {
      if (!stale.isSocket()) throw new Error('refusing to replace a non-socket path')
      await unlink(unix.path)
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (unix !== undefined) server.listen(unix.path, () => { server.off('error', reject); resolve() })
    else server.listen(0, config.host, () => { server.off('error', reject); resolve() })
  })
  if (unix !== undefined) {
    try { await chown(unix.path, process.getuid!(), unix.gid); await chmod(unix.path, 0o660) }
    catch (error) { server.close(); throw error }
  }
  let closing: Promise<void> | undefined
  return { port: unix === undefined ? (server.address() as AddressInfo).port : 0, ...unix === undefined ? {} : { socketPath: unix.path },
    close() {
      return closing ??= (async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        if (unix !== undefined) await unlink(unix.path).catch(() => {})
      })()
    } }
}
