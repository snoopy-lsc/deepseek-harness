import { describe, expect, it } from 'vitest'
import { parseInstanceId, parseUserId, type RuntimeInstance } from '@public-harness/contracts'
import { deriveNames } from '@public-harness/provisioner/accounts'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { parseSystemdConfig } from '../src/config.ts'
import { ensureNativeAccount } from '../src/accounts.ts'
import { renderUnit } from '../src/units.ts'
import { renderAppArmor } from '../src/apparmor.ts'

export const common = {
  paths: { storageRoot: '/srv/dsh/data', stateDir: '/srv/dsh/state', socketDir: '/run/dsh/sockets', quotaMount: '/srv/dsh' },
  tools: { getent: '/usr/bin/getent', useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel', nologin: '/usr/sbin/nologin' },
  runtime: { kind: 'systemd', configFile: '/etc/dsh/native.json' }, socketGid: 100, maxActiveInstances: 4, idleStopMs: 600000, deletionRecoveryMs: 86400000,
  limits: { cpus: 2, memoryBytes: 1073741824, pids: 256, openFiles: 4096, diskBytes: 5368709120 },
  readyTimeoutMs: 30000, stopTimeoutMs: 15000, ports: { quota: { min: 29100, max: 29109 } },
}
export const native = {
  paths: { release: '/opt/dsh/release', toolchain: '/opt/dsh/toolchain',
    dsh: '/opt/dsh/release/dsh.mjs', launchPatch: '/opt/dsh/release/native.yml' },
  tools: { node: '/opt/dsh/toolchain/node', systemctl: '/usr/bin/systemctl', apparmorParser: '/usr/sbin/apparmor_parser',
    xfsQuota: '/usr/sbin/xfs_quota', nft: '/usr/sbin/nft' },
  profile: 'public-user', diskInodes: 100000, shmBytes: 67108864, shmInodes: 4096, operationTimeoutMs: 10000,
  web: { min: 29200, max: 29209 }, resolver: '1.1.1.1', publicEgress: { tcp: [80, 443], udp: [] },
}
export const config = () => parseSystemdConfig({ common, native })
export function instance(): RuntimeInstance {
  const userId = parseUserId('native-alice'), names = deriveNames(userId), root = `${common.paths.storageRoot}/users/${names.account}`
  return { userId, instanceId: parseInstanceId('native_1'), runtime: { kind: 'systemd', unit: names.unit }, account: names.account,
    uid: 1201, gid: 1201, home: `${root}/home`, workspace: `${root}/workspace`, cache: `${root}/cache`, tmp: `${root}/tmp`,
    controlDir: `${common.paths.stateDir}/runtime/${names.account}`, webPort: 29200, quotaPort: 29100 }
}

describe('native host policy', () => {
  it('account_requires_no_linger', async () => {
    const calls: { command: string; args: readonly string[] }[] = []; let created = false
    const i = instance()
    const runner: CommandRunner = { async run(command, args) {
      calls.push({ command, args })
      if (command === common.tools.useradd) { created = true; return { code: 0, stdout: '', stderr: '' } }
      if (args[0] === 'passwd') return { code: created ? 0 : 2, stdout: created ? `${i.account}:x:1201:1201::${i.home}:${common.tools.nologin}\n` : '', stderr: '' }
      if (args[0] === 'shadow') return { code: 0, stdout: `${i.account}:!:1:0:99999:7:::\n`, stderr: '' }
      if (args[0] === 'initgroups') return { code: 0, stdout: `${i.account} 1201\n`, stderr: '' }
      throw new Error('unexpected account command')
    } }
    expect(await ensureNativeAccount(i.userId, config(), runner)).toEqual({ uid: 1201, gid: 1201 })
    expect(calls.some(call => call.command.includes('loginctl'))).toBe(false)
    expect(calls.find(call => call.command === common.tools.useradd)!.args).toContain('--no-create-home')
    expect(calls.find(call => call.command === common.tools.useradd)!.args).toContain('!')
  })
  it('unit_confines_descendants', () => {
    const i = instance(), unit = renderUnit(i, config())
    for (const line of [`User=${i.uid}`, `Group=${i.gid}`, 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
      'KillMode=control-group', 'SendSIGKILL=yes', 'ProtectProc=invisible', 'Delegate=no', 'ProtectControlGroups=yes',
      `AppArmorProfile=${i.account}`, 'ProtectSystem=strict', 'MemorySwapMax=0', 'LimitCORE=0']) expect(unit).toContain(`${line}\n`)
    expect(unit).toContain(`ReadWritePaths=${i.home} ${i.workspace} ${i.cache} ${i.tmp}\n`)
    expect(unit).toContain(`BindPaths=${i.tmp}:/tmp ${i.tmp}:/var/tmp\n`)
    expect(unit).toContain('size=67108864,nr_inodes=4096')
    expect(unit).toContain('--profile public-user')
    expect(unit).not.toMatch(/MemoryDenyWriteExecute=yes|RestrictNamespaces=yes|AppArmorProfile=-|ExecStartPre=/)
  })
  it('descendant execution inherits the same profile without management access', () => {
    const i = instance(), policy = renderAppArmor(i, config())
    expect(policy).toContain(`profile ${i.account}`)
    expect(policy).toContain(`${i.workspace}/** rwkmix,`)
    expect(policy).toContain('deny /run/** rwklx,')
    expect(policy).toContain('deny /sys/fs/cgroup/** rwklx,')
    expect(policy).toContain(`signal (send, receive) peer=${i.account},`)
    expect(policy).toContain(`ptrace (read, readby, trace, tracedby) peer=${i.account},`)
    expect(policy).toContain('owner /proc/[0-9]*/** r,')
    expect(policy).not.toMatch(/\b[puPUcC]x\b|change_profile|flags=\(complain\)|^\s*\/\*\* rw/m)
  })
  it('rejects unknown fields, unsafe policy paths, and overlapping ports', () => {
    expect(() => parseSystemdConfig({ common, native, unknown: true })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, unknown: true } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, web: common.ports.quota } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, paths: { ...native.paths, release: '/opt/dsh/release\nExecStart=/bin/sh' } } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, paths: { ...native.paths, release: '/srv/dsh/data/release' } } })).toThrow()
  })
})

it.each(['unlocked', 'admin-group', 'root-group'])('rejects existing account with %s policy', async violation => {
  const i = instance(), gid = violation === 'root-group' ? 0 : 1201
  const runner: CommandRunner = { async run(_command, args) {
    const stdout = args[0] === 'passwd' ? `${i.account}:x:1201:${gid}::${i.home}:${common.tools.nologin}\n`
      : args[0] === 'shadow' ? `${i.account}:${violation === 'unlocked' ? '$6$hash' : '!'}:1:0:99999:7:::\n`
        : `${i.account} ${gid}${violation === 'admin-group' ? ' 27' : ''}\n`
    return { code: 0, stdout, stderr: '' }
  } }
  await expect(ensureNativeAccount(i.userId, config(), runner)).rejects.toMatchObject({ code: 'account-conflict' })
})

it('applies both XFS hard limits and surfaces a failed quota command', async () => {
  const { applyDiskLimits } = await import('../src/limits.ts')
  const mutable: string[][] = []
  const runner: CommandRunner = { async run(command, args, options) {
    mutable.push([command, ...args]); expect(options?.timeoutMs).toBe(native.operationTimeoutMs)
    return { code: 0, stdout: '', stderr: '' }
  } }
  await applyDiskLimits(instance(), config(), runner)
  expect(mutable).toEqual([[native.tools.xfsQuota, '-x', '-c', 'limit -u bsoft=0 bhard=5242880k isoft=0 ihard=100000 1201', common.paths.quotaMount]])
  await expect(applyDiskLimits(instance(), config(), { run: async () => ({ code: 1, stdout: '', stderr: 'quota unavailable' }) }))
    .rejects.toMatchObject({ code: 'host-operation', operation: 'disk-quota' })
})
