import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '@public-harness/provisioner/system'
import { installNetwork, NATIVE_TABLE, renderInputDispatch, renderUserNetwork, renderUserRemoval } from '../src/network.ts'
import { config, instance } from './fixture.ts'

const other = () => ({ ...instance(), uid: 1202, gid: 1202, webPort: 29201, quotaPort: 29101,
  runtime: { kind: 'systemd' as const, unit: 'dsh-user-000000000000000000000002.service' as never } })

describe('native network policy', () => {
  it('foreign_loopback_and_ipv6_are_denied', () => {
    const i = instance(), script = renderUserNetwork(i, config()) + renderInputDispatch([i])
    const own = `socket cgroupv2 level 3 "dsh.slice/dsh-user.slice/${i.runtime.kind === 'systemd' ? i.runtime.unit.replace('.service', '.slice') : ''}"`
    // Loopback is marked with the sender UID; the owner's listeners accept only that UID, root only on the Web port.
    expect(script).toContain('add rule inet dsh_native output oif "lo" ct state new ct mark set meta skuid\n')
    expect(script).toContain(`in_1201 ${own} ct mark 1201 accept\n`)
    expect(script).toContain(`in_1201 ${own} ct mark 0 tcp dport 29200 accept\n`)
    expect(script).toContain(`in_1201 ${own} counter drop\n`)
    expect(script).toContain(`in_1201 ${own} iif != "lo" counter drop\n`)
    // The account's own loopback connects reach only its quota listener among non-owned sockets.
    expect(script).toContain('in_1201 ct mark 1201 iif "lo" tcp dport 29100 accept\nadd rule inet dsh_native in_1201 ct mark 1201 iif "lo" counter drop\n')
    expect(script).toMatch(/out_1201 ip6 daddr \{[^}]*::1\/128[^}]*fe80::\/10[^}]*\} drop/)
    expect(script).toMatch(/out_1201 ip daddr \{[^}]*169\.254\.0\.0\/16[^}]*\} drop/)
    expect(script).toContain('out_1201 tcp dport { 80, 443 } accept\n')
    expect(script).not.toContain('udp dport { ')
    expect(script.trimEnd().split('\n').filter(line => line.startsWith('add rule inet dsh_native out_1201')).at(-1)).toBe('add rule inet dsh_native out_1201 counter drop')
  })
  it('established_flow_does_not_bypass_uid_policy', () => {
    const script = renderUserNetwork(instance(), config())
    // The only established accepts live inside UID- or cgroup-selected chains, after dispatch by identity.
    const established = script.split('\n').filter(line => line.includes('established'))
    expect(established).toEqual(['add rule inet dsh_native out_1201 ct state established,related accept', 'add rule inet dsh_native in_1201 ct state established,related accept'])
    expect(script.indexOf('ct mark set meta skuid')).toBeLessThan(script.indexOf('vmap @users_out'))
    expect(script).not.toMatch(/^add rule inet dsh_native (output|input) ct state established/m)
  })
  it('atomic_update_preserves_host_rules', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = { async run(command, args) { calls.push([command, ...args]); return { code: 0, stdout: '', stderr: '' } } }
    const i = instance()
    // The script is published through the root control directory first; without it nft never runs.
    await expect(installNetwork(i, config(), runner, [other()])).rejects.toMatchObject({ code: 'unsafe-path' })
    expect(calls).toEqual([])
    // Every statement targets the owned table; nothing flushes the ruleset or another table.
    const script = renderUserNetwork(i, config()) + renderInputDispatch([other(), i]) + renderUserRemoval(i, [other()])
    for (const line of script.split('\n').filter(Boolean)) expect(line).toMatch(new RegExp(`^(add|flush|delete) (table|map|chain|rule|element) inet ${NATIVE_TABLE}\\b`))
    expect(script).not.toMatch(/flush ruleset|delete table/)
    const removal = renderUserRemoval(i, [other()])
    expect(removal.indexOf('delete element inet dsh_native users_out { 1201 }')).toBeLessThan(removal.indexOf('delete chain inet dsh_native out_1201'))
    expect(removal).toContain('jump in_1202')
    expect(removal).not.toContain('jump in_1201')
  })
})
