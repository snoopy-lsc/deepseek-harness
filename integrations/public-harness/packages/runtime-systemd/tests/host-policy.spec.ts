import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { parseSystemdConfig } from '../src/config.ts'
import { ensureNativeAccount } from '../src/accounts.ts'
import { renderResolvConf, renderUnit } from '../src/units.ts'
import { renderAppArmor } from '../src/apparmor.ts'

import { common, config, instance, native } from './fixture.ts'

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
    expect(policy).not.toMatch(/\b[puPU]x\b|change_profile|flags=\(complain\)|^\s*\/\*\* rw/m)
  })
  it('main profile cannot create user namespaces; only the pinned browser binary enters the child profile', () => {
    const i = instance(), policy = renderAppArmor(i, config())
    const childStart = policy.indexOf('  profile chromium flags=(mediate_deleted) {')
    expect(childStart).toBeGreaterThan(0)
    const main = policy.slice(0, childStart), child = policy.slice(childStart)
    expect(main).not.toMatch(/^\s*userns\b/m)
    expect(main).not.toMatch(/^\s*capability\b/m)
    expect(main).not.toMatch(/uid_map|gid_map|setgroups/)
    // Exactly one transition rule, naming the exact pinned executable.
    expect(policy.match(/\bCx\b/g)).toEqual(['Cx'])
    expect(main).toContain(`  ${native.paths.browser} Cx -> chromium,\n`)
    expect(policy).not.toMatch(/[*?{[][^\n]*\bCx\b/)
    for (const rule of ['userns,', 'capability sys_admin,', 'capability sys_chroot,', 'capability setuid,', 'capability setgid,',
      'owner /proc/[0-9]*/{uid_map,gid_map,setgroups} w,']) expect(child).toContain(`    ${rule}\n`)
    expect(child.match(/capability \w+/g)).toEqual(['capability sys_admin', 'capability sys_chroot', 'capability setuid', 'capability setgid'])
    // The child may execute only the browser tree; user directories are not executable there.
    expect(child.match(/^.*\bi?x,$/gm)?.map(line => line.trim())).toEqual([`${native.paths.browser} ix,`, '/opt/dsh/browser/**/chrome_crashpad_handler ix,'])
    expect(child).toContain(`    ${i.workspace}/** rwkm,\n`)
    expect(child).toContain('    deny /run/** rwklx,\n')
    expect(child).toContain(`signal (receive) peer=${i.account},`)
    expect(policy).not.toMatch(/unconfined\b(?!,)|flags=\([^)]*(unconfined|complain|kill)|\bux\b|\bUx\b|\bpix\b|\bPix\b|change_profile|change_hat|\^/)
    expect(policy.trimEnd().endsWith('  }\n}')).toBe(true)
  })
  it('binds a generated resolver file over /etc/resolv.conf', () => {
    const i = instance(), unit = renderUnit(i, config())
    expect(unit).toContain(`BindReadOnlyPaths=${i.controlDir}/resolv.conf:/etc/resolv.conf\n`)
    expect(unit).toContain(`Environment=PUBLIC_HARNESS_BROWSER=${native.paths.browser}\n`)
    expect(renderResolvConf(config())).toBe('# Generated by the public Harness provisioner; edits are replaced.\nnameserver 1.1.1.1\noptions edns0\n')
    expect(renderResolvConf(parseSystemdConfig({ common, native: { ...native, resolver: '2606:4700:4700::1111' } }))).toContain('nameserver 2606:4700:4700::1111\n')
    for (const resolver of ['dns.example', '1.1.1.1\nnameserver 6.6.6.6', '1.1.1.1 ', '']) {
      expect(() => parseSystemdConfig({ common, native: { ...native, resolver } })).toThrow(expect.objectContaining({ operation: 'resolver' }))
    }
  })
  it('requires native floors of 512 tasks and 1 GiB', () => {
    expect(() => parseSystemdConfig({ common: { ...common, limits: { ...common.limits, pids: 511 } }, native }))
      .toThrow(expect.objectContaining({ operation: 'native-limit-floor' }))
    expect(() => parseSystemdConfig({ common: { ...common, limits: { ...common.limits, memoryBytes: 1073741823 } }, native }))
      .toThrow(expect.objectContaining({ operation: 'native-limit-floor' }))
    expect(renderUnit(instance(), config())).toContain('TasksMax=512\n')
  })
  it('keeps the browser inside its own isolated root', () => {
    const paths = (extra: Record<string, string>) => ({ common, native: { ...native, paths: { ...native.paths, ...extra } } })
    expect(() => parseSystemdConfig(paths({ browser: '/opt/dsh/release/chrome' }))).toThrow(expect.objectContaining({ operation: 'asset-layout' }))
    expect(() => parseSystemdConfig(paths({ browser: '/opt/dsh/browser' }))).toThrow(expect.objectContaining({ operation: 'asset-layout' }))
    expect(() => parseSystemdConfig(paths({ browserRoot: '/opt/dsh/release/browser', browser: '/opt/dsh/release/browser/chrome' })))
      .toThrow(expect.objectContaining({ operation: 'overlapping-paths' }))
    expect(() => parseSystemdConfig(paths({ browserRoot: '/home/browser', browser: '/home/browser/chrome' })))
      .toThrow(expect.objectContaining({ operation: 'hidden-path' }))
    expect(() => parseSystemdConfig(paths({ releaseManifest: '/opt/dsh/manifest.json' }))).toThrow(expect.objectContaining({ operation: 'asset-layout' }))
  })
  it('rejects unknown fields, unsafe policy paths, and overlapping ports', () => {
    expect(() => parseSystemdConfig({ common, native, unknown: true })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, unknown: true } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, web: common.ports.quota } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, paths: { ...native.paths, release: '/opt/dsh/release\nExecStart=/bin/sh' } } })).toThrow()
    expect(() => parseSystemdConfig({ common, native: { ...native, paths: { ...native.paths, release: '/srv/dsh/data/release' } } })).toThrow()
    for (const hidden of ['/home/dsh', '/root/dsh', '/run/user/0/dsh']) {
      expect(() => parseSystemdConfig({ common, native: { ...native, paths: { ...native.paths, toolchain: hidden } } })).toThrow()
      expect(() => parseSystemdConfig({ common: { ...common, paths: { ...common.paths, storageRoot: `${hidden}/data`, quotaMount: hidden } }, native }))
        .toThrow(expect.objectContaining({ operation: 'hidden-path' }))
    }
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
