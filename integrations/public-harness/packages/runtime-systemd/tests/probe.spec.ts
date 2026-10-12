import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { parseXfsQuota, verifyEnforcement, type ProbeHost } from '../src/probe.ts'
import { config, instance } from './fixture.ts'

const i = instance()
const unit = i.runtime.kind === 'systemd' ? i.runtime.unit : ''
const cg = `/sys/fs/cgroup/dsh.slice/dsh-user.slice/${unit.replace('.service', '.slice')}/${unit}`
function healthy(): Record<string, string> {
  return {
    '/sys/kernel/security/apparmor/profiles': `other (enforce)\n${i.account} (enforce)\n${i.account}//chromium (enforce)\n`,
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
    [`${cg}/cgroup.controllers`]: 'cpu memory pids\n', [`${cg}/memory.max`]: '1073741824\n', [`${cg}/memory.swap.max`]: '0\n',
    [`${cg}/pids.max`]: '512\n', [`${cg}/cpu.max`]: '200000 100000\n', [`${cg}/cgroup.procs`]: '4242\n',
  }
}
const quotaLine = '/dev/vdb   12   0   5242880   00 [--------]   3   0   100000   00 [--------]\n'
function runner(overrides: Partial<Record<'state' | 'quota' | 'chain' | 'map', { code: number; stdout: string }>> = {}): CommandRunner {
  return { async run(_command, args) {
    const key = args[0] === 'list' ? (args[1] as 'chain' | 'map') : String(args[2]).startsWith('state') ? 'state' : 'quota'
    const defaults = { state: { code: 0, stdout: 'User quota state on /srv/dsh\n  Accounting: ON\n  Enforcement: ON\n' }, quota: { code: 0, stdout: quotaLine },
      chain: { code: 0, stdout: 'chain out_1201 {\n counter packets 0 bytes 0 drop\n}' }, map: { code: 0, stdout: 'elements = { 1201 : jump out_1201 }' } }
    return { ...overrides[key] ?? defaults[key], stderr: '' }
  } }
}
const host = (files: Record<string, string>): ProbeHost => ({ async read(path) {
  const value = files[path]; if (value === undefined) throw new Error(`ENOENT ${path}`); return value
} })

describe('observed enforcement', () => {
  it('accepts a host where every protection is observed', async () => {
    await expect(verifyEnforcement(i, config(), runner(), host(healthy()))).resolves.toBeUndefined()
    expect(parseXfsQuota(quotaLine)).toEqual({ blockHardKiB: 5242880, inodeHard: 100000 })
  })
  const broken: [string, () => [Record<string, string>, CommandRunner]][] = [
    ['complain-mode profile', () => [{ ...healthy(), '/sys/kernel/security/apparmor/profiles': `${i.account} (complain)\n${i.account}//chromium (enforce)\n` }, runner()]],
    ['missing browser child profile', () => [{ ...healthy(), '/sys/kernel/security/apparmor/profiles': `${i.account} (enforce)\n` }, runner()]],
    ['AppArmor disabled', () => { const files = healthy(); delete files['/sys/kernel/security/apparmor/profiles']; return [files, runner()] }],
    ['unrestricted user namespaces', () => [{ ...healthy(), '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n' }, runner()]],
    ['missing pids controller', () => [{ ...healthy(), [`${cg}/cgroup.controllers`]: 'cpu memory\n' }, runner()]],
    ['unlimited memory', () => [{ ...healthy(), [`${cg}/memory.max`]: 'max\n' }, runner()]],
    ['swap allowed', () => [{ ...healthy(), [`${cg}/memory.swap.max`]: 'max\n' }, runner()]],
    ['empty cgroup', () => [{ ...healthy(), [`${cg}/cgroup.procs`]: '\n' }, runner()]],
    ['quota enforcement off', () => [healthy(), runner({ state: { code: 0, stdout: 'Accounting: ON\nEnforcement: OFF\n' } })]],
    ['quota limit differs', () => [healthy(), runner({ quota: { code: 0, stdout: quotaLine.replace('5242880', '0') } })]],
    ['quota command failed', () => [healthy(), runner({ quota: { code: 1, stdout: '' } })]],
    ['missing network chain', () => [healthy(), runner({ chain: { code: 1, stdout: '' } })]],
    ['missing map element', () => [healthy(), runner({ map: { code: 0, stdout: 'elements = { 1202 : jump out_1202 }' } })]],
  ]
  it.each(broken)('disabled_enforcement_refuses_prepare: %s', async (_name, make) => {
    const [files, commands] = make()
    await expect(verifyEnforcement(i, config(), commands, host(files))).rejects.toMatchObject({ code: 'host-operation', operation: expect.stringMatching(/^enforcement-/) })
  })
})
