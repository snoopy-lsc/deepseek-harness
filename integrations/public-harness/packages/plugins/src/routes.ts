/** HTTP route dispatch for one market listener (index + read-only npm registry + sync). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bearerMatches } from './token.ts'
import type { ApplySyncReportResult, SyncPlan } from './sync-plan.ts'
import { SyncPlanError } from './sync-plan.ts'

/** Endpoint row needed to authorize npm / sync routes on this listener. */
export interface MarketEndpointAuth {
  readonly userId: string
  readonly accountUid: number
  readonly tokenSha256: string | null
}

export interface MarketRouteDeps {
  readonly lookup: () => MarketEndpointAuth | undefined
  readonly buildIndex: (userId: string) => unknown
  readonly lookupPackument: (name: string, userId: string) => unknown | undefined
  readonly lookupTarball: (name: string, version: string, userId: string) => Buffer | undefined
  /** Optional: wired when sync plan API is enabled (1D.2). */
  readonly buildSyncPlan?: (userId: string) => SyncPlan
  /** Optional: wired when sync report API is enabled (1D.2). */
  readonly applySyncReport?: (userId: string, report: unknown) => ApplySyncReportResult
}

const NOT_FOUND_BODY = '{"error":"not-found"}'
const NOT_FOUND_TYPE = 'application/json; charset=utf-8'
const MAX_REPORT_BYTES = 1024 * 1024

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  const length = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body)
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

function notFound(response: ServerResponse): void {
  send(response, 404, NOT_FOUND_BODY, NOT_FOUND_TYPE)
}

/** Decode npm package name from `/npm/...` path (accepts `%2F`, `%2f`, and `/`). */
export function parseNpmName(pathname: string): { name: string; rest: string } | undefined {
  if (!pathname.startsWith('/npm/')) return undefined
  const raw = pathname.slice('/npm/'.length)
  if (raw.length === 0) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  if (decoded.startsWith('@')) {
    const slash = decoded.indexOf('/')
    if (slash <= 1) return undefined
    const scope = decoded.slice(0, slash)
    const after = decoded.slice(slash + 1)
    const tarball = after.indexOf('/-/')
    if (tarball === -1) return { name: `${scope}/${after}`, rest: '' }
    return { name: `${scope}/${after.slice(0, tarball)}`, rest: after.slice(tarball) }
  }
  const tarball = decoded.indexOf('/-/')
  if (tarball === -1) return { name: decoded, rest: '' }
  return { name: decoded.slice(0, tarball), rest: decoded.slice(tarball) }
}

/** Parse `/-/<basename>-<version>.tgz` into the version string. */
export function parseTarballVersion(rest: string, packageName: string): string | undefined {
  if (!rest.startsWith('/-/') || !rest.endsWith('.tgz')) return undefined
  const file = rest.slice('/-/'.length, -'.tgz'.length)
  const base = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName
  const prefix = `${base}-`
  if (!file.startsWith(prefix)) return undefined
  const version = file.slice(prefix.length)
  return version.length > 0 ? version : undefined
}

function singleAuthorization(request: IncomingMessage): string | undefined {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') count += 1
  }
  if (count !== 1 || typeof request.headers.authorization !== 'string') return undefined
  return request.headers.authorization
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) throw new SyncPlanError('bad-report', 'body-too-large', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new SyncPlanError('bad-report', 'json')
  }
}

/** Handle one HTTP request on a market port. Never redirects. */
export async function handleMarketRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: MarketRouteDeps,
): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Sync report is the only POST on the market listener.
  if (method === 'POST' && pathname === '/sync/report') {
    const endpoint = deps.lookup()
    const authorization = singleAuthorization(request)
    if (
      endpoint === undefined
      || deps.applySyncReport === undefined
      || !bearerMatches(authorization, endpoint.tokenSha256)
    ) {
      notFound(response)
      return
    }
    try {
      const body = await readJsonBody(request, MAX_REPORT_BYTES)
      const result = deps.applySyncReport(endpoint.userId, body)
      send(response, 200, JSON.stringify(result), 'application/json; charset=utf-8')
    } catch (error) {
      if (error instanceof SyncPlanError) {
        send(
          response,
          error.status,
          JSON.stringify({ error: error.code, detail: error.detail }),
          'application/json; charset=utf-8',
        )
        return
      }
      notFound(response)
    }
    return
  }

  if (method !== 'GET' && method !== 'HEAD') {
    notFound(response)
    return
  }

  const endpoint = deps.lookup()

  if (pathname === '/index.json') {
    if (endpoint === undefined) {
      notFound(response)
      return
    }
    const body = JSON.stringify(deps.buildIndex(endpoint.userId))
    if (method === 'HEAD') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    send(response, 200, body, 'application/json; charset=utf-8')
    return
  }

  if (pathname === '/sync') {
    const authorization = singleAuthorization(request)
    if (
      endpoint === undefined
      || deps.buildSyncPlan === undefined
      || !bearerMatches(authorization, endpoint.tokenSha256)
    ) {
      notFound(response)
      return
    }
    const body = JSON.stringify(deps.buildSyncPlan(endpoint.userId))
    if (method === 'HEAD') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    send(response, 200, body, 'application/json; charset=utf-8')
    return
  }

  const npm = parseNpmName(pathname)
  if (npm !== undefined) {
    // Same 404 body for missing auth, wrong token, unseen listing, and missing package.
    const authorization = singleAuthorization(request)
    if (endpoint === undefined || !bearerMatches(authorization, endpoint.tokenSha256)) {
      notFound(response)
      return
    }
    if (npm.rest === '') {
      const packument = deps.lookupPackument(npm.name, endpoint.userId)
      if (packument === undefined) {
        notFound(response)
        return
      }
      const body = JSON.stringify(packument)
      send(response, 200, body, 'application/json; charset=utf-8')
      return
    }
    const version = parseTarballVersion(npm.rest, npm.name)
    if (version === undefined) {
      notFound(response)
      return
    }
    const tarball = deps.lookupTarball(npm.name, version, endpoint.userId)
    if (tarball === undefined) {
      notFound(response)
      return
    }
    send(response, 200, tarball, 'application/octet-stream')
    return
  }

  notFound(response)
}
