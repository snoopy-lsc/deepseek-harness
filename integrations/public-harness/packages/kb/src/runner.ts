/** Where a user's knowledge base files live, and how the user helper is started for them. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HelperOp } from './helper.ts'

/** One user's knowledge base locations. */
export interface UserTree {
  readonly userId: string
  /** Directory name under `users/` and `views/` (the native account, or the user ID in development). */
  readonly account: string
  /** `<storageRoot>/users/<account>/kb`, mounted read-write at `<home>/kb/mine`. */
  readonly kbDir: string
  /** Numeric owner for the helper unit (production only). */
  readonly uid?: number
  readonly gid?: number
}
/** Resolve a user's tree; undefined when the user has no account on this host yet. */
export type UserTrees = (userId: string) => Promise<UserTree | undefined>

/** Starts the helper for one operation. */
export interface HelperRunner {
  run(tree: UserTree, op: HelperOp, args: Record<string, unknown>, input?: Buffer): Promise<Buffer>
}

/** The helper failed; `detail` is its first stderr line, never shown to clients. */
export class HelperError extends Error {
  readonly detail: string
  constructor(detail: string) { super('kb helper failed'); this.detail = detail }
}

const OWN = fileURLToPath(import.meta.url)
/** Absolute path of the helper entry next to this module (`.ts` under tests, `.js` when built). */
export const HELPER_ENTRY = OWN.replace(/runner\.(ts|js)$/, 'helper.$1')
const nodeFlags = (entry: string) => entry.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []

function execute(command: string, argv: readonly string[], input: Buffer | undefined, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } })
    const out: Buffer[] = [], err: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 700 * 1024 * 1024) child.kill('SIGKILL'); else out.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 16) err.push(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(new HelperError(error.message)) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new HelperError(Buffer.concat(err).toString('utf8').split('\n')[0]?.slice(0, 300) ?? `exit ${code}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input ?? Buffer.alloc(0))
  })
}

/** Development runner: the helper runs as the service's own user, so nothing is enforced; the README labels it. */
export function createDirectRunner(options: { node?: string; entry?: string; timeoutMs?: number } = {}): HelperRunner {
  const entry = options.entry ?? HELPER_ENTRY, node = options.node ?? process.execPath
  return { run: (tree, op, args, input) => execute(node, [...nodeFlags(entry), entry, tree.kbDir, op, JSON.stringify(args)], input, options.timeoutMs ?? 120_000) }
}

/** Settings of the production runner. */
export interface SystemdRunnerOptions {
  readonly systemdRun: string
  readonly node: string
  readonly entry?: string
  /** Hidden from the helper unit, like from instances. */
  readonly inaccessible: readonly string[]
  readonly timeoutMs?: number
}

/** The exact `systemd-run` argv for one helper operation: a transient service as the user, with no network, no new privileges,
 * a read-only system, and write access to the user's `kb` directory only.
 * @param options Runner settings.
 * @param tree The user's tree (uid and gid required).
 * @param op Operation.
 * @param args Operation arguments.
 * @returns argv after the executable.
 */
export function systemdRunArgv(options: SystemdRunnerOptions, tree: UserTree, op: HelperOp, args: Record<string, unknown>): string[] {
  if (tree.uid === undefined || tree.gid === undefined || tree.uid === 0) throw new Error('helper needs an unprivileged uid')
  const entry = options.entry ?? HELPER_ENTRY
  const properties = ['NoNewPrivileges=yes', 'PrivateNetwork=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
    'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes',
    'CapabilityBoundingSet=', 'AmbientCapabilities=', 'RestrictAddressFamilies=AF_UNIX', 'UMask=0077', `ReadWritePaths=${tree.kbDir}`,
    `InaccessiblePaths=${options.inaccessible.join(' ')}`, 'MemoryMax=1G', 'TasksMax=64', `RuntimeMaxSec=${Math.ceil((options.timeoutMs ?? 120_000) / 1000)}`]
  return ['--quiet', '--collect', '--wait', '--pipe', '--service-type=exec', `--uid=${tree.uid}`, `--gid=${tree.gid}`, '--setenv=GIT_CONFIG_NOSYSTEM=1',
    ...properties.map(property => `--property=${property}`), '--', options.node, ...nodeFlags(entry), entry, tree.kbDir, op, JSON.stringify(args)]
}

/** Production runner (not exercised on development hosts; see the README). */
export function createSystemdRunner(options: SystemdRunnerOptions): HelperRunner {
  return { run: (tree, op, args, input) => execute(options.systemdRun, systemdRunArgv(options, tree, op, args), input, (options.timeoutMs ?? 120_000) + 5000) }
}

/** Development trees: `<storageRoot>/users/<userId>/kb`. */
export function devUserTrees(storageRoot: string): UserTrees {
  return async userId => /^[A-Za-z0-9_-]{1,128}$/.test(userId) ? { userId, account: userId, kbDir: `${storageRoot}/users/${userId}/kb` } : undefined
}
