/**
 * Provisioner-facing MarketBridge over the plugins control Unix socket
 * (`POST /control/open` / `POST /control/close`).
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { once } from 'node:events'

export interface PluginsMarketBridge {
  open(userId: string, instanceId: string, accountUid?: number): Promise<{
    readonly port: number
    readonly token: string
    readonly marketOnly?: boolean
  }>
  close(userId: string): Promise<void>
}

async function controlCall(
  socketPath: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const payload = Buffer.from(JSON.stringify(body))
  const req = httpRequest({
    socketPath,
    path,
    method,
    headers: {
      host: 'plugins.invalid',
      'content-type': 'application/json',
      'content-length': payload.byteLength,
    },
  })
  const responsePromise = once(req, 'response') as Promise<[IncomingMessage]>
  req.write(payload)
  req.end()
  const [res] = await responsePromise
  const chunks: Buffer[] = []
  for await (const chunk of res) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown = text
  try { parsed = text === '' ? null : JSON.parse(text) } catch { /* keep */ }
  return { status: res.statusCode ?? 0, body: parsed }
}

/**
 * HTTP client for `DSH_PLUGINS_SOCKET` / provisioner control verbs.
 * Tracks the last opened instanceId per userId so `close(userId)` can target it.
 */
export function createPluginsMarketBridge(socketPath: string): PluginsMarketBridge {
  const openInstances = new Map<string, string>()
  return {
    async open(userId, instanceId, accountUid = 0) {
      const result = await controlCall(socketPath, 'POST', '/control/open', {
        userId,
        instanceId,
        accountUid,
      })
      if (result.status !== 200) {
        throw new Error(`plugins control open failed: ${result.status}`)
      }
      const body = result.body as { port?: unknown; token?: unknown; marketOnly?: unknown }
      if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65_535) {
        throw new Error('invalid plugins open response')
      }
      if (typeof body.token !== 'string' || body.token.length < 16) {
        throw new Error('invalid plugins open response')
      }
      openInstances.set(userId, instanceId)
      return {
        port: body.port,
        token: body.token,
        ...(body.marketOnly === true ? { marketOnly: true as const } : {}),
      }
    },
    async close(userId) {
      const instanceId = openInstances.get(userId)
      if (instanceId === undefined) return
      openInstances.delete(userId)
      await controlCall(socketPath, 'POST', '/control/close', { instanceId })
    },
  }
}
