/** Production plugin market profile (`dsh --profile plugins`, unit `dsh-plugins.service`): catalogue + loopback listeners with peerCheck always on. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  defaultLookupOptions,
  lookupEndpointByPort,
  openPluginsDb,
  startMarketHttpServer,
  validateMarketPorts,
  type MarketHttpServer,
  type MarketHttpServerOptions,
  type PeerCheckHooks,
  type PluginsDb,
} from '@public-harness/plugins'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

/** Profile settings for `dsh-plugins`. */
export interface PluginsProfileConfig {
  readonly database: string
  readonly storeDir: string
  readonly ports: { readonly market: { readonly min: number; readonly max: number } }
  /**
   * Single bind port for tests / non-socket-activation boots. Production inherits fds from
   * `dsh-plugins.socket` (LISTEN_FDS); multi-fd accept lands with socket-activation wiring.
   */
  readonly listenPort?: number
}

function portRange(value: unknown, name: string): { min: number; max: number } {
  return validateMarketPorts(value as { min: number; max: number })
}

/** Strict parse of the plugins profile file (ports.market required). */
export function parsePluginsProfileConfig(value: unknown): PluginsProfileConfig {
  const raw = value as Record<string, unknown> | null
  const optional = ['listenPort'].filter(key => typeof raw === 'object' && raw !== null && key in raw)
  const record = exactRecord(value, ['database', 'storeDir', 'ports', ...optional], 'plugins configuration')
  const ports = exactRecord(record.ports, ['market'], 'plugins ports')
  const market = portRange(ports.market, 'ports.market')
  const listenPort = record.listenPort
  if (listenPort !== undefined) {
    if (typeof listenPort !== 'number' || !Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
      throw new Error('listenPort must be a TCP port or 0')
    }
  }
  return {
    database: absolutePath(record.database, 'database'),
    storeDir: absolutePath(record.storeDir, 'storeDir'),
    ports: { market },
    ...listenPort === undefined ? {} : { listenPort: listenPort as number },
  }
}

type MarketBase = Omit<MarketHttpServerOptions, 'peerCheck' | 'peerLookup' | 'host'> & {
  readonly host?: '127.0.0.1'
  /** Tests may replace hooks; production never omits peerCheck. */
  readonly peerCheckOverride?: PeerCheckHooks
}

/** Build listen options that **always** include peerCheck + defaultLookupOptions (production default). */
export function productionMarketListenOptions(db: PluginsDb, base: MarketBase): MarketHttpServerOptions {
  const { peerCheckOverride, host: _host, ...rest } = base
  return {
    ...rest,
    host: '127.0.0.1',
    peerCheck: peerCheckOverride ?? {
      ownerUidForPort: (port) => lookupEndpointByPort(db, port)?.accountUid,
    },
    peerLookup: defaultLookupOptions(),
  }
}

/** Start one loopback market HTTP server with peerCheck enforced. */
export async function startProductionMarketServer(db: PluginsDb, base: MarketBase): Promise<MarketHttpServer> {
  return startMarketHttpServer(productionMarketListenOptions(db, base))
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-plugins-service'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile plugins`. Always wires peerCheck; never optional. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const parsed = parsePluginsProfileConfig(await readConfigFile(config.configFile))
  const db = openPluginsDb(parsed.database)
  const port = parsed.listenPort ?? 0
  // Minimal route deps until catalogue serving is fully wired through this profile.
  const server = await startProductionMarketServer(db, {
    port,
    lookup: () => (port === 0 ? undefined : lookupEndpointByPort(db, port)),
    buildIndex: () => ({ format: 1 as const, plugins: [] }),
    lookupPackument: () => undefined,
    lookupTarball: () => undefined,
  })
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => {
    await server.close()
    db.close()
  }, 'public-harness.plugins-service')
}
