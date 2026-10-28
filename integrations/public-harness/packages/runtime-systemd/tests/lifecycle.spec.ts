import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeInstance } from '@public-harness/contracts'
import type { CommandResult, CommandRunner } from '@public-harness/provisioner/system'
import { createSystemdRuntime, NativeRuntimeError, type SystemdRuntimeDeps } from '../src/runtime.ts'
import { parseSystemdConfig } from '../src/config.ts'
import { common, config, instance, native } from './fixture.ts'

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

describe('native market owner admission (inet dsh_market market_owner)', () => {
  const marketConfig = () => parseSystemdConfig({ common: { ...common, ports: { ...common.ports, market: { min: 30_000, max: 30_099 } } }, native })
  /** Wrap the lifecycle harness with ports.market, a market bridge and an in-memory market_owner set. */
  async function marketHarness(options: { port?: number; open?: 'fail'; table?: boolean; reload?: boolean } = {}) {
    const h = await harness()
    let owners: { uid: number; port: number }[] = [], table = options.table ?? true
    const market: string[] = [], alerts: string[] = []
    const inner = h.deps.runner
    const runner: CommandRunner = {
      async run(command, args, opts) {
        const line = `${command.split('/').pop()} ${args.join(' ')}`
        const elements = (text: string) => [...text.matchAll(/(\d+) \. (\d+)/g)].map(m => ({ uid: Number(m[1]), port: Number(m[2]) }))
        if (line === 'nft list set inet dsh_market market_owner') {
          h.calls.push(line)
          if (!table) return { code: 1, stdout: '', stderr: '' }
          return ok(`table inet dsh_market {\n\tset market_owner {\n\t\ttype mark . inet_service\n${owners.length ? `\t\telements = { ${owners.map(o => `0x${o.uid.toString(16).padStart(8, '0')} . ${o.port}`).join(', ')} }\n` : ''}\t}\n}`)
        }
        if (line === 'nft list table inet dsh_market') {
          h.calls.push(line)
          return table ? ok('table inet dsh_market {\n\tset market_owner {\n\t}\n\tchain input {\n\t}\n\tchain market_listener {\n\t}\n}') : { code: 1, stdout: '', stderr: '' }
        }
        if (line.startsWith('nft add element inet dsh_market market_owner ')) {
          h.calls.push(line)
          if (!table) return { code: 1, stdout: '', stderr: '' }
          for (const row of elements(args.at(-1)!)) if (!owners.some(o => o.uid === row.uid && o.port === row.port)) owners.push(row)
          return ok()
        }
        if (line.startsWith('nft delete element inet dsh_market market_owner ')) {
          h.calls.push(line)
          const drop = elements(args.at(-1)!)
          owners = owners.filter(o => !drop.some(d => d.uid === o.uid && d.port === o.port))
          return ok()
        }
        if (line.startsWith('load-dsh-market.sh')) { h.calls.push(line); if (options.reload !== false) table = true; return options.reload === false ? { code: 1, stdout: '', stderr: '' } : ok() }
        return inner.run(command, args, opts)
      },
    }
    const deps: SystemdRuntimeDeps = {
      ...h.deps, config: marketConfig(), runner, reconcileMarket: undefined,
      market: {
        open: async (userId, _instanceId, accountUid) => {
          market.push(`open:${userId}:${accountUid}`)
          if (options.open === 'fail') throw new Error('plugins down')
          return { port: options.port ?? 30_005, token: 'market-token' }
        },
        close: async userId => { market.push(`close:${userId}`) },
      },
      marketFirewall: { probeMs: 0, onAlert: row => { alerts.push(`${row.uid}.${row.port}`) } },
    }
    return { ...h, deps, market, alerts, owners: () => owners, setOwners: (rows: { uid: number; port: number }[]) => { owners = rows },
      dropTable: () => { table = false; owners = [] } }
  }

  it('admits only the owner pair before the reconcile one-shot and the instance, and removes it on stop', async () => {
    const h = await marketHarness(), runtime = createSystemdRuntime(h.deps)
    h.setOwners([{ uid: 4242, port: 30_005 }, { uid: h.i.uid, port: 30_009 }, { uid: 1300, port: 30_010 }])
    await runtime.start(h.i)
    // Stale pairs sharing the port or the uid are deleted; unrelated owners stay.
    expect(h.owners()).toEqual([{ uid: 1300, port: 30_010 }, { uid: h.i.uid, port: 30_005 }])
    expect(h.market).toEqual([`open:${h.i.userId}:${h.i.uid}`])
    const add = h.calls.findIndex(line => line === `nft add element inet dsh_market market_owner { ${h.i.uid} . 30005 }`)
    const install = h.calls.findIndex(line => line.startsWith('systemctl start') && line.endsWith('.slice'))
    const reconcile = h.calls.findIndex(line => line.startsWith('systemd-run') && line.includes('RuntimeMaxSec=300'))
    const service = h.calls.findIndex(line => line.startsWith('systemctl start') && line.endsWith('.service'))
    expect(add).toBeGreaterThan(install)
    expect(reconcile).toBeGreaterThan(add)
    expect(service).toBeGreaterThan(reconcile)
    // The default reconcile one-shot dials the admitted port.
    expect(h.calls[reconcile]).toContain('--market-port=30005')
    await runtime.stop(h.i)
    expect(h.owners()).toEqual([{ uid: 1300, port: 30_010 }])
    expect(h.market).toEqual([`open:${h.i.userId}:${h.i.uid}`, `close:${h.i.userId}`])
  })

  it('starts without the market when the endpoint is unavailable or outside ports.market', async () => {
    for (const options of [{ open: 'fail' as const }, { port: 31_500 }]) {
      const h = await marketHarness(options), runtime = createSystemdRuntime(h.deps)
      await runtime.start(h.i)
      expect(h.owners()).toEqual([])
      expect(h.calls.some(line => line.startsWith('nft add element'))).toBe(false)
      expect(h.calls.some(line => line.startsWith('systemd-run') && line.includes('RuntimeMaxSec=300'))).toBe(false)
      await runtime.stop(h.i)
    }
  })

  it('starts without the market when the table is missing (owner shut out, no global failure)', async () => {
    const h = await marketHarness({ table: false }), runtime = createSystemdRuntime(h.deps)
    await expect(runtime.start(h.i)).resolves.toMatchObject({ kind: 'unix' })
    expect(h.market).toEqual([`open:${h.i.userId}:${h.i.uid}`, `close:${h.i.userId}`])
    await runtime.stop(h.i)
  })

  it('stop removes pairs left by an earlier provisioner run for the same uid', async () => {
    const h = await marketHarness(), runtime = createSystemdRuntime(h.deps)
    h.setOwners([{ uid: h.i.uid, port: 30_007 }, { uid: 1300, port: 30_010 }])
    await runtime.stop(h.i)
    expect(h.owners()).toEqual([{ uid: 1300, port: 30_010 }])
  })

  it('probe reloads a flushed table, restores admitted owners, and deletes and then alerts on strangers', async () => {
    const h = await marketHarness(), runtime = createSystemdRuntime(h.deps)
    await runtime.start(h.i)
    h.dropTable()
    await runtime.probeMarket()
    expect(h.calls).toContain('load-dsh-market.sh /etc/dsh-public/dsh-market.nft')
    expect(h.owners()).toEqual([{ uid: h.i.uid, port: 30_005 }])
    h.setOwners([...h.owners(), { uid: 9999, port: 30_050 }])
    await runtime.probeMarket()
    expect(h.owners()).toEqual([{ uid: h.i.uid, port: 30_005 }])
    expect(h.alerts).toEqual([])
    h.setOwners([...h.owners(), { uid: 9999, port: 30_050 }])
    await runtime.probeMarket()
    expect(h.alerts).toEqual(['9999.30050'])
    await runtime.stop(h.i)
    await runtime.close()
  })

  it('a failed reload leaves the market closed and reports the failure', async () => {
    const h = await marketHarness({ reload: false }), runtime = createSystemdRuntime(h.deps)
    await runtime.start(h.i)
    h.dropTable()
    // The loader fails; the socket restart (mocked as a no-op) does not bring the table back either.
    await expect(runtime.probeMarket()).rejects.toThrow(/market_owner unreadable/)
    expect(h.calls).toContain('systemctl restart dsh-plugins.socket')
    expect(h.owners()).toEqual([])
  })

  it('never touches inet dsh_market without ports.market or without a market bridge', async () => {
    const h = await harness(), runtime = createSystemdRuntime({ ...h.deps, market: { open: async () => ({ port: 30_005, token: 't' }), close: async () => {} } })
    await runtime.start(h.i)
    await runtime.probeMarket()
    await runtime.stop(h.i)
    expect(h.calls.some(line => line.includes('dsh_market'))).toBe(false)
  })
})
