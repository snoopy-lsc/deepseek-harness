/** Explicit container runtime provider for the privileged production profile. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { apply as registerContainerRuntime } from '@public-harness/provisioner/runtime-provider'
import { createQuotaControlClient } from '@public-harness/quota/control'
import { createPluginsMarketBridge } from '@public-harness/plugins'
import { readConfigFile } from './config-file.ts'
import { parseProvisionerProfileConfig } from './provisioner-service.ts'

/** Probe controllers delegated to the rootless container account's user manager.
 * @param uid Provisioned account UID.
 * @returns Delegated controller names; missing host files reject.
 */
export async function cgroupControllers(uid: number): Promise<string[]> {
  const text = await readFile(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, 'utf8')
  return text.trim().split(/\s+/)
}
/** Stable Cordis provider name. */
export const name = 'public-harness-container-runtime'
/** Root-owned profile configuration file location. */
export interface PluginConfig { configFile: string }
/** Cordis configuration schema for the provider entry. */
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Mount the container provider from the same root-owned config as its consumer.
 * @param ctx Owning Cordis context.
 * @param config Configuration file location.
 * @returns Resolves after validation and service registration; no instance is started.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  if (process.platform !== 'linux') throw new Error('the container runtime provider runs only on Linux')
  const profile = parseProvisionerProfileConfig(await readConfigFile(config.configFile))
  registerContainerRuntime(ctx, {
    config: profile.provisioner,
    publicHost: profile.publicHost,
    quota: createQuotaControlClient(profile.quotaSocket),
    probe: { controllers: cgroupControllers },
    ...(profile.pluginsSocket === undefined ? {} : { market: createPluginsMarketBridge(profile.pluginsSocket) }),
  })
}
