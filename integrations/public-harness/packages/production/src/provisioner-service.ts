/** Provisioner profile: the only privileged component; runs from its own `dsh` profile as root on the Linux host. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startAdminServer } from '@public-harness/provisioner/admin'
import { validateProvisionerConfig, type ProvisionerConfig } from '@public-harness/provisioner/config'
import { startProvisionerServer } from '@public-harness/provisioner/protocol'
import { createProvisionerService, type ProvisionerService } from '@public-harness/provisioner/service'
import type { QuotaBridge } from '@public-harness/provisioner/runtime'
import { createQuotaControlClient } from '@public-harness/quota/control'
import { readFile } from 'node:fs/promises'
import { absolutePath, exactRecord, positiveInt, readConfigFile } from './config-file.ts'

/** Sockets and cadences around the provisioner configuration. */
export interface ProvisionerProfileConfig {
  readonly controlSocket: string
  readonly adminSocket: string
  readonly quotaSocket: string
  readonly publicHost: string
  readonly reconcileIntervalMs: number
  readonly provisioner: ProvisionerConfig
}

/** Strict parse; the provisioner configuration is validated before any host change. */
export function parseProvisionerProfileConfig(value: unknown): ProvisionerProfileConfig {
  const record = exactRecord(value, ['controlSocket', 'adminSocket', 'quotaSocket', 'publicHost', 'reconcileIntervalMs', 'provisioner'], 'provisioner profile')
  if (typeof record.publicHost !== 'string' || !/^[A-Za-z0-9.-]+$/.test(record.publicHost)) throw new Error('publicHost must be a host name')
  return { controlSocket: absolutePath(record.controlSocket, 'controlSocket'), adminSocket: absolutePath(record.adminSocket, 'adminSocket'),
    quotaSocket: absolutePath(record.quotaSocket, 'quotaSocket'), publicHost: record.publicHost,
    reconcileIntervalMs: positiveInt(record.reconcileIntervalMs, 'reconcileIntervalMs'),
    provisioner: validateProvisionerConfig(record.provisioner as ProvisionerConfig) }
}

/** Real cgroup probe: controllers delegated to the account's user manager. */
export async function cgroupControllers(uid: number): Promise<string[]> {
  const text = await readFile(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`, 'utf8')
  return text.trim().split(/\s+/)
}

/** Start sockets and the periodic reconcile/idle loop. */
export async function startProvisioner(profile: ProvisionerProfileConfig, quota?: QuotaBridge): Promise<{ service: ProvisionerService; close(): Promise<void> }> {
  const service = createProvisionerService({ config: profile.provisioner, publicHost: profile.publicHost,
    quota: quota ?? createQuotaControlClient(profile.quotaSocket), probe: { controllers: cgroupControllers } })
  await service.lifecycle.reconcile()
  const control = await startProvisionerServer(profile.controlSocket, service.handler, { gid: profile.provisioner.socketGid })
  let admin: Awaited<ReturnType<typeof startAdminServer>>
  try { admin = await startAdminServer(profile.adminSocket, service.lifecycle) }
  catch (error) { await control.close(); throw error }
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => { await service.lifecycle.idleStop(); await service.lifecycle.reconcile() })()
      .catch(() => { process.stderr.write('provisioner: periodic maintenance failed\n') }).finally(() => { busy = false })
  }, profile.reconcileIntervalMs)
  timer.unref()
  return { service, async close() { clearInterval(timer); await admin.close(); await control.close() } }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-provisioner'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry for `dsh --profile provisioner`. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  if (process.platform !== 'linux') throw new Error('the provisioner runs only on Linux')
  const running = await startProvisioner(parseProvisionerProfileConfig(await readConfigFile(config.configFile)))
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await running.close() }, 'public-harness.provisioner')
}
