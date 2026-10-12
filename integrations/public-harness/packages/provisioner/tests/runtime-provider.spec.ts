import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { localGit, type InstanceRuntime } from '@public-harness/contracts'
import { describe, expect, it } from 'vitest'
import { createUserProvisioner } from '../src/users.ts'
import { createProvisionerService } from '../src/service.ts'
import { apply, createContainerInstanceRuntime } from '../src/runtime-provider.ts'
import { alice, bob, makeHarness } from './helpers.ts'

async function partialAllocation() {
  const h = await makeHarness()
  const seenIds: string[] = []
  let failCleanup = false
  const runtime = createContainerInstanceRuntime({ config: h.config, store: h.store, runner: h.runner, publicHost: 'h.test',
    portFree: async () => true, gitFor: () => localGit,
    probe: { controllers: async () => ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] },
    quota: { healthy: async () => true, open: async (_userId, instanceId) => {
      seenIds.push(instanceId); throw new Error('quota allocation interrupted')
    }, issue: async () => ({ token: 'grant', expiresAt: 1 }), close: async () => { if (failCleanup) throw new Error('quota cleanup unavailable') } } })
  const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime,
    ownership: { chown: async () => {} } })
  const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime, users })
  return { h, runtime, users, service, seenIds, setFailure: (value: boolean) => { failCleanup = value } }
}

describe.skipIf(process.platform === 'win32')('durable partial runtime allocations', () => {
  it('retains the assigned port and quota launch ID after an interrupted allocation, then releases it through reconciliation', async () => {
    const { h, service, seenIds } = await partialAllocation()
    await expect(service.handler({ op: 'ensure', userId: alice })).rejects.toThrow('quota allocation interrupted')
    const interrupted = (await h.store.get(alice))!
    expect(interrupted).toMatchObject({ version: 2, lifecycle: 'quarantined', instance: null,
      acquired: ['account', 'storage', 'network'], pending: { webPort: 29200 } })
    expect(interrupted.pending!.instanceId).toBe(seenIds[0])
    expect(interrupted.pending!.quotaPort).toBeUndefined()
    await expect(service.handler({ op: 'ensure', userId: alice })).rejects.toThrow(/quarantined/)
    expect(seenIds).toHaveLength(1)
    expect(await service.lifecycle.reconcile()).toMatchObject({ stopped: 1, failures: 0 })
    expect(await h.store.get(alice)).toMatchObject({ lifecycle: 'stopped', instance: null, acquired: ['account', 'storage'] })
    expect((await h.store.get(alice))!.pending).toBeUndefined()
  })
  it('keeps failed cleanup quarantined and denies capacity reuse', async () => {
    const { h, service, setFailure } = await partialAllocation()
    await expect(service.handler({ op: 'ensure', userId: alice })).rejects.toThrow('quota allocation interrupted')
    setFailure(true)
    expect(await service.lifecycle.reconcile()).toMatchObject({ stopped: 0, failures: 1 })
    expect(await h.store.get(alice)).toMatchObject({ lifecycle: 'quarantined', pending: { webPort: 29200 } })
    expect(await service.handler({ op: 'status', userId: alice })).toBe('quarantined')
  })
})

describe('Cordis runtime provider ownership', () => {
  it('rejects a duplicate provider and releases the service on disposal', async () => {
    const h = await makeHarness()
    const ctx = new Context() as Context
    const options = { config: h.config, store: h.store, runner: h.runner, publicHost: 'h.test',
      quota: { healthy: async () => true, open: async () => ({ port: 29100 }), issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} },
      probe: { controllers: async () => [] } }
    apply(ctx, options)
    const first: InstanceRuntime = ctx.instanceRuntime
    expect(first.kind).toBe('podman-gvisor')
    expect(() => apply(ctx, options)).toThrow(/registered/)
    expect(ctx.instanceRuntime).toBe(first)
    await ctx.fiber.dispose()
    expect(ctx.instanceRuntime).toBeUndefined()
  })
})


describe.skipIf(process.platform === 'win32')('container adapter launch lifecycle', () => {
  it('records the actual quota launch ID and endpoints, then reopens them after suspension', async () => {
    const h = await makeHarness()
    const opened: string[] = [], issued: string[] = []
    let quotaOpen = false
    const runtime = createContainerInstanceRuntime({ config: h.config, store: h.store, runner: h.runner, publicHost: 'h.test',
      portFree: async () => true, healthProbe: async () => true, gitFor: () => localGit, chownFile: async () => {},
      startForwarder: async () => ({ close: async () => {} }),
      probe: { controllers: async () => ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] },
      quota: { healthy: async () => true, open: async (_userId, id) => { quotaOpen = true; opened.push(id); return { port: 29100 } },
        issue: async (_userId, id) => { if (!quotaOpen) throw new Error('quota grant is closed'); issued.push(id); return { token: 'grant', expiresAt: 1 } },
        close: async () => { quotaOpen = false } } })
    const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime,
      ownership: { chown: async () => {} } })
    const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime, users })
    h.runner.handler = async (_command, args) => {
      if (args.includes('run')) {
        const state = (await h.store.get(alice))!
        await writeFile(join(state.instance!.controlDir, 'ready.json'), JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: 'launch' }), { mode: 0o600 })
      }
      return undefined
    }
    try {
      await service.handler({ op: 'ensure', userId: alice })
      const started = (await h.store.get(alice))!
      expect(started).toMatchObject({ lifecycle: 'running', instance: { webPort: 29200, quotaPort: 29100 },
        acquired: ['account', 'storage', 'network', 'quota', 'policy', 'unit', 'forwarder'] })
      expect(opened).toEqual([started.instance!.instanceId]); expect(issued).toEqual(opened)
      await service.lifecycle.suspend(alice)
      expect((await h.store.get(alice))!.instance).toBeNull()
      await service.lifecycle.reactivate(alice)
      await service.handler({ op: 'ensure', userId: alice })
      expect(opened).toHaveLength(2)
      expect(opened[1]).not.toBe(opened[0])
      expect(issued).toEqual(opened)
    } finally { await runtime.close() }
  })
})


it.skipIf(process.platform === 'win32')('does not reuse an uncertain sidecar port after provider restart', async () => {
  const { h, service } = await partialAllocation()
  await expect(service.handler({ op: 'ensure', userId: alice })).rejects.toThrow('quota allocation interrupted')
  const runtime = createContainerInstanceRuntime({ config: h.config, store: h.store, runner: h.runner, publicHost: 'h.test',
    portFree: async () => true, gitFor: () => localGit,
    probe: { controllers: async () => ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] },
    quota: { healthy: async () => true, open: async () => ({ port: 29101 }), issue: async () => ({ token: 'a.b', expiresAt: 1 }), close: async () => {} } })
  const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime,
    ownership: { chown: async () => {} } })
  await users.ensureUser(bob)
  expect((await h.store.get(bob))!.instance!.webPort).toBe(29201)
  expect((await h.store.get(alice))!.pending!.webPort).toBe(29200)
})


it.skipIf(process.platform === 'win32')('owns a resumed complete launch before effects and stops it on provider disposal', async () => {
  const h = await makeHarness()
  await h.users.ensureUser(alice)
  const instance = h.users.instanceOf((await h.store.get(alice))!)
  const ctx = new Context() as Context
  let forwarderClosed = false, quotaClosed = false, resumedAllocation = false
  apply(ctx, { config: h.config, store: h.store, runner: h.runner, publicHost: 'h.test',
    healthProbe: async () => true, chownFile: async () => {},
    startForwarder: async () => ({ close: async () => { forwarderClosed = true } }),
    probe: { controllers: async () => [] },
    quota: { healthy: async () => true, open: async () => { resumedAllocation = true; return { port: 29100 } },
      issue: async () => ({ token: 'grant', expiresAt: 1 }), close: async () => { quotaClosed = true } } })
  const runtime = ctx.instanceRuntime
  const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime })
  const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime, users })
  h.runner.handler = async (_command, args) => {
    if (args.includes('run')) await writeFile(join(instance.controlDir, 'ready.json'),
      JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: 'launch' }), { mode: 0o600 })
    return undefined
  }
  try {
    await service.handler({ op: 'ensure', userId: alice })
    expect(resumedAllocation).toBe(false)
    const beforeDispose = h.runner.calls.length
    await ctx.fiber.dispose()
    expect(forwarderClosed).toBe(true)
    expect(quotaClosed).toBe(true)
    expect(h.runner.calls.slice(beforeDispose).some(call => call.args.includes('rm'))).toBe(true)
  } finally {
    await runtime.stop(instance)
    await ctx.fiber.dispose()
    await h.runtime.close()
  }
})


async function ownershipAcrossRestarts() {
  const h = await makeHarness()
  let forwarderCloses = 0, quotaCloses = 0
  let pausedRead: { entered(): void; released: Promise<void> } | undefined
  const store = { ...h.store, get: async (userId: Parameters<typeof h.store.get>[0]) => {
    const snapshot = await h.store.get(userId)
    const pause = pausedRead
    if (pause !== undefined) { pausedRead = undefined; pause.entered(); await pause.released }
    return snapshot
  } }
  const runtime = createContainerInstanceRuntime({ config: h.config, store, runner: h.runner, publicHost: 'h.test',
    portFree: async () => true, healthProbe: async () => true, gitFor: () => localGit, chownFile: async () => {},
    startForwarder: async () => ({ close: async () => { forwarderCloses += 1 } }),
    probe: { controllers: async () => ['cpu', 'cpuset', 'hugetlb', 'io', 'memory', 'pids'] },
    quota: { healthy: async () => true, open: async () => ({ port: 29100 }),
      issue: async () => ({ token: 'grant', expiresAt: 1 }), close: async () => { quotaCloses += 1 } } })
  const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime,
    ownership: { chown: async () => {} } })
  const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime, users })
  h.runner.handler = async (_command, args) => {
    if (args.includes('run')) {
      const instance = users.instanceOf((await h.store.get(alice))!)
      await writeFile(join(instance.controlDir, 'ready.json'),
        JSON.stringify({ kind: 'public-harness/web-ready', port: 8080, token: instance.instanceId }), { mode: 0o600 })
    }
    return undefined
  }
  return { h, users, service, runtime, closes: () => ({ forwarder: forwarderCloses, quota: quotaCloses }),
    pauseRead: () => {
      let entered!: () => void, release!: () => void
      const reached = new Promise<void>(resolve => { entered = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      pausedRead = { entered, released }
      return { reached, release }
    } }
}

it.skipIf(process.platform === 'win32').each(['state', 'launchGrant'] as const)(
  'keeps current shutdown ownership after a delayed stale %s observation', async method => {
    const { h, users, service, runtime, closes } = await ownershipAcrossRestarts()
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let observation: Promise<unknown> | undefined
    try {
      await service.handler({ op: 'ensure', userId: alice })
      const old = users.instanceOf((await h.store.get(alice))!)
      observation = released.then(() => runtime[method](old))
      await service.handler({ op: 'stop', userId: alice })
      await service.handler({ op: 'ensure', userId: alice })
      const current = users.instanceOf((await h.store.get(alice))!)
      expect(current.instanceId).not.toBe(old.instanceId)
      release()
      await observation
      const before = closes()
      await expect(runtime.close()).resolves.toBeUndefined()
      expect(closes()).toEqual({ forwarder: before.forwarder + 1, quota: before.quota + 1 })
    } finally {
      release()
      if (observation !== undefined) await Promise.allSettled([observation])
      const current = (await h.store.get(alice))?.instance
      if (current !== undefined && current !== null) await runtime.stop(current)
      await runtime.close()
    }
  })

it.skipIf(process.platform === 'win32')('rejects delayed stale cleanup without discarding the current launch owner', async () => {
  const { h, users, service, runtime, closes, pauseRead } = await ownershipAcrossRestarts()
  let pause: ReturnType<typeof pauseRead> | undefined
  let cleanup: Promise<unknown> | undefined
  try {
    await service.handler({ op: 'ensure', userId: alice })
    const old = users.instanceOf((await h.store.get(alice))!)
    pause = pauseRead()
    cleanup = runtime.stop(old).then(() => undefined, error => error)
    await pause.reached
    await service.handler({ op: 'stop', userId: alice })
    await service.handler({ op: 'ensure', userId: alice })
    expect(users.instanceOf((await h.store.get(alice))!).instanceId).not.toBe(old.instanceId)
    const before = closes()
    pause.release()
    expect(await cleanup).toBeInstanceOf(Error)
    expect(closes()).toEqual(before)
    await expect(runtime.close()).resolves.toBeUndefined()
    expect(closes()).toEqual({ forwarder: before.forwarder + 1, quota: before.quota + 1 })
  } finally {
    pause?.release()
    if (cleanup !== undefined) await Promise.allSettled([cleanup])
    const current = (await h.store.get(alice))?.instance
    if (current !== undefined && current !== null) await runtime.stop(current)
    await runtime.close()
  }
})
