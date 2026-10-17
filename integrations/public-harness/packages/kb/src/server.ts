/** The private HTTP surface of `dsh-kb`, served on a Unix socket only. Identity is the only client: it authenticates the browser,
 * enforces the admin and re-authentication rules, and forwards the acting user in `x-dsh-user`, `x-dsh-email` and `x-dsh-role`. */
import { chmod, chown, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { KbError } from './errors.ts'
import type { Actor } from './service.ts'

/** One request as a route sees it. */
export interface KbRequest {
  readonly actor: Actor
  readonly query: URLSearchParams
  /** Parsed JSON body (writes). */
  json(): Promise<Record<string, unknown>>
  /** Raw body, for uploads (`application/octet-stream`). */
  bytes(limit: number): Promise<Buffer>
}
export type KbRoute = (request: KbRequest) => Promise<unknown>
/** Routes keyed by `METHOD /path`. */
export type KbRoutes = Record<string, KbRoute>

const MAX_JSON = 256 * 1024
const ROLE = (value: string | string[] | undefined): 'admin' | 'member' => value === 'admin' ? 'admin' : 'member'
const USER = /^[A-Za-z0-9_-]{1,128}$/

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > limit) throw new KbError(413, 'body-too-large'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}

/** Build the request handler.
 * @param routes Route table.
 * @param log Diagnostics sink (never request bodies).
 * @returns Handler.
 */
export function kbHandler(routes: KbRoutes, log: (line: string) => void = () => {}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const send = (status: number, value: unknown) => {
        if (res.headersSent) { res.end(); return }
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      try {
        const url = new URL(req.url ?? '/', 'http://kb.invalid')
        const route = routes[`${req.method ?? 'GET'} ${url.pathname}`]
        if (route === undefined) throw new KbError(404, 'not-found')
        const user = req.headers['x-dsh-user']
        const internal = url.pathname.startsWith('/internal/')
        if (!internal && (typeof user !== 'string' || !USER.test(user))) throw new KbError(401, 'actor')
        const role = ROLE(req.headers['x-dsh-role'])
        if (url.pathname.startsWith('/admin/') && role !== 'admin') throw new KbError(403, 'forbidden')
        const email = typeof req.headers['x-dsh-email'] === 'string' ? req.headers['x-dsh-email'].slice(0, 320) : ''
        let parsed: Promise<Record<string, unknown>> | undefined
        const request: KbRequest = {
          actor: { userId: typeof user === 'string' ? user : 'system', email: email || (typeof user === 'string' ? user : 'system'), role },
          query: url.searchParams,
          json: () => parsed ??= (async () => {
            if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) throw new KbError(415, 'json-only')
            let value: unknown
            try { value = JSON.parse((await body(req, MAX_JSON)).toString('utf8') || '{}') } catch (error) { if (error instanceof KbError) throw error; throw new KbError(400, 'body') }
            if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new KbError(400, 'body')
            return value as Record<string, unknown>
          })(),
          bytes: async limit => {
            if (!/^application\/octet-stream(;|$)/.test(req.headers['content-type'] ?? '')) throw new KbError(415, 'octet-stream-only')
            return body(req, limit)
          },
        }
        send(200, await route(request) ?? {})
      } catch (error) {
        if (error instanceof KbError) { send(error.status, { code: error.code, ...error.extra }); return }
        log(`kb: request failed: ${(error as Error).message.slice(0, 200)}`)
        send(500, { code: 'internal' })
      }
    })()
  }
}

/** Listen on a Unix socket with the given mode and optional group; any stale socket file is replaced. */
export async function listenKbSocket(handler: ReturnType<typeof kbHandler>, path: string, mode = 0o600, gid?: number): Promise<Server> {
  await rm(path, { force: true })
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  await chmod(path, mode)
  if (gid !== undefined) await chown(path, process.getuid?.() ?? -1, gid)
  return server
}
