/** Production composition: durable ledger, pinned upstream, instance-bound listeners, and a private control surface. */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { portsFrom, validatePortRange, type PortRange, type UserId } from '@public-harness/contracts'
import { createAdmission } from './admission.ts'
import { createFilesProxy } from './files.ts'
import { createRejectionCounter, inspectQuotaHealth, type QuotaHealth } from './health.ts'
import { createQuotaLedger } from './ledger.ts'
import { createMessagesForwarder } from './messages.ts'
import { startQuotaHttpServer } from './server.ts'
import { createTokenIssuer, type IssuedToken } from './tokens.ts'

/** Every limit is required and positive; secrets are file references, never inline values. */
export interface QuotaServiceConfig {
  /** Private directory for the ledger and file-ownership databases. */
  readonly stateDir: string
  /** Pinned HTTPS upstream root ending in `/v1`. */
  readonly upstreamRoot: string
  /** 0600 files holding the platform model key, the credential-signing secret (>= 32 bytes), and the health secret. */
  readonly platformKeyFile: string
  readonly tokenSecretFile: string
  readonly healthSecretFile: string
  readonly modelId: string
  readonly contextWindow: number
  /** Largest output per call; larger `max_tokens` requests are lowered to it (never above the context window). */
  readonly maxOutputTokens: number
  readonly personalDailyTokens: number
  readonly siteDailyTokens: number
  readonly personalConcurrency: number
  readonly siteConcurrency: number
  readonly busyTimeoutMs: number
  readonly maxBodyBytes: number
  readonly maxImagesPerRequest: number
  readonly maxInlineImageBytes: number
  readonly maxEventBytes: number
  readonly maxFileBodyBytes: number
  readonly maxFilesPerUser: number
  readonly maxFileMetadataBytes: number
  readonly maxFileListLimit: number
  readonly credentialLifetimeMs: number
  /**
   * Loopback ports for the instance listeners. The egress firewall allows instances to reach exactly this range on
   * 127.0.0.1 and nothing else on loopback, so it must equal `QUOTA_PORTS` in the nftables file and the provisioner's
   * `ports.quota`, and must not be used by any other service.
   */
  readonly listenPorts: PortRange
}

/** Startup checks: refuse to run with a missing, non-positive, or unsafe setting. */
export function validateQuotaServiceConfig(config: QuotaServiceConfig): void {
  for (const name of ['stateDir', 'platformKeyFile', 'tokenSecretFile', 'healthSecretFile'] as const) {
    if (!isAbsolute(config[name]) || config[name].includes('\0')) throw new Error(`${name} must be an absolute path`)
  }
  const upstream = new URL(config.upstreamRoot)
  if (upstream.protocol !== 'https:' || !upstream.pathname.endsWith('/v1') || upstream.search || upstream.hash
    || upstream.username || upstream.password) throw new Error('upstreamRoot must be a pinned HTTPS URL ending in /v1')
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(config.modelId)) throw new Error('modelId is invalid')
  for (const [name, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be a positive safe integer`)
  }
  validatePortRange(config.listenPorts, 'listenPorts')
  if (config.credentialLifetimeMs > 900_000) throw new Error('credentialLifetimeMs exceeds fifteen minutes')
  if (config.maxOutputTokens > config.contextWindow) throw new Error('maxOutputTokens must not exceed contextWindow')
  if (config.contextWindow > config.personalDailyTokens || config.contextWindow > config.siteDailyTokens) {
    throw new Error('daily budgets must admit one model request')
  }
}

async function secretFile(path: string, minimumBytes: number): Promise<Buffer> {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)) {
    throw new Error('secret files must be private regular files')
  }
  const bytes = Buffer.from((await readFile(path, 'utf8')).trim())
  if (bytes.length < minimumBytes) throw new Error('secret file is too short')
  return bytes
}

/** What the provisioner may ask of the quota service. */
export interface QuotaService {
  healthy(): Promise<boolean>
  inspect(): Promise<QuotaHealth>
  open(userId: UserId, instanceId: string): Promise<{ readonly port: number }>
  issue(userId: UserId, instanceId: string): IssuedToken
  close(userId: UserId): Promise<void>
  shutdown(): Promise<void>
  readonly healthSecret: string
}

/** Start the production quota service. The platform key never leaves this process. */
export async function createQuotaService(config: QuotaServiceConfig, options: { fetcher?: typeof fetch; clock?: () => Date } = {}): Promise<QuotaService> {
  validateQuotaServiceConfig(config)
  const platformKey = (await secretFile(config.platformKeyFile, 8)).toString()
  const tokenSecret = await secretFile(config.tokenSecretFile, 32)
  const healthSecret = (await secretFile(config.healthSecretFile, 16)).toString()
  const ledger = createQuotaLedger({ databasePath: join(config.stateDir, 'ledger.sqlite'),
    personalDailyTokens: config.personalDailyTokens, siteDailyTokens: config.siteDailyTokens,
    personalConcurrency: config.personalConcurrency, siteConcurrency: config.siteConcurrency, busyTimeoutMs: config.busyTimeoutMs }, options.clock)
  const issuer = createTokenIssuer({ secret: tokenSecret, issuer: 'production', lifetimeMs: config.credentialLifetimeMs, clock: options.clock })
  const files = createFilesProxy({ databasePath: join(config.stateDir, 'files.sqlite'), upstreamRoot: config.upstreamRoot, platformKey,
    maxUploadBytes: config.maxFileBodyBytes, maxFilesPerUser: config.maxFilesPerUser, maxMetadataBytes: config.maxFileMetadataBytes,
    maxListLimit: config.maxFileListLimit, fetcher: options.fetcher })
  const admission = createAdmission({ issuer, ledger, ownsFile: (userId, fileId) => files.owns(userId, fileId),
    config: { modelContextWindows: { [config.modelId]: config.contextWindow },
      modelMaxOutputTokens: { [config.modelId]: config.maxOutputTokens }, maxBodyBytes: config.maxBodyBytes,
      maxImagesPerRequest: config.maxImagesPerRequest, maxInlineImageBytes: config.maxInlineImageBytes } })
  const forwardMessages = createMessagesForwarder({ upstreamUrl: `${config.upstreamRoot}/messages`, platformKey,
    maxEventBytes: config.maxEventBytes, ledger, fetcher: options.fetcher })
  const counter = createRejectionCounter()
  const listeners = new Map<UserId, { close(): Promise<void> }>()
  let cursor = 0
  const inspect = (): Promise<QuotaHealth> => inspectQuotaHealth(ledger, counter)
  const closeListener = async (userId: UserId): Promise<void> => {
    const existing = listeners.get(userId)
    listeners.delete(userId)
    await existing?.close()
  }
  return {
    healthSecret, inspect,
    async healthy() { return (await inspect()).available },
    async open(userId, instanceId) {
      await closeListener(userId)
      // Take the first free port of the configured range, starting after the last one handed out.
      for (const port of portsFrom(config.listenPorts, cursor)) {
        let listener: Awaited<ReturnType<typeof startQuotaHttpServer>>
        try {
          listener = await startQuotaHttpServer({ host: '127.0.0.1', port, instanceId, issuer, admission, forwardMessages, files,
            maxBodyBytes: config.maxBodyBytes, maxFileBodyBytes: config.maxFileBodyBytes, rejections: counter,
            health: { secret: healthSecret, inspect } })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
          throw error
        }
        cursor = port - config.listenPorts.min + 1
        listeners.set(userId, listener)
        return { port: listener.port }
      }
      throw new Error('no free listener port in listenPorts')
    },
    issue: (userId, instanceId) => issuer.issue(userId, instanceId),
    close: closeListener,
    async shutdown() {
      await Promise.allSettled([...listeners.keys()].map(closeListener))
      files.close()
      ledger.close()
    },
  }
}
