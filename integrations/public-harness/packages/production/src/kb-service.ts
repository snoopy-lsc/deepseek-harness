/** Production knowledge base profile (`dsh --profile kb`): the `dsh-kb` service on its private socket, user helpers through
 * `systemd-run` as each native account, the service-owned org tree through a direct helper, and compiles charged through the
 * quota control socket. Accounts are the provisioner's derived names; a user without a native account has no tree yet. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { parseUserId } from '@public-harness/contracts'
import { createDirectRunner, createSystemdRunner, quotaModelSource, startKbService, type UserTrees } from '@public-harness/kb'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { createQuotaControlClient } from '@public-harness/quota/control'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

/** Profile settings. */
export interface KbProfileConfig {
  readonly socket: string
  /** Identity's group, allowed to connect to `socket` (mode 0660). */
  readonly socketGid?: number
  readonly root: string
  readonly storageRoot: string
  readonly systemdRun: string
  readonly node: string
  readonly getent: string
  /** Hidden from helper units (at least `root`, like instances). */
  readonly inaccessible: readonly string[]
  /** Compile settings; without them compile answers 503. */
  readonly compile?: { readonly quotaSocket: string; readonly modelId: string; readonly siteWorkers?: number; readonly perUserPerHour?: number }
}

const int = (value: unknown, name: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`)
  return value
}

/** Strict parse of the profile file. */
export function parseKbProfileConfig(value: unknown): KbProfileConfig {
  const raw = value as Record<string, unknown> | null
  const optional = ['socketGid', 'compile'].filter(key => typeof raw === 'object' && raw !== null && key in raw)
  const record = exactRecord(value, ['socket', 'root', 'storageRoot', 'systemdRun', 'node', 'getent', 'inaccessible', ...optional], 'kb configuration')
  if (!Array.isArray(record.inaccessible) || record.inaccessible.length === 0) throw new Error('inaccessible must list at least the KB root')
  const inaccessible = record.inaccessible.map((path, index) => absolutePath(path, `inaccessible[${index}]`))
  const root = absolutePath(record.root, 'root')
  if (!inaccessible.includes(root)) throw new Error('inaccessible must include the KB root')
  let compile: KbProfileConfig['compile']
  if (record.compile !== undefined) {
    const c = exactRecord(record.compile, ['quotaSocket', 'modelId', ...['siteWorkers', 'perUserPerHour'].filter(k => k in (record.compile as object))], 'kb compile')
    if (typeof c.modelId !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(c.modelId)) throw new Error('modelId is invalid')
    compile = { quotaSocket: absolutePath(c.quotaSocket, 'quotaSocket'), modelId: c.modelId,
      ...c.siteWorkers === undefined ? {} : { siteWorkers: int(c.siteWorkers, 'siteWorkers', 1, 16) },
      ...c.perUserPerHour === undefined ? {} : { perUserPerHour: int(c.perUserPerHour, 'perUserPerHour', 1, 1000) } }
  }
  return { socket: absolutePath(record.socket, 'socket'), root, storageRoot: absolutePath(record.storageRoot, 'storageRoot'), systemdRun: absolutePath(record.systemdRun, 'systemdRun'),
    node: absolutePath(record.node, 'node'), getent: absolutePath(record.getent, 'getent'), inaccessible,
    ...record.socketGid === undefined ? {} : { socketGid: int(record.socketGid, 'socketGid', 0, 2 ** 31 - 1) }, ...compile ? { compile } : {} }
}

/** Native trees: the provisioner's derived account, its uid and gid from `getent passwd`, and `<storageRoot>/users/<account>/kb`. */
export function nativeUserTrees(config: Pick<KbProfileConfig, 'storageRoot' | 'getent'>, lookup = (account: string) => getent(config.getent, account)): UserTrees {
  return async userId => {
    let parsed
    try { parsed = parseUserId(userId) } catch { return undefined }
    const account = deriveNames(parsed).account
    const ids = await lookup(account)
    if (ids === undefined || ids.uid === 0) return undefined
    return { userId, account, kbDir: `${config.storageRoot}/users/${account}/kb`, uid: ids.uid, gid: ids.gid }
  }
}
function getent(binary: string, account: string): Promise<{ uid: number; gid: number } | undefined> {
  return new Promise(resolve => {
    execFile(binary, ['passwd', account], { timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => {
      const fields = error ? [] : String(stdout).trim().split(':')
      const uid = Number(fields[2]), gid = Number(fields[3])
      resolve(fields[0] === account && Number.isSafeInteger(uid) && Number.isSafeInteger(gid) ? { uid, gid } : undefined)
    })
  })
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-kb-service'
export interface PluginConfig { configFile: string }
export const Config: z<PluginConfig> = z.object({ configFile: z.string().required() })

/** Cordis entry. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const parsed = parseKbProfileConfig(await readConfigFile(config.configFile))
  const quota = parsed.compile === undefined ? undefined : createQuotaControlClient(parsed.compile.quotaSocket)
  const service = await startKbService({
    root: parsed.root, socket: parsed.socket, socketMode: parsed.socketGid === undefined ? 0o600 : 0o660, ...parsed.socketGid === undefined ? {} : { socketGid: parsed.socketGid },
    users: nativeUserTrees(parsed),
    runner: createSystemdRunner({ systemdRun: parsed.systemdRun, node: parsed.node, inaccessible: parsed.inaccessible }),
    orgRunner: createDirectRunner({ node: parsed.node }),
    log: line => console.error(line),
    ...quota === undefined || parsed.compile === undefined ? {} : { jobs: {
      models: quotaModelSource({ openJob: (p, i) => quota.openJob(parseUserId(p), i), issue: (p, i) => quota.issue(parseUserId(p), i), closeJob: i => quota.closeJob(i) }, parsed.compile.modelId),
      ...parsed.compile.siteWorkers === undefined ? {} : { siteWorkers: parsed.compile.siteWorkers },
      ...parsed.compile.perUserPerHour === undefined ? {} : { perUserPerHour: parsed.compile.perUserPerHour } } },
  })
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => async () => { await service.close() }, 'public-harness.kb-service')
}
