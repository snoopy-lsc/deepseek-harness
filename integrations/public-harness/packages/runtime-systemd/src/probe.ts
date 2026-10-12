/** Observed enforcement: kernel, cgroup, quota and firewall state read back after start, never the rendered text. */
import { readFile } from 'node:fs/promises'
import type { RuntimeInstance } from '@public-harness/contracts'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { NativeHostError, type SystemdConfig } from './config.ts'
import { BROWSER_CHILD_PROFILE } from './apparmor.ts'
import { NATIVE_TABLE, unitCgroup } from './network.ts'

/** Host reads used by the probe; injectable so tests never touch the real kernel interfaces. */
export interface ProbeHost {
  /** Read a kernel or cgroup file; rejects when it is absent. */
  read(path: string): Promise<string>
}

const defaultHost: ProbeHost = { read: path => readFile(path, 'utf8') }

function refuse(what: string, detail?: string): never {
  throw new NativeHostError('host-operation', `enforcement-${what}`, detail === undefined ? undefined : new Error(detail))
}

/** Parse one `xfs_quota -x -c 'quota -u -N -b -i -n <uid>'` line: block and inode used/soft/hard.
 * @param output Command stdout.
 * @returns Hard limits in KiB blocks and inodes, or undefined when the line is absent or unparseable.
 */
export function parseXfsQuota(output: string): { blockHardKiB: number; inodeHard: number } | undefined {
  const line = output.split('\n').map(value => value.trim()).find(value => value.length > 0)
  if (line === undefined) return undefined
  // Columns: device, blocks used/soft/hard, warn count and grace "[...]" , inodes used/soft/hard, warn, grace.
  const match = /^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+\s+\[[^\]]*\]\s+\d+\s+\d+\s+(\d+)\s/.exec(`${line} `)
  return match === null ? undefined : { blockHardKiB: Number(match[1]), inodeHard: Number(match[2]) }
}

/** Refuse admission unless every mandatory protection is observed active for this running unit.
 * Checks: AppArmor enforcing for the account and its browser child profile; unprivileged user namespaces
 * restricted by AppArmor; cgroup controllers and effective CPU, memory, swap and task limits; XFS user-quota
 * enforcement with the configured hard limits; and the account's nftables chains in the owned table.
 * @param instance Running native instance.
 * @param config Resolved limits and tools.
 * @param runner Privileged command adapter for xfs_quota and nft.
 * @param host Kernel file reader.
 * @returns Resolves only when all checks pass; command success alone is never accepted as evidence.
 */
export async function verifyEnforcement(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner,
  host: ProbeHost = defaultHost): Promise<void> {
  const read = (path: string, what: string) => host.read(path).catch((cause: unknown) => refuse(what, String(cause)))
  const profiles = await read('/sys/kernel/security/apparmor/profiles', 'apparmor')
  for (const name of [instance.account, `${instance.account}//${BROWSER_CHILD_PROFILE}`]) {
    if (!profiles.split('\n').includes(`${name} (enforce)`)) refuse('apparmor', `${name} is not loaded in enforce mode`)
  }
  if ((await read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'userns-restriction')).trim() !== '1') {
    refuse('userns-restriction', 'kernel.apparmor_restrict_unprivileged_userns must be 1')
  }
  const cgroup = `/sys/fs/cgroup/${unitCgroup(instance).path}`
  const controllers = (await read(`${cgroup}/cgroup.controllers`, 'cgroup')).trim().split(/\s+/)
  for (const controller of ['cpu', 'memory', 'pids']) if (!controllers.includes(controller)) refuse('cgroup', `${controller} controller missing`)
  const { limits } = config
  const expected: [string, string][] = [
    ['memory.max', String(limits.memoryBytes)], ['memory.swap.max', '0'], ['pids.max', String(limits.pids)],
    ['cpu.max', `${Math.round(limits.cpus * 100_000)} 100000`],
  ]
  for (const [file, value] of expected) {
    const actual = (await read(`${cgroup}/${file}`, 'cgroup')).trim()
    if (actual !== value) refuse('cgroup', `${file} is ${actual}, expected ${value}`)
  }
  const procs = (await read(`${cgroup}/cgroup.procs`, 'cgroup')).trim()
  if (procs.length === 0) refuse('cgroup', 'unit cgroup has no processes')
  const state = await runner.run(config.tools.xfsQuota, ['-x', '-c', 'state -u', config.paths.quotaMount], { timeoutMs: config.operationTimeoutMs })
  if (state.code !== 0 || !/Accounting: ON/.test(state.stdout) || !/Enforcement: ON/.test(state.stdout)) refuse('disk-quota', 'user quota enforcement is off')
  const quota = await runner.run(config.tools.xfsQuota, ['-x', '-c', `quota -u -N -b -i -n ${instance.uid}`, config.paths.quotaMount],
    { timeoutMs: config.operationTimeoutMs })
  const parsed = quota.code === 0 ? parseXfsQuota(quota.stdout) : undefined
  if (parsed?.blockHardKiB !== limits.diskBytes / 1024 || parsed.inodeHard !== limits.diskInodes) refuse('disk-quota', 'hard limits differ')
  const chains = await runner.run(config.tools.nft, ['list', 'chain', 'inet', NATIVE_TABLE, `out_${instance.uid}`], { timeoutMs: config.operationTimeoutMs })
  const map = await runner.run(config.tools.nft, ['list', 'map', 'inet', NATIVE_TABLE, 'users_out'], { timeoutMs: config.operationTimeoutMs })
  if (chains.code !== 0 || !chains.stdout.includes('counter') || map.code !== 0 || !new RegExp(`\\b${instance.uid} : jump out_${instance.uid}\\b`).test(map.stdout)) {
    refuse('network', 'account rules are not installed')
  }
}
