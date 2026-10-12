/** Explicit native systemd runtime provider for the privileged production profile. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { request } from 'node:http'
import { apply as registerSystemdRuntime } from '@public-harness/runtime-systemd/index'
import { createQuotaControlClient } from '@public-harness/quota/control'
import { readConfigFile } from './config-file.ts'
import { parseProvisionerProfileConfig } from './provisioner-service.ts'

/** Authenticated readiness: the instance's Web server must exchange the published grant for one session cookie,
 * exactly as the router later does. A listener that merely accepts connections is not ready.
 * @param port Instance Web port on 127.0.0.1 (root is allowed only to this port by the owned nftables table).
 * @param grant Grant from the private readiness file; never logged.
 * @param timeoutMs Exchange bound.
 */
export function authenticatedWebProbe(port: number, grant: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: `/?token=${encodeURIComponent(grant)}`, agent: false,
      headers: { host: `127.0.0.1:${port}` } }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode === 303 && response.headers.location === './'
        && response.headers['set-cookie']?.length === 1))
      response.once('error', () => resolve(false))
    })
    req.setTimeout(timeoutMs, () => req.destroy())
    req.once('error', () => resolve(false))
    req.end()
  })
}

/** Stable Cordis provider name. */
export const name = 'public-harness-systemd-runtime'
/** Root-owned profile configuration file location. */
export interface PluginConfig { configFile: string }
/** Cordis configuration schema for the provider entry. */
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Mount the native provider from the same root-owned config as its consumer; the native companion file is the
 * one the common runtime selection names.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  if (process.platform !== 'linux') throw new Error('the native runtime provider runs only on Linux')
  const raw = await readConfigFile(config.configFile) as { provisioner?: unknown }
  const profile = parseProvisionerProfileConfig(raw)
  const selection = profile.provisioner.runtime
  if (selection.kind !== 'systemd') throw new Error('runtime selection is not systemd')
  await registerSystemdRuntime(ctx, { common: raw.provisioner, native: await readConfigFile(selection.configFile),
    quota: createQuotaControlClient(profile.quotaSocket), webProbe: (port, grant) => authenticatedWebProbe(port, grant) })
}
