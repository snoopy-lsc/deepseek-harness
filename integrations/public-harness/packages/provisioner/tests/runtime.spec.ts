import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveNames } from '../src/accounts.ts'
import { LimitsError, enforceLimits, networkArgument, validateLimits } from '../src/limits.ts'
import { CONTAINER, RuntimeStartError, RuntimeStopError, SIDECAR_PORT, assertSafeRunArgv, buildRunArgv, createRuntime, type QuotaBridge } from '../src/runtime.ts'
import { startSidecar } from '../src/sidecar.ts'
import { readReady, waitForReady } from '../src/token-channel.ts'
import type { CommandRunner } from '../src/system.ts'
import type { UserRecord } from '../src/users.ts'
import { FakeRunner, alice, gid, makeConfig, uid } from './helpers.ts'
import { layoutFor } from '../src/storage.ts'
import { connect, createServer } from 'node:net'

const TOKEN = 'launch-token-SECRET-123'
const controllers = { controllers: async () => ['cpuset', 'cpu', 'io', 'memory', 'hugetlb', 'pids'] }

async function setup(options: { quotaHealthy?: boolean; busyPorts?: number[]; imageArchive?: string } = {}) {
  const busyPorts = options.busyPorts
  const config = await makeConfig(options.imageArchive === undefined ? {} : { imageArchive: options.imageArchive })
  const account = deriveNames(alice)
  const layout = layoutFor(config.paths, account.account)
  for (const dir of [layout.root, layout.home, layout.workspace, layout.ctl, layout.podman]) await mkdir(dir, { recursive: true, mode: 0o700 })
  const record: UserRecord = { userId: alice, account: account.account, container: account.container, uid, gid, lifecycle: 'starting', layout }
  const runner = new FakeRunner()
  const forwarded: Array<{ socketPath: string; port: number; gid: number }> = []
  let forwarderClosed = 0
  const quotaCalls: string[] = []
  const quota: QuotaBridge = {
    healthy: async () => options.quotaHealthy ?? true,
    open: async () => { quotaCalls.push('open'); return { port: 29100 } },
    issue: async () => ({ token: 'quota-token.signed', expiresAt: Date.now() + 600_000 }),
    close: async () => { quotaCalls.push('close') },
  }
  let now = 0
  runner.handler = async (command, args) => {
    const joined = args.join(' ')
    if (joined.includes(' run ') || args.includes('run')) {
      await writeFile(join(layout.ctl, 'ready.json'), JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: TOKEN }), { mode: 0o600 })
      return { code: 0, stdout: 'abcdef\n', stderr: '' }
    }
    return undefined
  }
  const runtime = createRuntime({ config, runner, quota, probe: controllers, publicHost: 'harness.example.test',
    startForwarder: async options => { forwarded.push(options); return { close: async () => { forwarderClosed += 1 } } },
    healthProbe: async () => true, portFree: async port => !(busyPorts ?? []).includes(port), sleep: async ms => { now += ms }, clock: () => now })
  return { config, record, runner, runtime, forwarded, quotaCalls, closed: () => forwarderClosed, layout }
}

describe('mandatory limits', () => {
  const good = { cpus: 1, memoryBytes: 1 << 30, pids: 256, openFiles: 4096, diskBytes: 5 * 2 ** 30, network: 'pasta' }
  it('accepts a complete set', () => expect(validateLimits(good)).toMatchObject({ pids: 256 }))
  it.each(['cpus', 'memoryBytes', 'pids', 'openFiles', 'diskBytes', 'network'])('rejects a missing %s', key => {
    expect(() => validateLimits({ ...good, [key]: undefined })).toThrow(LimitsError)
  })
  it.each([0, -1, Number.NaN])('rejects a non-positive limit %s', value => {
    expect(() => validateLimits({ ...good, pids: value })).toThrow(LimitsError)
  })
  it.each([[255, 1 << 30], [4096, (512 << 20) - 1]])('rejects limits that leave no room for the Harness (pids %s, memory %s)', (pids, memoryBytes) => {
    expect(() => validateLimits({ ...good, pids, memoryBytes })).toThrow(LimitsError)
  })
  it('requires every delegated controller the rootless gVisor runtime needs', async () => {
    const tools = { setquota: '/usr/sbin/setquota', nft: '/usr/sbin/nft', quotaMount: '/srv' }
    const limits = validateLimits(good)
    for (const missing of ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids']) {
      const present = ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'].filter(name => name !== missing)
      await expect(enforceLimits(new FakeRunner(), { controllers: async () => present }, tools, limits, 1001)).rejects.toThrow(new RegExp(`controller ${missing} `))
    }
  })
  it.each(['host', 'none', 'container:other', 'ns:/proc/1/ns/net', 'bridge', 'pasta; rm', 'pasta:--map-host-loopback,10.0.2.2', 'pasta:--splice', ''])('rejects network %j', network => {
    expect(() => validateLimits({ ...good, network })).toThrow(LimitsError)
  })

  it('fails closed when the host cannot enforce a limit', async () => {
    const tools = { setquota: '/usr/sbin/setquota', nft: '/usr/sbin/nft', quotaMount: '/srv' }
    const limits = validateLimits(good)
    const runner = new FakeRunner()
    await expect(enforceLimits(runner, { controllers: async () => ['cpu', 'memory'] }, tools, limits, 1001)).rejects.toThrow(/controller/)
    await expect(enforceLimits(runner, { controllers: async () => { throw new Error('x') } }, tools, limits, 1001)).rejects.toThrow(/cgroup/)
    runner.handler = command => command.endsWith('nft') ? { code: 1, stdout: '', stderr: '' } : undefined
    await expect(enforceLimits(runner, controllers, tools, limits, 1001)).rejects.toThrow(/firewall/)
    runner.handler = command => command.endsWith('setquota') ? { code: 1, stdout: '', stderr: '' } : undefined
    await expect(enforceLimits(runner, controllers, tools, limits, 1001)).rejects.toThrow(/disk quota/)
    runner.handler = () => undefined
    await enforceLimits(runner, controllers, tools, limits, 1001)
    expect(runner.calls.at(-1)).toEqual({ command: '/usr/sbin/setquota', args: ['-u', '1001', '0', String(5 * 1024 * 1024), '0', '0', '/srv'] })
  })
})

describe('confined container launch', () => {
  it('always runs pasta with --no-splice and the quota host-loopback mapping', () => {
    expect(networkArgument('pasta', '10.0.2.2')).toBe('pasta:--map-host-loopback,10.0.2.2,--no-splice')
    expect(networkArgument('slirp4netns', '10.0.2.2')).toBe('slirp4netns:allow_host_loopback=true')
  })

  it('uses exactly the planned argv: runsc, read-only root, no capabilities, four mounts, loopback-only publish', async () => {
    const { config, record } = await setup()
    const argv = buildRunArgv(config, record, 29200)
    expect(argv.slice(0, 6)).toEqual(['--runtime', '/usr/bin/runsc', 'run', '--detach', '--replace', '--name'])
    const volumes = argv.flatMap((arg, index) => arg === '--volume' ? [argv[index + 1]] : [])
    expect(volumes).toEqual([`${record.layout.home}:/home/harness:rw,Z`, `${record.layout.workspace}:/workspace:rw,Z`,
      `${record.layout.ctl}:/run/harness-ctl:rw,Z`, `${config.paths.runtimeAssets}:/opt/public-harness:ro,Z`])
    expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'all', '--read-only', '--publish', `127.0.0.1:29200:${SIDECAR_PORT}`,
      '--pids-limit', '256', '--memory', String(1 << 30), '--memory-swap', String(1 << 30), '--cpus', '1']))
    expect(argv[argv.indexOf('--network') + 1]).toBe('pasta:--map-host-loopback,10.0.2.2,--no-splice')
    expect(argv.slice(-3)).toEqual([config.image, 'node', '/opt/public-harness/container-entry.js'])
    const text = argv.join(' ')
    for (const forbidden of ['privileged', 'docker.sock', 'podman.sock', '--network host', '--cap-add', 'ANTHROPIC', 'DEEPSEEK', 'API_KEY']) {
      expect(text).not.toContain(forbidden)
    }
    expect(() => assertSafeRunArgv(argv, config, record)).not.toThrow()
  })

  it.each([
    [['--volume', '/var/run/podman/podman.sock:/p.sock:rw,Z']],
    [['--volume', '/home/other/home:/x:rw,Z']],
    [['--privileged']],
    [['--cap-add', 'SYS_ADMIN']],
    [['--device', '/dev/kvm']],
    [['--userns', 'host']],
    [['--pid', 'host']],
    [['--network', 'host']],
    [['--network', 'pasta:--map-host-loopback,10.0.2.2']],
    [['--publish', '0.0.0.0:80:80']],
    [['--publish', '127.0.0.1::8081']],
    [['--publish', '127.0.0.1:5432:8081']],
    [['--publish', '127.0.0.1:29299:8081']],
    [['--publish', '127.0.0.1:29200:22']],
    [['--mount', 'type=bind,src=/,dst=/h']],
    [['--add-host', 'x:10.0.0.1']],
  ])('refuses a forbidden grant %j', async extra => {
    const { config, record } = await setup()
    const argv = buildRunArgv(config, record, 29200)
    argv.splice(argv.indexOf(config.image), 0, ...extra)
    expect(() => assertSafeRunArgv(argv, config, record)).toThrow(RuntimeStartError)
  })

  it('publishes the sidecar on a port of the configured range, skipping busy and live ports', async () => {
    const { runner, runtime, record, config } = await setup({ busyPorts: [29200, 29201] })
    await runtime.start(record)
    const argv = runner.calls.find(call => call.args.includes('run'))!.args
    expect(argv[argv.indexOf('--publish') + 1]).toBe(`127.0.0.1:29202:${SIDECAR_PORT}`)
    expect(config.ports.sidecar).toEqual({ min: 29200, max: 29209 })
    // A restart takes the next port instead of reusing one that may still be draining.
    await runtime.start(record)
    const second = runner.calls.filter(call => call.args.includes('run')).at(-1)!.args
    expect(second[second.indexOf('--publish') + 1]).toBe(`127.0.0.1:29203:${SIDECAR_PORT}`)
  })

  it('refuses to start when every sidecar port is taken', async () => {
    const { runner, runtime, record } = await setup({ busyPorts: Array.from({ length: 10 }, (_, index) => 29200 + index) })
    await expect(runtime.start(record)).rejects.toMatchObject({ reason: 'no-port' })
    expect(runner.calls.some(call => call.args.includes('run'))).toBe(false)
  })

  it('refuses a quota listener outside the firewall-allowed range', async () => {
    const { config, record } = await setup()
    const runner = new FakeRunner()
    const runtime = createRuntime({ config, runner, quota: { healthy: async () => true, open: async () => ({ port: 29110 }),
      issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: controllers, publicHost: 'h.test', portFree: async () => true })
    await expect(runtime.start(record)).rejects.toMatchObject({ reason: 'quota-unavailable' })
    expect(runner.calls.some(call => call.args.includes('run'))).toBe(false)
  })

  describe('instance image in the account store', () => {
    const podman = (runner: FakeRunner): string[][] => runner.calls.map(call => call.args.slice(call.args.indexOf('/usr/bin/podman') + 1))
      .filter(args => args[0] === 'image' || args[0] === 'load' || args[0] === 'pull')

    it('does nothing when the account already has the image', async () => {
      const { runner, runtime, record } = await setup()
      await runtime.start(record)
      expect(podman(runner)).toEqual([['image', 'exists', 'localhost/dsh-instance:1']])
    })

    it('loads the archive into the account store before the first start, then verifies the reference', async () => {
      const { runner, runtime, record, config } = await setup({ imageArchive: '/opt/dsh-public/image/dsh-instance.tar' })
      let loaded = false
      const inner = runner.handler
      runner.handler = (command, args) => {
        if (args.includes('exists')) return { code: loaded ? 0 : 1, stdout: '', stderr: '' }
        if (args.includes('load')) { loaded = true; return { code: 0, stdout: '', stderr: '' } }
        return inner(command, args)
      }
      await runtime.start(record)
      expect(podman(runner)).toEqual([['image', 'exists', config.image], ['image', 'exists', config.image],
        ['load', '--quiet', '--input', '/opt/dsh-public/image/dsh-instance.tar'], ['image', 'exists', config.image]])
      // Every podman call for the load ran as the account, never as root.
      const load = runner.calls.find(call => call.args.includes('load'))!
      expect(load.args.slice(0, 3)).toEqual(['-u', record.account, '--'])
      expect(runner.calls.findIndex(call => call.args.includes('load'))).toBeLessThan(runner.calls.findIndex(call => call.args.includes('run')))
    })

    it('pulls from the registry when no archive is configured', async () => {
      const { runner, runtime, record } = await setup()
      let pulled = false
      const inner = runner.handler
      runner.handler = (command, args) => {
        if (args.includes('exists')) return { code: pulled ? 0 : 1, stdout: '', stderr: '' }
        if (args.includes('pull')) { pulled = true; return { code: 0, stdout: '', stderr: '' } }
        return inner(command, args)
      }
      await runtime.start(record)
      expect(podman(runner).some(args => args[0] === 'pull' && args.includes('localhost/dsh-instance:1'))).toBe(true)
    })

    it.each([['the load fails', 1, false], ['the archive does not provide the configured reference', 0, false]])('refuses to start and creates nothing when %s', async (_name, code, present) => {
      const { runner, runtime, record } = await setup({ imageArchive: '/opt/dsh-public/image/dsh-instance.tar' })
      runner.handler = (_command, args) => args.includes('exists') ? { code: present ? 0 : 1, stdout: '', stderr: '' }
        : args.includes('load') ? { code, stdout: '', stderr: 'secret detail' } : undefined
      const error = await runtime.start(record).catch((e: unknown) => e)
      expect(error).toMatchObject({ reason: 'image-unavailable' })
      expect(String((error as Error).message)).not.toContain('secret')
      expect(runner.calls.some(call => call.args.includes('run'))).toBe(false)
    })

    it('loads for one account at a time', async () => {
      const { runtime, record, config } = await setup({ imageArchive: '/opt/dsh-public/image/dsh-instance.tar' })
      let active = 0
      let peak = 0
      const loaded = new Set<string>()
      const runner: CommandRunner = { run: async (_command, args) => {
        const account = args[1]!
        if (args.includes('exists')) return { code: loaded.has(account) ? 0 : 1, stdout: '', stderr: '' }
        if (args.includes('load')) {
          active += 1; peak = Math.max(peak, active)
          await new Promise(resolve => setTimeout(resolve, 20))
          active -= 1; loaded.add(account)
        }
        // Host tools succeed; the container start fails so each start ends right after its image step.
        return { code: args.includes('run') ? 1 : 0, stdout: '', stderr: '' }
      } }
      const shared = createRuntime({ config, runner, quota: { healthy: async () => true, open: async () => ({ port: 29100 }),
        issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: controllers, publicHost: 'h.test', portFree: async () => true })
      const others = ['a1', 'a2', 'a3'].map(account => ({ ...record, account }))
      await Promise.all(others.map(other => shared.start(other).catch(() => {})))
      expect(loaded.size).toBe(3)
      expect(peak).toBe(1)
    })
  })

  it('refuses to start without gVisor and creates nothing', async () => {
    const { runner, runtime, record } = await setup()
    runner.handler = command => command.endsWith('runsc') ? { code: 127, stdout: '', stderr: '' } : undefined
    await expect(runtime.start(record)).rejects.toMatchObject({ reason: 'gvisor-unavailable' })
    expect(runner.calls.some(call => call.args.includes('run'))).toBe(false)
  })

  it('refuses to start when a limit is unenforceable', async () => {
    const { config, record } = await setup()
    const runner = new FakeRunner()
    const runtime = createRuntime({ config, runner, quota: { healthy: async () => true, open: async () => ({ port: 1 }),
      issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: { controllers: async () => ['cpu'] }, publicHost: 'h.test' })
    await expect(runtime.start(record)).rejects.toMatchObject({ reason: 'limits' })
    expect(runner.calls).toHaveLength(0)
  })

  it('refuses to start when the quota proxy is unavailable', async () => {
    const { runner, runtime, record } = await setup({ quotaHealthy: false })
    await expect(runtime.start(record)).rejects.toMatchObject({ reason: 'quota-unavailable' })
    expect(runner.calls.some(call => call.args.includes('run'))).toBe(false)
  })

  it('starts, publishes a restricted socket, and never puts the launch token in a command', async () => {
    const { runner, runtime, record, forwarded, config, quotaCalls, layout } = await setup()
    const endpoint = await runtime.start(record)
    expect(endpoint).toEqual({ kind: 'unix', path: layout.socketPath })
    expect(forwarded).toEqual([{ socketPath: layout.socketPath, port: 29200, gid: config.socketGid }])
    expect(JSON.stringify(runner.calls)).not.toContain(TOKEN)
    const runCall = runner.calls.find(call => call.args.includes('run'))!
    expect(runCall.command).toBe('/usr/sbin/runuser')
    expect(runCall.args.slice(0, 5)).toEqual(['-u', record.account, '--', '/usr/bin/env', '-i'])
    expect(quotaCalls).toEqual(['close', 'open'])
    expect(await runtime.launchGrant(record)).toBe(TOKEN)
  })

  it('the launch grant is reusable until the instance restarts, then a new one replaces it', async () => {
    const { runner, runtime, record, layout } = await setup()
    await runtime.start(record)
    expect(await runtime.launchGrant(record)).toBe(TOKEN)
    expect(await runtime.launchGrant(record)).toBe(TOKEN)
    const inner = runner.handler
    runner.handler = async (command, args) => {
      if (args.includes('run')) {
        await writeFile(join(layout.ctl, 'ready.json'), JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: 'second-launch-token' }), { mode: 0o600 })
        return { code: 0, stdout: 'abcdef\n', stderr: '' }
      }
      return inner(command, args)
    }
    await runtime.start(record)
    expect(await runtime.launchGrant(record)).toBe('second-launch-token')
    await runtime.stop(record)
    await expect(runtime.launchGrant(record)).rejects.toThrow(/unavailable/)
  })

  it('stop removes the container, closes the forwarder, and clears the token file', async () => {
    const { runner, runtime, record, closed } = await setup()
    await runtime.start(record)
    await runtime.stop(record)
    expect(closed()).toBe(1)
    expect(runner.calls.at(-1)!.args).toEqual(expect.arrayContaining(['rm', '--force', '--ignore', record.container]))
    await expect(runtime.launchGrant(record)).rejects.toThrow(/unavailable/)
  })

  it('times out with a generic error and tears down when readiness never arrives', async () => {
    const { runner, runtime, record } = await setup()
    runner.handler = (_command, args) => args.includes('run') ? { code: 0, stdout: '', stderr: '' } : undefined
    const error = await runtime.start(record).catch((e: unknown) => e)
    expect(error).toMatchObject({ reason: 'not-ready' })
    expect(String((error as Error).message)).not.toContain(record.layout.root)
    expect(runner.calls.at(-1)!.args).toContain('rm')
  })

  it('reports a failed container start without argv or output', async () => {
    const { runner, runtime, record } = await setup()
    runner.handler = (command, args) => args.includes('run') ? { code: 125, stdout: TOKEN, stderr: TOKEN } : undefined
    const error = (await runtime.start(record).catch((e: unknown) => e)) as Error
    expect(error.message).toBe('runtime start refused: start-failed')
  })
})

describe('private token channel', () => {
  it('rejects symlinks, public files, and files owned by someone else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ctl-'))
    await chmod(dir, 0o700)
    const body = JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: TOKEN })
    await writeFile(join(dir, 'real.json'), body, { mode: 0o600 })
    await symlink(join(dir, 'real.json'), join(dir, 'ready.json'))
    await expect(readReady(dir, uid)).rejects.toThrow(/not readable/)
    const second = await mkdtemp(join(tmpdir(), 'dsh-ctl-'))
    await writeFile(join(second, 'ready.json'), body, { mode: 0o644 })
    await chmod(join(second, 'ready.json'), 0o644)
    await expect(readReady(second, uid)).rejects.toThrow(/private regular file/)
    const third = await mkdtemp(join(tmpdir(), 'dsh-ctl-'))
    await writeFile(join(third, 'ready.json'), body, { mode: 0o600 })
    const error = (await readReady(third, uid + 1).catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain(TOKEN)
    expect(await readReady(third, uid)).toEqual({ port: 8080, token: TOKEN })
  })

  it('rejects unknown fields and times out without echoing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ctl-'))
    await writeFile(join(dir, 'ready.json'), JSON.stringify({ kind: 'public-harness/web-ready', port: 1, token: TOKEN, extra: 1 }), { mode: 0o600 })
    await expect(readReady(dir, uid)).rejects.toThrow('invalid readiness file')
    const empty = await mkdtemp(join(tmpdir(), 'dsh-ctl-'))
    let now = 0
    await expect(waitForReady(empty, uid, 500, 100, async ms => { now += ms }, () => now)).rejects.toThrow('readiness timed out')
  })
})

describe('in-container sidecar', () => {
  it('relays connections to the Web loopback port', async () => {
    const target = createServer(socket => socket.end('hello'))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port
    const sidecar = await startSidecar({ listenHost: '127.0.0.1', listenPort: 0, targetPort })
    const port = (sidecar.address() as { port: number }).port
    const received = await new Promise<string>(resolve => {
      const socket = connect({ host: '127.0.0.1', port })
      let data = ''
      socket.on('data', chunk => { data += chunk }).on('close', () => resolve(data))
    })
    expect(received).toBe('hello')
    sidecar.close(); target.close()
  })
})

describe('stopping and inspecting containers', () => {
  const rmCalls = (runner: { calls: Array<{ command: string; args: string[] }> }): string[][] => runner.calls.filter(call => call.args.includes('rm') || call.args.includes('kill')).map(call => call.args.slice(call.args.indexOf('/usr/bin/podman') + 1))

  it('reads the real container state: running, stopped, gone, or unknown', async () => {
    const { runner, runtime, record } = await setup()
    const answer = (code: number, stdout = '', stderr = ''): void => { runner.handler = () => ({ code, stdout, stderr }) }
    answer(0, 'true\n'); expect(await runtime.state(record)).toBe('running'); expect(await runtime.isRunning(record)).toBe(true)
    answer(0, 'false\n'); expect(await runtime.state(record)).toBe('stopped'); expect(await runtime.isRunning(record)).toBe(false)
    answer(125, '', 'Error: no such container abc'); expect(await runtime.state(record)).toBe('stopped')
    answer(125, '', 'Error: something else'); expect(await runtime.state(record)).toBe('unknown')
    answer(127); expect(await runtime.state(record)).toBe('unknown')
  })

  it('escalates to kill and a forced remove when the polite stop fails, then succeeds', async () => {
    const { runner, runtime, record } = await setup()
    let polite = true
    runner.handler = (_command, args) => args.includes('rm') && polite && args.includes('--time') ? ((polite = false), { code: 127, stdout: '', stderr: '' }) : undefined
    await runtime.stop(record)
    expect(rmCalls(runner)).toEqual([
      ['rm', '--force', '--ignore', '--time', '5', record.container],
      ['kill', '--signal', 'KILL', record.container],
      ['rm', '--force', '--ignore', record.container]])
  })

  it('does not wait forever on a runner that never answers: the deadline escalates to kill', async () => {
    const config = await makeConfig({ stopTimeoutMs: 20 })
    const base = await setup()
    const calls: Array<{ command: string; args: string[] }> = []
    let hung = 0
    const runner: CommandRunner = { run: async (command, args, options) => {
      calls.push({ command, args: [...args] })
      // The first, polite remove never returns (a stuck container engine); everything after it answers normally.
      if (args.includes('--time') && hung++ === 0) { expect(options?.timeoutMs).toBe(20 + 15); return new Promise(() => {}) }
      return { code: 0, stdout: '', stderr: '' }
    } }
    const runtime = createRuntime({ config, runner, quota: { healthy: async () => true, open: async () => ({ port: 29100 }),
      issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: controllers, publicHost: 'h.test',
      stopGraceMs: 15, deadlineSlackMs: 10 })
    const started = Date.now()
    await runtime.stop(base.record)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rmCalls({ calls }).map(args => args[0])).toEqual(['rm', 'kill', 'rm'])
  })

  it('fails loudly, but still clears the launch token, when the container cannot be removed', async () => {
    const { runner, runtime, record, layout } = await setup()
    await runtime.start(record)
    runner.handler = (_command, args) => args.includes('rm') || args.includes('kill') ? { code: 1, stdout: '', stderr: '' }
      : args.includes('inspect') ? { code: 0, stdout: 'true\n', stderr: '' } : undefined
    await expect(runtime.stop(record)).rejects.toBeInstanceOf(RuntimeStopError)
    await expect(readReady(layout.ctl, uid)).resolves.toBeUndefined()
  })

  it('accepts a failed remove when the container turns out to be gone', async () => {
    const { runner, runtime, record } = await setup()
    runner.handler = (_command, args) => args.includes('rm') ? { code: 1, stdout: '', stderr: '' }
      : args.includes('inspect') ? { code: 125, stdout: '', stderr: 'no such container' } : undefined
    await expect(runtime.stop(record)).resolves.toBeUndefined()
  })
})
