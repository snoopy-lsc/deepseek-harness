/** Production quota profile: holds the platform key and exposes a private control socket to the provisioner only. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createQuotaService, validateQuotaServiceConfig, type QuotaServiceConfig } from '@public-harness/quota/service'
import { startQuotaControlServer } from '@public-harness/quota/control'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

/** Quota service settings plus the control-socket path. */
export interface QuotaProfileConfig { readonly controlSocket: string; readonly service: QuotaServiceConfig }

const SERVICE_KEYS = ['stateDir', 'upstreamRoot', 'platformKeyFile', 'tokenSecretFile', 'healthSecretFile', 'modelId', 'contextWindow', 'maxOutputTokens',
  'personalDailyTokens', 'siteDailyTokens', 'personalConcurrency', 'siteConcurrency', 'busyTimeoutMs', 'maxBodyBytes', 'maxImagesPerRequest',
  'maxInlineImageBytes', 'maxEventBytes', 'maxFileBodyBytes', 'maxFilesPerUser', 'maxFileMetadataBytes', 'maxFileListLimit', 'credentialLifetimeMs', 'listenPorts']

/** Strict parse; the quota service re-validates every limit at startup. */
export function parseQuotaProfileConfig(value: unknown): QuotaProfileConfig {
  const record = exactRecord(value, ['controlSocket', 'service'], 'quota configuration')
  const service = exactRecord(record.service, SERVICE_KEYS, 'quota service') as unknown as QuotaServiceConfig
  validateQuotaServiceConfig(service)
  return { controlSocket: absolutePath(record.controlSocket, 'controlSocket'), service }
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
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await control.close(); await service.shutdown() }, 'public-harness.quota-service')
}
