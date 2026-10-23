/** Production profile entry for `dsh-plugins-egress`: allowlisting CONNECT proxy for the fetch service. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startEgressProxy } from '@public-harness/plugins'
import { exactRecord, readConfigFile } from './config-file.ts'

/** Egress settings taken from `plugins.json` (other catalogue keys are ignored here). */
export interface PluginsEgressConfig {
  readonly egressPort: number
  readonly allow: readonly string[]
  readonly intranet: Readonly<Record<string, readonly string[]>>
}

function port(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port`)
  }
  return value
}

/** Read `egressPort` and `egress.{allow,intranet}` from the plugins configuration object. */
export function parsePluginsEgressConfig(value: unknown): PluginsEgressConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('plugins egress configuration must be an object')
  }
  const record = value as Record<string, unknown>
  if (!('egressPort' in record) || !('egress' in record)) {
    throw new Error('plugins egress configuration needs egressPort and egress')
  }
  const egress = exactRecord(record.egress, ['allow', 'intranet'], 'egress')
  if (!Array.isArray(egress.allow) || egress.allow.some(host => typeof host !== 'string' || host.length === 0)) {
    throw new Error('egress.allow must be a list of host names')
  }
  if (typeof egress.intranet !== 'object' || egress.intranet === null || Array.isArray(egress.intranet)) {
    throw new Error('egress.intranet must be a host-to-CIDR map')
  }
  const intranet: Record<string, string[]> = {}
  for (const [host, cidrs] of Object.entries(egress.intranet)) {
    if (!Array.isArray(cidrs) || cidrs.some(cidr => typeof cidr !== 'string' || !cidr.includes('/'))) {
      throw new Error(`egress.intranet[${host}] must be a list of CIDRs`)
    }
    intranet[host] = cidrs as string[]
  }
  return { egressPort: port(record.egressPort, 'egressPort'), allow: egress.allow as string[], intranet }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-plugins-egress'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile plugins-egress`. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const parsed = parsePluginsEgressConfig(await readConfigFile(config.configFile))
  const proxy = await startEgressProxy({
    listen: '127.0.0.1',
    port: parsed.egressPort,
    allow: parsed.allow,
    intranet: parsed.intranet,
    fetchUidOnly: true,
  })
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await proxy.close() }, 'public-harness.plugins-egress')
}
