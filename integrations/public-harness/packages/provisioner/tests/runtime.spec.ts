import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveNames } from '../src/accounts.ts'
import { LimitsError, enforceLimits, networkArgument, validateLimits } from '../src/limits.ts'
import { CONTAINER, RuntimeStartError, SIDECAR_PORT, assertSafeRunArgv, buildRunArgv, createRuntime, type QuotaBridge } from '../src/runtime.ts'
import { startSidecar } from '../src/sidecar.ts'
import { readReady, waitForReady } from '../src/token-channel.ts'
import type { UserRecord } from '../src/users.ts'
import { FakeRunner, alice, gid, makeConfig, uid } from './helpers.ts'
import { layoutFor } from '../src/storage.ts'
import { connect, createServer } from 'node:net'

const TOKEN = 'launch-token-SECRET-123'
const controllers = { controllers: async () => ['cpu', 'memory', 'pids', 'io'] }

async function setup(options: { quotaHealthy?: boolean; busyPorts?: number[] } = {}) {
  const busyPorts = options.busyPorts
  const config = await makeConfig()
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
  it.each(['host', 'none', 'container:other', 'ns:/proc/1/ns/net', 'bridge', 'pasta; rm', 'pasta:--map-host-loopback,10.0.2.2', 'pasta:--splice', ''])('rejects network %j', network => {
    expect(() => validateLimits({ ...good, network })).toThrow(LimitsError)
  })

  it('fails closed when the host cannot enforce a limit', async () => {
    const tools = { setquota: '/usr/sbin/setquota', nft: '/usr/sbin/nft', quotaMount: '/srv' }
    const limits = validateLimits(good)
    const runner = new FakeRunner()
    await expect(enforceLimits(runner, { controllers: async () => ['cpu', 'memory'] }, tools, limits, 1001)).rejects.toThrow(/pids/)
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
