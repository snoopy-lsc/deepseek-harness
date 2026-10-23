/** Per-user market port allocation and loopback HTTP listeners. */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PluginsDb } from './db.ts'
import { MAX_PLUGIN_ACCOUNTS } from './schema.ts'
import { handleMarketRequest, type MarketEndpointAuth, type MarketRouteDeps } from './routes.ts'
import { mintMarketToken } from './token.ts'

export interface MarketPortRange {
  readonly min: number
  readonly max: number
}

export interface OpenEndpointInput {
  readonly userId: string
  readonly instanceId: string
  readonly accountUid: number
  readonly ports: MarketPortRange
  readonly now?: number
}

export interface OpenEndpointResult {
  readonly port: number
  readonly token: string
}

export interface MarketHttpServer {
  readonly address: '127.0.0.1'
  readonly port: number
  close(): Promise<void>
}

export type MarketHttpServerOptions = {
  readonly host: string
  /** Fixed port, or `0` to let the OS choose (tests). */
  readonly port: number
} & MarketRouteDeps

/** Validate `ports.market`: 1024–32767 inclusive, at most 4096 ports. */
export function validateMarketPorts(range: MarketPortRange): MarketPortRange {
  const { min, max } = range
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new Error('ports.market must be an integer range')
  }
  if (min < 1024) throw new Error('ports.market min must be >= 1024')
  if (max > 32_767) throw new Error('ports.market max must be <= 32767')
  const count = max - min + 1
  if (count > MAX_PLUGIN_ACCOUNTS) {
    throw new Error(`ports.market may have at most ${MAX_PLUGIN_ACCOUNTS} ports (got ${count})`)
  }
  return range
}

function assertInstanceId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid instance identity')
}

function assertUserId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('invalid user id')
}

/**
 * Assign or confirm the user's stable market port, mint a fresh bearer token,
 * and store only its SHA-256 on `plugin_endpoint`.
 */
export function openEndpoint(db: PluginsDb, input: OpenEndpointInput): OpenEndpointResult {
  assertUserId(input.userId)
  assertInstanceId(input.instanceId)
  if (!Number.isSafeInteger(input.accountUid) || input.accountUid < 0) throw new Error('invalid account uid')
  const ports = validateMarketPorts(input.ports)
  const now = input.now ?? Date.now()
  const { token, tokenSha256 } = mintMarketToken()

  const existing = db.db.prepare(
    'SELECT port FROM plugin_endpoint WHERE user_id = ?',
  ).get(input.userId) as { port: number } | undefined

  if (existing !== undefined) {
    db.db.prepare(
      `UPDATE plugin_endpoint
       SET instance_id = ?, account_uid = ?, token_sha256 = ?, opened_at = ?
       WHERE user_id = ?`,
    ).run(input.instanceId, input.accountUid, tokenSha256, now, input.userId)
    return { port: existing.port, token }
  }

  const taken = new Set(
    (db.db.prepare('SELECT port FROM plugin_endpoint').all() as { port: number }[]).map(row => row.port),
  )
  let port: number | undefined
  for (let candidate = ports.min; candidate <= ports.max; candidate += 1) {
    if (!taken.has(candidate)) {
      port = candidate
      break
    }
  }
  if (port === undefined) throw new Error('no free market port in ports.market (range exhausted)')

  db.db.prepare(
    `INSERT INTO plugin_endpoint (user_id, port, instance_id, account_uid, token_sha256, opened_at, last_report)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(input.userId, port, input.instanceId, input.accountUid, tokenSha256, now)

  return { port, token }
}

/** Clear the token when the instance stops; keep the port for the account. */
export function closeEndpoint(db: PluginsDb, instanceId: string): void {
  assertInstanceId(instanceId)
  db.db.prepare(
    `UPDATE plugin_endpoint
     SET instance_id = NULL, token_sha256 = NULL
     WHERE instance_id = ?`,
  ).run(instanceId)
}

/** Look up the endpoint row for a bound port (used by multi-port accept later). */
export function lookupEndpointByPort(db: PluginsDb, port: number): MarketEndpointAuth | undefined {
  const row = db.db.prepare(
    'SELECT user_id, account_uid, token_sha256 FROM plugin_endpoint WHERE port = ?',
  ).get(port) as { user_id: string; account_uid: number | null; token_sha256: string | null } | undefined
  if (row === undefined || row.account_uid === null) return undefined
  return { userId: row.user_id, accountUid: row.account_uid, tokenSha256: row.token_sha256 }
}

/** Start one loopback-only market HTTP listener. */
export async function startMarketHttpServer(options: MarketHttpServerOptions): Promise<MarketHttpServer> {
  if (options.host !== '127.0.0.1') throw new Error('market HTTP server requires host 127.0.0.1 (loopback only)')
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('market HTTP port must be a safe integer in 0..65535')
  }

  const deps: MarketRouteDeps = {
    lookup: options.lookup,
    buildIndex: options.buildIndex,
    lookupPackument: options.lookupPackument,
    lookupTarball: options.lookupTarball,
  }

  const server: Server = createServer((request, response) => {
    void handleMarketRequest(request, response, deps).catch(() => {
      if (!response.headersSent) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end('{"error":"not-found"}')
      } else {
        response.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    address: '127.0.0.1',
    port: address.port,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}
