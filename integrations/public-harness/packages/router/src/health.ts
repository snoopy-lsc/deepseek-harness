/** Private router health and capacity signal: a Unix socket for operators, never part of the public listener. */
import { chmod, lstat, stat, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'

/** Aggregate-only health: no user IDs, prompts, tokens, or Session content. */
export interface RouterHealth { readonly ok: boolean; readonly activeInstances?: number; readonly maxActiveInstances?: number }

/** Serve `GET /health` on an owner-only Unix socket (mode 0600). */
export async function startRouterHealthServer(path: string, inspect: () => Promise<RouterHealth>): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('Unix health sockets require Linux or macOS')
  const parent = await stat(dirname(path))
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('health socket requires an owner-only private directory')
  }
  const stale = await lstat(path).catch(() => undefined)
  if (stale !== undefined) {
    if (!stale.isSocket()) throw new Error('refusing to replace a non-socket path')
    await unlink(path)
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return }
    inspect().then(report => {
      const body: RouterHealth = { ok: report.ok === true,
        ...report.activeInstances === undefined ? {} : { activeInstances: report.activeInstances },
        ...report.maxActiveInstances === undefined ? {} : { maxActiveInstances: report.maxActiveInstances } }
      response.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
    }, () => response.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}'))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  await chmod(path, 0o600)
  return { async close() {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await unlink(path).catch(() => {})
  } }
}
