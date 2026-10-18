/** Production quota profile: holds the platform key and exposes a private control socket to the provisioner, plus optional account (identity) and job (knowledge base) sockets. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createQuotaService, validateQuotaServiceConfig, type QuotaServiceConfig } from '@public-harness/quota/service'
import { startQuotaControlServer, startQuotaJobServer } from '@public-harness/quota/control'
import { startQuotaAccountServer } from '@public-harness/quota/account'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

/** Quota service settings plus the control-socket path and, optionally, the identity service's account socket and its group. */
export interface QuotaProfileConfig {
  readonly controlSocket: string
  readonly service: QuotaServiceConfig
  /** Private socket identity uses for personal usage and administrator allowance edits. */
  readonly accountSocket?: string
  /** Group (the identity service's) allowed to connect to `accountSocket`. */
  readonly accountSocketGid?: number
  /** Private socket of the knowledge base service: compile job channels only (open-job, issue, close-job for `kbjob-` ids). */
  readonly jobSocket?: string
  /** Group (shared by `dsh-kb` and `dsh-quota`) allowed to connect to `jobSocket`. */
  readonly jobSocketGid?: number
}

const SERVICE_KEYS = ['stateDir', 'upstreamRoot', 'platformKeyFile', 'tokenSecretFile', 'healthSecretFile', 'modelId', 'contextWindow', 'maxOutputTokens',
  'personalDailyTokens', 'siteDailyTokens', 'personalConcurrency', 'siteConcurrency', 'busyTimeoutMs', 'maxBodyBytes', 'maxImagesPerRequest',
  'maxInlineImageBytes', 'maxEventBytes', 'maxFileBodyBytes', 'maxFilesPerUser', 'maxFileMetadataBytes', 'maxFileListLimit', 'credentialLifetimeMs', 'listenPorts']

/** Strict parse; the quota service re-validates every limit at startup. */
export function parseQuotaProfileConfig(value: unknown): QuotaProfileConfig {
  const raw = value as Record<string, unknown> | null
  const optional = ['accountSocket', 'accountSocketGid', 'jobSocket', 'jobSocketGid'].filter(key => typeof raw === 'object' && raw !== null && key in raw)
  if (optional.includes('accountSocketGid') && !optional.includes('accountSocket')) throw new Error('accountSocketGid needs accountSocket')
  if (optional.includes('jobSocketGid') && !optional.includes('jobSocket')) throw new Error('jobSocketGid needs jobSocket')
  const record = exactRecord(value, ['controlSocket', 'service', ...optional], 'quota configuration')
  const service = exactRecord(record.service, SERVICE_KEYS, 'quota service') as unknown as QuotaServiceConfig
  validateQuotaServiceConfig(service)
  const gid = record.accountSocketGid
  if (gid !== undefined && (typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid < 0)) throw new Error('accountSocketGid must be a group id')
  const jobGid = record.jobSocketGid
  if (jobGid !== undefined && (typeof jobGid !== 'number' || !Number.isSafeInteger(jobGid) || jobGid < 0)) throw new Error('jobSocketGid must be a group id')
  return { controlSocket: absolutePath(record.controlSocket, 'controlSocket'), service,
    ...record.accountSocket === undefined ? {} : { accountSocket: absolutePath(record.accountSocket, 'accountSocket') },
    ...gid === undefined ? {} : { accountSocketGid: gid as number },
    ...record.jobSocket === undefined ? {} : { jobSocket: absolutePath(record.jobSocket, 'jobSocket') },
    ...jobGid === undefined ? {} : { jobSocketGid: jobGid as number } }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-quota-service'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile quota`. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const parsed = parseQuotaProfileConfig(await readConfigFile(config.configFile))
  const service = await createQuotaService(parsed.service)
  let control: Awaited<ReturnType<typeof startQuotaControlServer>>
  try { control = await startQuotaControlServer(parsed.controlSocket, service) }
  catch (error) { await service.shutdown(); throw error }
  let account: Awaited<ReturnType<typeof startQuotaAccountServer>> | undefined
  if (parsed.accountSocket !== undefined) {
    try { account = await startQuotaAccountServer(parsed.accountSocket, service.account, parsed.accountSocketGid === undefined ? undefined : { gid: parsed.accountSocketGid }) }
    catch (error) { await control.close(); await service.shutdown(); throw error }
  }
  let jobs: Awaited<ReturnType<typeof startQuotaJobServer>> | undefined
  if (parsed.jobSocket !== undefined) {
    try { jobs = await startQuotaJobServer(parsed.jobSocket, service, parsed.jobSocketGid === undefined ? undefined : { gid: parsed.jobSocketGid }) }
    catch (error) { await account?.close(); await control.close(); await service.shutdown(); throw error }
  }
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await jobs?.close(); await account?.close(); await control.close(); await service.shutdown() }, 'public-harness.quota-service')
}
