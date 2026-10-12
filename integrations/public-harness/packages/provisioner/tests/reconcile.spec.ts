import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, type InstanceEndpoint } from '@public-harness/contracts'
import { deriveNames } from '../src/accounts.ts'
import { DeletionNotAllowedError, sweepSockets } from '../src/reconcile.ts'
import { RuntimeStartError, type Runtime } from '../src/runtime.ts'
import { createProvisionerService } from '../src/service.ts'
import { alice, bob, makeHarness } from './helpers.ts'

class FakeRuntime implements Runtime {
  readonly started: string[] = []
  readonly stopped: string[] = []
  async start(record: { account: string; layout: { socketPath: string } }): Promise<InstanceEndpoint> {
    this.started.push(record.account)
    return { kind: 'unix', path: record.layout.socketPath }
  }
  async stop(record: { account: string }): Promise<void> { this.stopped.push(record.account) }
  async launchGrant(): Promise<string> { return 'grant' }
  alive = true
  async isRunning(): Promise<boolean> { return this.alive }
  async state(): Promise<'running' | 'stopped' | 'unknown'> { return this.alive ? 'running' : 'stopped' }
}

async function service(overrides = {}) {
  const h = await makeHarness(overrides)
  const runtime = new FakeRuntime()
  const svc = createProvisionerService({ config: h.config, quota: { healthy: async () => true, open: async () => ({ port: 1 }),
    issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: { controllers: async () => [] },
    publicHost: 'h.test', runner: h.runner, directory: h.directory, store: h.store, users: h.users, runtime, clock: () => h.clock.now })
  const call = (op: 'ensure' | 'launch-grant' | 'stop' | 'status', userId = alice) => svc.handler({ op, userId })
  return { h, runtime, svc, call }
}

describe.skipIf(process.platform === 'win32')('suspend, restart, and recovery', () => {
  it('starts one runtime for concurrent first requests and reuses it', async () => {
    const { runtime, call } = await service()
    const results = await Promise.all(Array.from({ length: 5 }, () => call('ensure')))
    expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1)
    expect(runtime.started).toHaveLength(1)
    expect(await call('status')).toBe('running')
    expect(await call('launch-grant')).toBe('grant')
  })

  it('reports capacity as a typed refusal and creates nothing for the second user', async () => {
    const { h, runtime, call } = await service({ maxActiveInstances: 1 })
    await call('ensure')
    await expect(call('ensure', bob)).rejects.toBeInstanceOf(CapacityError)
    expect(runtime.started).toHaveLength(1)
    expect(h.directory.created).toHaveLength(1)
    expect(await call('status', bob)).toBe('absent')
  })

  it('recovers after a host reboot: stale running records stop cleanly and wake on demand', async () => {
    const { h, runtime, svc, call } = await service()
    await call('ensure')
    // A reboot loses the in-memory routing table; the durable record still says running.
    const fresh = createProvisionerService({ config: h.config, quota: { healthy: async () => true, open: async () => ({ port: 1 }),
      issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} }, probe: { controllers: async () => [] }, publicHost: 'h.test',
      runner: h.runner, directory: h.directory, store: h.store, users: h.users, runtime, clock: () => h.clock.now })
    expect((await h.store.get(alice))?.lifecycle).toBe('running')
    const report = await fresh.lifecycle.reconcile()
    expect(report).toMatchObject({ stopped: 1, failures: 0 })
    expect((await h.store.get(alice))?.lifecycle).toBe('stopped')
    expect(runtime.stopped).toContain(deriveNames(alice).account)
    await fresh.handler({ op: 'ensure', userId: alice })
    expect(runtime.started).toHaveLength(2)
    void svc
  })

  it('removes stale router sockets but nothing else', async () => {
    const h = await makeHarness()
    const stale = join(h.config.paths.socketDir, `${deriveNames(alice).account}.sock`)
    const kept = join(h.config.paths.socketDir, `${deriveNames(bob).account}.sock`)
    const other = join(h.config.paths.socketDir, 'notes.txt')
    const servers = [createServer(), createServer()]
    await Promise.all([new Promise<void>(resolve => servers[0]!.listen(stale, resolve)), new Promise<void>(resolve => servers[1]!.listen(kept, resolve))])
    await writeFile(other, 'keep')
    expect(await sweepSockets(h.config.paths.socketDir, new Set([kept]))).toBe(1)
    await expect(stat(stale)).rejects.toThrow()
    expect((await stat(kept)).isSocket()).toBe(true)
    expect((await stat(other)).isFile()).toBe(true)
    for (const server of servers) server.close()
  })

  it('stops idle instances while retaining the account and data, then wakes them', async () => {
    const { h, svc, call } = await service({ idleStopMs: 120_000 })
    await call('ensure')
    expect(await svc.lifecycle.idleStop()).toEqual([])
    h.clock.now += 60_000
    await call('ensure')
    h.clock.now += 119_000
    expect(await svc.lifecycle.idleStop()).toEqual([])
    h.clock.now += 2_000
    expect(await svc.lifecycle.idleStop()).toEqual([alice])
    expect((await h.store.get(alice))?.lifecycle).toBe('stopped')
    expect(h.directory.removed).toEqual([])
    const record = h.users.recordOf((await h.store.get(alice))!)
    expect((await stat(record.layout.workspace)).isDirectory()).toBe(true)
    await call('ensure')
    expect((await h.store.get(alice))?.lifecycle).toBe('running')
  })

  it('suspension revokes routing, keeps data private, and blocks the next ensure; reactivation restores it', async () => {
    const { h, runtime, svc, call } = await service()
    await call('ensure')
    await svc.lifecycle.suspend(alice)
    expect(runtime.stopped).toContain(deriveNames(alice).account)
    expect(await call('status')).toBe('suspended')
    await expect(call('ensure')).rejects.toBeInstanceOf(AccountSuspendedError)
    await expect(call('launch-grant')).rejects.toThrow()
    const record = h.users.recordOf((await h.store.get(alice))!)
    expect((await stat(record.layout.root)).mode & 0o777).toBe(0o700)
    await svc.lifecycle.reactivate(alice)
    expect(await call('status')).toBe('stopped')
    await call('ensure')
    expect(await call('status')).toBe('running')
  })

  it('refuses deletion before confirmation and before the recovery period, then purges', async () => {
    const { h, svc, call } = await service({ deletionRecoveryMs: 1000 })
    await call('ensure')
    const record = h.users.recordOf((await h.store.get(alice))!)
    await expect(svc.lifecycle.deleteUser(alice)).rejects.toMatchObject({ reason: 'not-requested' })
    await svc.lifecycle.requestDeletion(alice)
    await expect(call('ensure')).rejects.toBeInstanceOf(AccountSuspendedError)
    await expect(svc.lifecycle.deleteUser(alice)).rejects.toMatchObject({ reason: 'not-confirmed' })
    await svc.lifecycle.confirmDeletion(alice)
    await expect(svc.lifecycle.deleteUser(alice)).rejects.toBeInstanceOf(DeletionNotAllowedError)
    await expect(svc.lifecycle.deleteUser(alice)).rejects.toMatchObject({ reason: 'recovery-period' })
    expect((await stat(record.layout.workspace)).isDirectory()).toBe(true)
    h.clock.now += 1001
    await svc.lifecycle.deleteUser(alice)
    await expect(stat(record.layout.root)).rejects.toThrow()
    expect(await h.store.get(alice)).toBeUndefined()
    expect(h.directory.removed).toEqual([deriveNames(alice).account])
  })

  it('reconcile purges only confirmed, expired deletions and can reverse a pending one', async () => {
    const { h, svc, call } = await service({ deletionRecoveryMs: 1000 })
    await call('ensure'); await call('ensure', bob)
    await svc.lifecycle.requestDeletion(alice); await svc.lifecycle.confirmDeletion(alice)
    await svc.lifecycle.requestDeletion(bob)
    h.clock.now += 5000
    expect(await svc.lifecycle.reconcile()).toMatchObject({ purged: 1 })
    expect(await h.store.get(alice)).toBeUndefined()
    expect((await h.store.get(bob))?.lifecycle).toBe('pending-deletion')
    await svc.lifecycle.reactivate(bob)
    expect((await h.store.get(bob))?.lifecycle).toBe('stopped')
  })

  it('leaves damaged records untouched and reports them', async () => {
    const { h, svc } = await service()
    const name = `${deriveNames(bob).account}.json`
    await writeFile(join(h.config.paths.stateDir, name), '{"version":2}')
    const report = await svc.lifecycle.reconcile()
    expect(report.invalid).toEqual([name])
    await mkdir(h.config.paths.socketDir, { recursive: true })
  })
})

const within = <T,>(work: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung')), ms))])

describe.skipIf(process.platform === 'win32')('stop and external kill', () => {
  it('the stop operation completes (it used to wait on its own per-user lock), stops the container, and marks the user stopped', async () => {
    const { runtime, call } = await service()
    await call('ensure')
    await within(call('stop'))
    expect(runtime.stopped).toHaveLength(1)
    expect(await call('status')).toBe('stopped')
    await within(call('stop'))
    await call('ensure')
    expect(runtime.started).toHaveLength(2)
  })

  it('never reports running for a container that was killed out of band, and wakes it on the next request', async () => {
    const { h, runtime, call } = await service()
    await call('ensure')
    expect(await call('status')).toBe('running')
    runtime.alive = false
    // A successful check is trusted for the TTL (5 s) so routing does not run `podman inspect` per request.
    expect(await call('status')).toBe('running')
    h.clock.now += 6000
    expect(await call('status')).toBe('stopped')
    expect(runtime.stopped).toHaveLength(1)
    await expect(call('launch-grant')).rejects.toThrow(/not running/)
    runtime.alive = true
    await call('ensure')
    expect(runtime.started).toHaveLength(2)
    expect(await call('status')).toBe('running')
  })

  it('does not hand out a cached endpoint whose container died: the request restarts the instance', async () => {
    const { h, runtime, call } = await service()
    await call('ensure')
    runtime.alive = false
    h.clock.now += 6000
    await call('ensure')
    expect(runtime.stopped).toHaveLength(1)
    expect(runtime.started).toHaveLength(2)
  })

  it('reconcile releases a routable instance whose container is gone, but leaves unknown answers alone', async () => {
    const { runtime, call, svc } = await service()
    await call('ensure')
    runtime.state = async () => 'unknown'
    expect(await svc.lifecycle.reconcile()).toMatchObject({ restored: 1, stopped: 0 })
    runtime.state = async () => 'stopped'
    expect(await svc.lifecycle.reconcile()).toMatchObject({ restored: 0, stopped: 1, failures: 0 })
    expect(await call('status')).toBe('stopped')
    runtime.state = async () => 'running'
    await call('ensure')
    expect(runtime.started).toHaveLength(2)
  })

  it('returns to stopped, not starting, when the instance dies during start, and a later ensure can retry', async () => {
    const { runtime, call } = await service()
    const realStart = runtime.start.bind(runtime)
    runtime.start = async () => { throw new RuntimeStartError('container-exited') }
    await expect(call('ensure')).rejects.toMatchObject({ reason: 'container-exited' })
    expect(await call('status')).toBe('stopped')
    await expect(call('launch-grant')).rejects.toThrow(/not running/)
    runtime.start = realStart
    await call('ensure')
    expect(await call('status')).toBe('running')
  })

  it('treats an inspect that cannot answer as alive', async () => {
    const { h, runtime, call } = await service()
    await call('ensure')
    runtime.state = async () => { throw new Error('podman timed out') }
    h.clock.now += 6000
    expect(await call('status')).toBe('running')
    expect(runtime.stopped).toHaveLength(0)
  })
})
