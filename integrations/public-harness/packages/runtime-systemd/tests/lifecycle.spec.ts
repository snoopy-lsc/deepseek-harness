import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeInstance } from '@public-harness/contracts'
import type { CommandResult, CommandRunner } from '@public-harness/provisioner/system'
import { createSystemdRuntime, NativeRuntimeError, type SystemdRuntimeDeps } from '../src/runtime.ts'
import { config, instance } from './fixture.ts'

const uid = process.getuid!(), gid = process.getgid!()
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })

async function harness(overrides: { readyPort?: number; probe?: boolean; hang?: string; procs?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-'))
  const i: RuntimeInstance = { ...instance(), uid, gid, home }
  const calls: string[] = [], events: string[] = []
  let unitActive = false
  const runner: CommandRunner = {
    async run(command, args) {
      const line = `${command.split('/').pop()} ${args.join(' ')}`
      calls.push(line)
      if (overrides.hang !== undefined && line.includes(overrides.hang)) return new Promise<CommandResult>(() => {})
      if (line.startsWith('systemctl start dsh-user') && line.endsWith('.service')) {
        unitActive = true
        await writeFile(join(home, 'ready.json'), JSON.stringify({ kind: 'public-harness/web-ready', port: overrides.readyPort ?? i.webPort, token: 'grant-1' }), { mode: 0o600 })
      }
      if (line.startsWith('systemctl stop') && line.endsWith('.service')) unitActive = false
      if (line.startsWith('xfs_quota') && line.includes('state')) return ok('User quota state\n  Accounting: ON\n  Enforcement: ON\n')
      if (line.startsWith('xfs_quota')) return ok('/dev/vdb 12 0 5242880 00 [--------] 3 0 100000 00 [--------]\n')
      if (line.startsWith('nft list chain')) return ok(`chain out_${uid} {\n counter drop\n}`)
      if (line.startsWith('nft list map')) return ok(`elements = { ${uid} : jump out_${uid} }`)
      if (line.startsWith('systemctl show')) return ok(unitActive ? 'active\n' : 'inactive\n')
      if (line.startsWith('systemd-run') && line.includes('rev-parse')) return { code: 128, stdout: '', stderr: '' }
      return ok()
    },
  }
  const acquired: string[] = []
  const deps: SystemdRuntimeDeps = {
    config: config(), runner, socketGid: gid,
    quota: { healthy: async () => true, open: async () => ({ port: 29100 }), issue: async () => ({ token: 'quota-cred', expiresAt: 1 }),
      close: async () => { events.push('quota-close') } },
    claimedPorts: async () => [29200], active: async () => [],
    acquired: async (_u, _i, resource) => { acquired.push(resource) },
    webProbe: async (port, grant) => overrides.probe ?? (port === i.webPort && grant === 'grant-1'),
    prepare: async () => { events.push('prepare') },
    network: { install: async () => { events.push('nft-install') }, remove: async () => { events.push('nft-remove') } },
    reconcileMarket: { port: 31001 },
    probeHost: { read: async path => {
      if (path.endsWith('cgroup.procs')) return unitActive ? '1\n' : overrides.procs ?? ''
      if (path.endsWith('profiles')) return `${i.account} (enforce)\n${i.account}//chromium (enforce)\n`
      if (path.endsWith('userns')) return '1\n'
      const c = config().limits
      const files: Record<string, string> = { 'cgroup.controllers': 'cpu memory pids', 'memory.max': String(c.memoryBytes), 'memory.swap.max': '0',
        'pids.max': String(c.pids), 'cpu.max': `${c.cpus * 100000} 100000` }
      const name = path.split('/').pop()!
      if (name in files) return files[name]!
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    } },
    startForwarder: async () => ({ close: async () => { events.push('forwarder-close') } }),
    sleep: async () => {}, deadlineSlackMs: 5,
  }
  return { i, home, calls, events, acquired, deps }
}

describe('native lifecycle', () => {
  it('allocates around claimed ports and records resources before relying on them', async () => {
    const h = await harness(), runtime = createSystemdRuntime(h.deps)
    const allocated = await runtime.allocate(instance())
    expect(allocated.webPort).toBe(29201)
    expect(allocated.quotaPort).toBe(29100)
    expect(h.acquired).toEqual(['network', 'quota'])
  })

  it('prepares policy and unit, then runs Git confined as the account', async () => {
    const h = await harness(), runtime = createSystemdRuntime(h.deps)
    await runtime.prepare(h.i)
    expect(h.calls[0]).toMatch(/^apparmor_parser -r -W .*\.apparmor$/)
    expect(h.calls.slice(1)).toEqual([`systemctl link ${h.i.controlDir}/${h.i.runtime.kind === 'systemd' ? h.i.runtime.unit : ''}`, 'systemctl daemon-reload'])
    await runtime.initializeWorkspace(h.i).catch(() => {})
    const git = h.calls.find(line => line.startsWith('systemd-run'))!
    expect(git).toContain(`--uid=${uid}`)
    expect(git).toContain(`--property=AppArmorProfile=${h.i.account}`)
    expect(git).toContain('--property=PrivateNetwork=yes')
    expect(git).toContain('--slice=dsh-user-')
    expect(git).toContain('-- /usr/bin/git')
  })

  it('starts in order and publishes only after enforcement and authenticated readiness', async () => {
    const h = await harness(), runtime = createSystemdRuntime(h.deps)
    const endpoint = await runtime.start(h.i)
    expect(endpoint).toEqual({ kind: 'unix', path: `/run/dsh/sockets/${h.i.account}.sock` })
    const starts = h.calls.filter(line => line.startsWith('systemctl start'))
    expect(starts[0]).toMatch(/\.slice$/)
    expect(starts[1]).toMatch(/\.service$/)
    expect(h.events).toEqual(['nft-install'])
    // Pre-start reconcile between network.install and instance start (P0.4 fixture; no live systemd).
    const reconcile = h.calls.find(line => line.startsWith('systemd-run') && line.includes('RuntimeMaxSec=300'))
    expect(reconcile).toBeDefined()
    expect(reconcile).toContain('IPAddressAllow=localhost')
    expect(reconcile).toContain(`${h.home}/.dsh-market/reconcile-plan.json`)
    expect(reconcile).not.toContain(`${h.i.controlDir}/reconcile-plan.json`)
    expect(reconcile).toContain('--setenv=DSH_MARKET_PORT=31001')
    expect(reconcile).toContain('--market-port=31001')
    const sliceIdx = h.calls.findIndex(line => line.startsWith('systemctl start') && line.endsWith('.slice'))
    const serviceIdx = h.calls.findIndex(line => line.startsWith('systemctl start') && line.endsWith('.service'))
    const reconcileIdx = h.calls.findIndex(line => line.startsWith('systemd-run') && line.includes('RuntimeMaxSec=300'))
    expect(sliceIdx).toBeGreaterThanOrEqual(0)
    expect(reconcileIdx).toBeGreaterThan(sliceIdx)
    expect(serviceIdx).toBeGreaterThan(reconcileIdx)
    const credential = await stat(join(h.home, 'quota-credential.json'))
    expect(credential.mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(h.home, 'quota-credential.json'), 'utf8')).token).toBe('quota-cred')
    expect(await runtime.launchGrant(h.i)).toBe('grant-1')
    expect(await runtime.state(h.i)).toBe('running')
    await runtime.stop(h.i)
    expect(await runtime.state(h.i)).toBe('stopped')
    expect(h.events).toEqual(['nft-install', 'forwarder-close', 'quota-close', 'nft-remove'])
  })

  it.each([
    ['spoofed readiness port', { readyPort: 29999 }, 'spoofed-ready'],
    ['failed authenticated probe', { probe: false }, 'web-probe'],
  ])('rejects %s and tears the partial start down', async (_name, overrides, reason) => {
    const h = await harness(overrides), runtime = createSystemdRuntime(h.deps)
    await expect(runtime.start(h.i)).rejects.toMatchObject({ reason })
    expect(h.calls.some(line => line.startsWith('systemctl stop') && line.endsWith('.service'))).toBe(true)
    expect(h.events).toContain('nft-remove')
    expect(h.events).not.toContain('forwarder-close')
  })

  it('a hung command adapter fails at its deadline instead of holding the user lock', async () => {
    const h = await harness({ hang: 'apparmor_parser' })
    const runtime = createSystemdRuntime({ ...h.deps, config: { ...config(), operationTimeoutMs: 20 } })
    await expect(runtime.prepare(h.i)).rejects.toBeInstanceOf(NativeRuntimeError)
    await expect(runtime.state(h.i)).resolves.toBe('stopped')
  })

  it('a stopped unit with processes left in its cgroup is not reported stopped', async () => {
    const h = await harness({ procs: '4242\n' }), runtime = createSystemdRuntime(h.deps)
    expect(await runtime.state(h.i)).toBe('unknown')
    await expect(runtime.stop(h.i)).rejects.toMatchObject({ reason: 'stop-unverified' })
  })

  it('deletes data only after confirmation, the recovery window and verified quiescence', async () => {
    const h = await harness(), removed: string[] = []
    const runtime = createSystemdRuntime({ ...h.deps, clock: () => 1000 })
    const remove = async () => { removed.push('data') }
    await expect(runtime.purge(h.i, { confirmed: false, recoveryExpiresAt: 0 }, remove, async () => 0)).rejects.toMatchObject({ reason: 'not-confirmed' })
    await expect(runtime.purge(h.i, { confirmed: true, recoveryExpiresAt: 2000 }, remove, async () => 0)).rejects.toMatchObject({ reason: 'recovery-window' })
    await expect(runtime.purge(h.i, { confirmed: true, recoveryExpiresAt: 0 }, remove, async () => 1)).rejects.toMatchObject({ reason: 'not-quiescent' })
    expect(removed).toEqual([])
    await runtime.purge(h.i, { confirmed: true, recoveryExpiresAt: 0 }, remove, async () => 0)
    expect(removed).toEqual(['data'])
  })
})
