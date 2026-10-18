/** Production knowledge base profile (`dsh --profile kb`, unit `dsh-kb.service`): the `dsh-kb` service runs as its own unprivileged
 * account on its private socket; user helpers start through the root helper socket (`dsh-kb-root.socket`, see `kb-root-helper.ts`),
 * which re-derives the account and starts `systemd-run --uid`; the service-owned org tree uses a direct helper as `dsh-kb`; compiles
 * are charged through the quota job socket. Accounts are the provisioner's derived names; a user without a native account has no tree yet. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseUserId } from '@public-harness/contracts'
import { createDirectRunner, createRootHelperRunner, quotaModelSource, startKbService, type UserTrees } from '@public-harness/kb'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { createQuotaControlClient } from '@public-harness/quota/control'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'
import { getentPasswd } from './kb-root-helper.ts'

/** Profile settings. */
export interface KbProfileConfig {
  readonly socket: string
  /** Identity's group, allowed to connect to `socket` (mode 0660). */
  readonly socketGid?: number
  readonly root: string
  readonly storageRoot: string
  /** The root helper's socket (`root:dsh-kb 0660`); the only route to a personal tree. */
  readonly rootHelperSocket: string
  readonly node: string
  readonly getent: string
  /** Compile settings; without them compile answers 503. `quotaSocket` is the quota service's job socket (open-job, issue, close-job only). */
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
  const record = exactRecord(value, ['socket', 'root', 'storageRoot', 'rootHelperSocket', 'node', 'getent', ...optional], 'kb configuration')
  const root = absolutePath(record.root, 'root')
  let compile: KbProfileConfig['compile']
  if (record.compile !== undefined) {
    const c = exactRecord(record.compile, ['quotaSocket', 'modelId', ...['siteWorkers', 'perUserPerHour'].filter(k => k in (record.compile as object))], 'kb compile')
    if (typeof c.modelId !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(c.modelId)) throw new Error('modelId is invalid')
    compile = { quotaSocket: absolutePath(c.quotaSocket, 'quotaSocket'), modelId: c.modelId,
      ...c.siteWorkers === undefined ? {} : { siteWorkers: int(c.siteWorkers, 'siteWorkers', 1, 16) },
      ...c.perUserPerHour === undefined ? {} : { perUserPerHour: int(c.perUserPerHour, 'perUserPerHour', 1, 1000) } }
  }
  return { socket: absolutePath(record.socket, 'socket'), root, storageRoot: absolutePath(record.storageRoot, 'storageRoot'),
    rootHelperSocket: absolutePath(record.rootHelperSocket, 'rootHelperSocket'), node: absolutePath(record.node, 'node'), getent: absolutePath(record.getent, 'getent'),
    ...record.socketGid === undefined ? {} : { socketGid: int(record.socketGid, 'socketGid', 0, 2 ** 31 - 1) }, ...compile ? { compile } : {} }
}

/** Native trees: the provisioner's derived account, its uid and gid from `getent passwd`, and `<storageRoot>/users/<account>/kb`. */
export function nativeUserTrees(config: Pick<KbProfileConfig, 'storageRoot' | 'getent'>, lookup = (account: string) => getentPasswd(config.getent, account)): UserTrees {
  return async userId => {
    let parsed
    try { parsed = parseUserId(userId) } catch { return undefined }
    const account = deriveNames(parsed).account
    const ids = await lookup(account)
    if (ids === undefined || ids.uid === 0) return undefined
    return { userId, account, kbDir: `${config.storageRoot}/users/${account}/kb`, uid: ids.uid, gid: ids.gid }
  }
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
    runner: createRootHelperRunner({ socket: parsed.rootHelperSocket }),
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
