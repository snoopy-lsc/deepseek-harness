#!/usr/bin/env node
/** Production root helper of the knowledge base service (`dsh-kb-root@.service`, one process per connection of `dsh-kb-root.socket`).
 *
 * `dsh-kb` runs as its own unprivileged account; the only step that needs root, starting the user helper as the tree's owner through
 * `systemd-run --uid`, happens here. The socket is `root:dsh-kb 0660`, so only the service account can connect: no sudo, no polkit.
 * The caller sends a user ID, a verb from the fixed helper set and whitelisted arguments (`@public-harness/kb` `parseRootRequest`);
 * the account is re-derived (the provisioner's `deriveNames`), its ids come from `getent passwd` (never below `minUid`, never root),
 * and the tree must be the canonical `<storageRoot>/users/<account>/kb` without symbolic links (`canonicalKbDir`).
 * Usage: `kb-root-helper <config.json>` with the connection on stdin and stdout. */
import { execFile } from 'node:child_process'
import { canonicalKbDir, createSystemdRunner, RootHelperError, serveRootConnection, type RootHelperDeps } from '@public-harness/kb'
import { parseUserId } from '@public-harness/contracts'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { absolutePath, exactRecord, readConfigFile } from './config-file.ts'

/** Root helper settings (`/etc/dsh-public/kb-root.json`, root-owned). */
export interface KbRootConfig {
  readonly storageRoot: string
  /** The service's KB root; always hidden from helper units. */
  readonly kbRoot: string
  readonly systemdRun: string
  readonly node: string
  readonly getent: string
  /** Hidden from helper units, like from instances (must include `kbRoot`). */
  readonly inaccessible: readonly string[]
  /** Lowest uid a helper may run as (default 1000). */
  readonly minUid: number
  readonly timeoutMs?: number
}

const int = (value: unknown, name: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`)
  return value
}

/** Strict parse of the root helper configuration. */
export function parseKbRootConfig(value: unknown): KbRootConfig {
  const raw = value as Record<string, unknown> | null
  const optional = ['minUid', 'timeoutMs'].filter(key => typeof raw === 'object' && raw !== null && key in raw)
  const record = exactRecord(value, ['storageRoot', 'kbRoot', 'systemdRun', 'node', 'getent', 'inaccessible', ...optional], 'kb root helper configuration')
  if (!Array.isArray(record.inaccessible) || record.inaccessible.length === 0) throw new Error('inaccessible must list at least the KB root')
  const inaccessible = record.inaccessible.map((path, index) => absolutePath(path, `inaccessible[${index}]`))
  const kbRoot = absolutePath(record.kbRoot, 'kbRoot')
  if (!inaccessible.includes(kbRoot)) throw new Error('inaccessible must include the KB root')
  if (inaccessible.some(path => /\s/.test(path))) throw new Error('inaccessible paths must not contain spaces')
  return { storageRoot: absolutePath(record.storageRoot, 'storageRoot'), kbRoot, systemdRun: absolutePath(record.systemdRun, 'systemdRun'),
    node: absolutePath(record.node, 'node'), getent: absolutePath(record.getent, 'getent'), inaccessible,
    minUid: record.minUid === undefined ? 1000 : int(record.minUid, 'minUid', 1, 2 ** 31 - 1),
    ...record.timeoutMs === undefined ? {} : { timeoutMs: int(record.timeoutMs, 'timeoutMs', 1000, 600_000) } }
}

/** Look up an account's uid and gid with `getent passwd`. */
export function getentPasswd(binary: string, account: string): Promise<{ uid: number; gid: number } | undefined> {
  return new Promise(resolve => {
    execFile(binary, ['passwd', account], { timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => {
      const fields = error ? [] : String(stdout).trim().split(':')
      const uid = Number(fields[2]), gid = Number(fields[3])
      resolve(fields[0] === account && Number.isSafeInteger(uid) && Number.isSafeInteger(gid) ? { uid, gid } : undefined)
    })
  })
}

/** Resolution and runner of the root helper.
 * @param config Parsed configuration.
 * @param overrides Test seams: the passwd lookup and the uid that owns the storage layout (root in production).
 */
export function kbRootDeps(config: KbRootConfig, overrides: { lookup?: (account: string) => Promise<{ uid: number; gid: number } | undefined>; rootUid?: number } = {}): RootHelperDeps {
  const lookup = overrides.lookup ?? (account => getentPasswd(config.getent, account))
  const runner = createSystemdRunner({ systemdRun: config.systemdRun, node: config.node, inaccessible: config.inaccessible, ...config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs } })
  return {
    async resolve(userId) {
      const account = deriveNames(parseUserId(userId)).account
      const ids = await lookup(account)
      if (ids === undefined) return undefined
      if (ids.uid === 0 || ids.uid < config.minUid || ids.gid === 0) throw new RootHelperError('tree')
      const kbDir = await canonicalKbDir({ storageRoot: config.storageRoot, ...overrides.rootUid === undefined ? {} : { rootUid: overrides.rootUid } }, account, ids.uid)
      return { userId, account, kbDir, uid: ids.uid, gid: ids.gid }
    },
    run: (tree, verb, args, input) => runner.run(tree, verb, args, input),
  }
}

const invoked = process.argv[1] !== undefined && /kb-root-helper\.(?:js|ts)$/.test(process.argv[1])
if (invoked) {
  void (async () => {
    try {
      const [file] = process.argv.slice(2)
      if (file === undefined) throw new Error('usage: kb-root-helper <config.json>')
      const deps = kbRootDeps(parseKbRootConfig(await readConfigFile(file)))
      await serveRootConnection(process.stdin.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>, chunk => process.stdout.write(chunk), deps)
    } catch (error) {
      process.stderr.write(`kb-root-helper: ${(error as Error).message.slice(0, 300)}\n`)
      process.exitCode = 1
    }
  })()
}
