/** Production plugin market profile (`dsh --profile plugins`, unit `dsh-plugins.service`):
 * catalogue + loopback listeners (LISTEN_FDS or listenPort) with peerCheck always on,
 * plus the Unix control socket for identity / provisioner. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createCatalogueMarketRouteDeps,
  defaultLookupOptions,
  lookupEndpointByPort,
  openPluginsDb,
  readInheritedListenFds,
  seedPluginLimits,
  startMarketHttpServer,
  startMarketHttpServersFromListenFds,
  startPluginsControlServer,
  validateMarketPorts,
  type MarketHttpServer,
  type MarketHttpServerOptions,
  type PeerCheckHooks,
  type PluginsControlServer,
  type PluginsDb,
} from '@public-harness/plugins'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

// Re-export productionMarketListenOptions from a local helper (keeps peerCheck force-on).
export interface PluginsProfileConfig {
  readonly database: string
  readonly storeDir: string
  readonly ports: { readonly market: { readonly min: number; readonly max: number } }
  /**
   * Unix control socket for identity (`DSH_PLUGINS_SOCKET`) and provisioner verbs.
   * Default production path: `/run/dsh-plugins/control.sock`.
   */
  readonly controlSocket: string
  /** Optional group ownership for the control socket (identity is in `dsh-plugins-clients`). */
  readonly controlSocketGid?: number
  /**
   * Single bind port for tests / non-socket-activation boots. Production inherits fds from
   * `dsh-plugins.socket` via `LISTEN_FDS`. Starting without LISTEN_FDS or listenPort is refused.
   */
  readonly listenPort?: number
  /** Optional pasta / container host address for reconcile-plan registry URLs. */
  readonly hostAddress?: string
}

function portRange(value: unknown): { min: number; max: number } {
  return validateMarketPorts(value as { min: number; max: number })
}

/**
 * Strict parse of the plugins profile file (ports.market + controlSocket required).
 * Shared `/etc/dsh-public/plugins.json` also carries `egressPort` / `egress` for
 * `dsh-plugins-fetch@.service`; catalogue allows and ignores those keys so one
 * file can start both units (B4).
 */
export function parsePluginsProfileConfig(value: unknown): PluginsProfileConfig {
  const raw = value as Record<string, unknown> | null
  const optional = ['listenPort', 'controlSocketGid', 'hostAddress', 'egressPort', 'egress'].filter(
    key => typeof raw === 'object' && raw !== null && key in raw,
  )
  const record = exactRecord(
    value,
    ['database', 'storeDir', 'ports', 'controlSocket', ...optional],
    'plugins configuration',
  )
  const ports = exactRecord(record.ports, ['market'], 'plugins ports')
  const market = portRange(ports.market)
  const listenPort = record.listenPort
  if (listenPort !== undefined) {
    if (typeof listenPort !== 'number' || !Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
      throw new Error('listenPort must be a TCP port or 0')
    }
  }
  const controlSocketGid = record.controlSocketGid
  if (controlSocketGid !== undefined) {
    if (typeof controlSocketGid !== 'number' || !Number.isSafeInteger(controlSocketGid) || controlSocketGid < 0) {
      throw new Error('controlSocketGid must be a non-negative integer')
    }
  }
  const hostAddress = record.hostAddress
  if (hostAddress !== undefined && (typeof hostAddress !== 'string' || hostAddress.length === 0)) {
    throw new Error('hostAddress must be a non-empty string')
  }
  return {
    database: absolutePath(record.database, 'database'),
    storeDir: absolutePath(record.storeDir, 'storeDir'),
    ports: { market },
    controlSocket: absolutePath(record.controlSocket, 'controlSocket'),
    ...listenPort === undefined ? {} : { listenPort: listenPort as number },
    ...controlSocketGid === undefined ? {} : { controlSocketGid: controlSocketGid as number },
    ...hostAddress === undefined ? {} : { hostAddress: hostAddress as string },
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

export interface ProductionPluginsAssembly {
  readonly db: PluginsDb
  readonly marketServers: readonly MarketHttpServer[]
  readonly control: PluginsControlServer
  close(): Promise<void>
}

export interface StartProductionPluginsOptions {
  readonly config: PluginsProfileConfig
  /** Injected for tests; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv
  readonly groupsFor?: (userId: string) => readonly string[]
  readonly peerCheckOverride?: PeerCheckHooks
  readonly principalGroups?: Map<string, readonly string[]>
  readonly log?: (line: string) => void
}

/**
 * Wire real catalogue adapters + control socket. Refuses to start when neither
 * `LISTEN_FDS` nor `listenPort` is available (no empty-stub production path).
 */
export async function startProductionPlugins(options: StartProductionPluginsOptions): Promise<ProductionPluginsAssembly> {
  const { config } = options
  const env = options.env ?? process.env
  const db = openPluginsDb(config.database)
  seedPluginLimits(db)

  const groupsFor = options.groupsFor ?? ((userId: string) => options.principalGroups?.get(userId) ?? [])
  const principalGroups = options.principalGroups ?? new Map<string, readonly string[]>()

  const inherited = readInheritedListenFds(env)
  const marketServers: MarketHttpServer[] = []

  const peerBase = {
    peerCheck: options.peerCheckOverride ?? {
      ownerUidForPort: (port: number) => lookupEndpointByPort(db, port)?.accountUid,
    },
    peerLookup: defaultLookupOptions(),
  }

  if (inherited.length > 0) {
    const servers = await startMarketHttpServersFromListenFds(inherited, {
      host: '127.0.0.1',
      ...peerBase,
      depsForPort: (port) => createCatalogueMarketRouteDeps({
        db,
        storeDir: config.storeDir,
        listenPort: port,
        registryUrlFor: () => `http://127.0.0.1:${port}/npm/`,
        groupsFor,
      }),
    })
    marketServers.push(...servers)
  } else if (config.listenPort !== undefined) {
    const port = config.listenPort
    const bound = { port }
    const deps = createCatalogueMarketRouteDeps({
      db,
      storeDir: config.storeDir,
      listenPort: port === 0 ? 0 : port,
      registryUrlFor: (userId) => {
        const endpoint = db.db.prepare('SELECT port FROM plugin_endpoint WHERE user_id = ?').get(userId) as
          | { port: number }
          | undefined
        return `http://127.0.0.1:${endpoint?.port ?? bound.port}/npm/`
      },
      groupsFor,
    })
    const server = await startProductionMarketServer(db, {
      port,
      ...deps,
      lookup: () => lookupEndpointByPort(db, bound.port),
      peerCheckOverride: options.peerCheckOverride,
    })
    bound.port = server.port
    marketServers.push(server)
  } else {
    db.close()
    throw new Error(
      'plugins service refused to start: need LISTEN_FDS (systemd socket activation) or listenPort; empty-stub catalogue serving is not allowed',
    )
  }

  const control = await startPluginsControlServer(
    {
      db,
      storeDir: config.storeDir,
      ports: config.ports.market,
      groupsFor,
      principalGroups,
      hostAddress: config.hostAddress ?? '127.0.0.1',
      log: options.log,
    },
    {
      path: config.controlSocket,
      ...(config.controlSocketGid !== undefined ? { gid: config.controlSocketGid, mode: 0o660 } : { mode: 0o600 }),
    },
  )

  return {
    db,
    marketServers,
    control,
    async close() {
      await control.close()
      for (const server of marketServers) await server.close()
      db.close()
    },
  }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-plugins-service'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile plugins`. Always wires peerCheck + real catalogue; never empty stubs. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const parsed = parsePluginsProfileConfig(await readConfigFile(config.configFile))
  const assembly = await startProductionPlugins({ config: parsed })
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => {
    await assembly.close()
  }, 'public-harness.plugins-service')
}
