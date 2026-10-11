import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, isolatedGitEnvironment } from '@public-harness/contracts'
import { deriveNames, isDerivedAccountName } from '../src/accounts.ts'
import { StorageOwnershipError, layoutFor } from '../src/storage.ts'
import { createProvisionerService } from '../src/service.ts'
import { createUserProvisioner } from '../src/users.ts'
import { alice, bob, makeHarness } from './helpers.ts'

describe.skipIf(process.platform === 'win32')('idempotent Linux user provisioning', () => {
  it('derives account and unit names only from the opaque ID', () => {
    const names = deriveNames(alice)
    expect(isDerivedAccountName(names.account)).toBe(true)
    expect(names.account).not.toContain('alice')
    expect(deriveNames(bob).account).not.toBe(names.account)
    expect(() => layoutFor({ storageRoot: '/srv', socketDir: '/run/s' }, '../etc')).toThrow(/derived/)
  })

  it('creates exactly one account for concurrent first requests', async () => {
    const h = await makeHarness()
    const records = await Promise.all(Array.from({ length: 6 }, () => h.users.ensureUser(alice)))
    expect(h.directory.created).toEqual([deriveNames(alice).account])
    expect(new Set(records.map(record => record.account)).size).toBe(1)
    const record = records[0]!
    expect(record.lifecycle).toBe('stopped')
    for (const dir of [record.layout.root, record.layout.home, record.layout.workspace, record.layout.ctl, record.layout.podman]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
    const env = isolatedGitEnvironment()
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: record.layout.workspace, env }).toString().trim()).toBe('1')
    expect(JSON.stringify(await h.store.get(alice))).not.toMatch(/token|password|secret/i)
  })

  it('resumes after an interrupted setup without a second account or a routable half-created user', async () => {
    const h = await makeHarness()
    h.failStorageOnce.value = true
    await expect(h.users.ensureUser(alice)).rejects.toThrow('simulated power loss')
    const partial = await h.store.get(alice)
    expect(partial).toMatchObject({ lifecycle: 'provisioning', lastError: 'storage-failed', steps: { account: true, storage: false } })
    await expect(h.users.beginStart(alice)).rejects.toThrow(/not fully provisioned/)
    const record = await h.users.ensureUser(alice)
    expect(h.directory.created).toHaveLength(1)
    expect(record.lifecycle).toBe('stopped')
    expect(await h.store.get(alice)).toMatchObject({ steps: { account: true, storage: true, workspace: true } })
    expect((await h.store.get(alice))?.lastError).toBeUndefined()
  })

  it('prepares protections before workspace initialization when resuming a complete allocation', async () => {
    const h = await makeHarness()
    await h.users.ensureUser(alice)
    const interrupted = (await h.store.get(alice))!
    interrupted.lifecycle = 'provisioning'; interrupted.steps.workspace = false
    interrupted.acquired = interrupted.acquired.filter(resource => resource !== 'policy')
    await h.store.put(interrupted)
    const effects: string[] = []
    const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner,
      runtime: { ...h.runtime, prepare: async () => { effects.push('prepare') }, initializeWorkspace: async () => { effects.push('git') } } })
    await users.ensureUser(alice)
    expect(effects).toEqual(['prepare', 'git'])
    expect((await h.store.get(alice))!.acquired).toContain('policy')
  })

  it('refuses a pre-existing directory with the wrong owner and stays unpublished', async () => {
    const h = await makeHarness()
    const layout = layoutFor(h.config.paths, deriveNames(alice).account)
    await mkdir(layout.root, { recursive: true, mode: 0o700 })
    h.directory.ownerOffset = 1
    await expect(h.users.ensureUser(alice)).rejects.toBeInstanceOf(StorageOwnershipError)
    expect((await h.store.get(alice))?.lifecycle).toBe('provisioning')
  })

  it('refuses a symlinked account directory', async () => {
    const h = await makeHarness()
    const layout = layoutFor(h.config.paths, deriveNames(alice).account)
    await mkdir(`${h.config.paths.storageRoot}/users`, { recursive: true })
    const { symlink } = await import('node:fs/promises')
    await symlink('/tmp', layout.root)
    await expect(h.users.ensureUser(alice)).rejects.toBeInstanceOf(StorageOwnershipError)
  })

  it('refuses suspended and pending-deletion users without touching the host', async () => {
    const h = await makeHarness()
    await h.users.ensureUser(alice)
    const state = (await h.store.get(alice))!
    for (const lifecycle of ['suspended', 'pending-deletion'] as const) {
      await h.store.put({ ...state, lifecycle })
      await expect(h.users.ensureUser(alice)).rejects.toBeInstanceOf(AccountSuspendedError)
    }
    expect(h.directory.created).toHaveLength(1)
  })

  it('refuses capacity without creating an account, a directory, or a record', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    await h.users.ensureUser(alice)
    await h.users.beginStart(alice)
    await expect(h.users.ensureUser(bob)).rejects.toBeInstanceOf(CapacityError)
    expect(h.directory.created).toEqual([deriveNames(alice).account])
    expect(await h.store.get(bob)).toBeUndefined()
    await expect(stat(layoutFor(h.config.paths, deriveNames(bob).account).root)).rejects.toThrow()
    await h.users.markStopped(alice)
    await h.users.ensureUser(bob)
    await h.users.beginStart(bob)
    await expect(h.users.beginStart(alice)).rejects.toBeInstanceOf(CapacityError)
  })

  it('refuses a returning user at capacity before acquiring any launch resources', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    await h.users.ensureUser(alice)
    await h.runtime.stop(h.users.instanceOf((await h.store.get(alice))!))
    await h.users.markStopped(alice)
    await h.users.ensureUser(bob)
    await h.users.beginStart(bob)
    const before = (await h.store.get(alice))!
    const calls = h.runner.calls.length
    const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory,
      runner: h.runner, runtime: h.runtime, users: h.users })
    try {
      await expect(service.handler({ op: 'ensure', userId: alice })).rejects.toBeInstanceOf(CapacityError)
      expect(h.runner.calls).toHaveLength(calls)
      expect(await h.store.get(alice)).toEqual(before)
      expect(await h.users.activeCount()).toBe(1)
    } finally { await h.runtime.close() }
  })

  it('keeps capacity durable while allocation is pending', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    let users = h.users
    const runtime = { ...h.runtime, allocate: async (request: Parameters<typeof h.runtime.allocate>[0]) => {
      expect((await h.store.get(alice))!.pending!.instanceId).toBe(request.instanceId)
      expect(await users.activeCount()).toBe(1)
      await expect(users.ensureUser(bob)).rejects.toBeInstanceOf(CapacityError)
      expect(h.directory.created).toEqual([deriveNames(alice).account])
      throw new Error('interrupted allocation')
    } }
    users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime,
      ownership: { chown: async () => {} } })
    await expect(users.ensureUser(alice)).rejects.toThrow('interrupted allocation')
    expect((await h.store.get(alice))!.lifecycle).toBe('quarantined')
    expect(await users.activeCount()).toBe(1)
  })

  it('reconciles an allocated stopped user before releasing its durable capacity', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    await h.users.ensureUser(alice)
    const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory,
      runner: h.runner, runtime: h.runtime, users: h.users })
    try {
      expect((await h.store.get(alice))!.lifecycle).toBe('stopped')
      expect(await h.users.activeCount()).toBe(1)
      expect(await service.lifecycle.reconcile()).toMatchObject({ stopped: 1, failures: 0 })
      expect(await h.store.get(alice)).toMatchObject({ lifecycle: 'stopped', instance: null, acquired: ['account', 'storage'] })
      expect(await h.users.activeCount()).toBe(0)
    } finally { await h.runtime.close() }
  })

  it('waits for suspension before admitting the same user', async () => {
    const h = await makeHarness()
    await h.users.ensureUser(alice)
    await h.users.ensureUser(bob)
    let enteredStop!: () => void, releaseStop!: () => void
    const entered = new Promise<void>(resolve => { enteredStop = resolve })
    const released = new Promise<void>(resolve => { releaseStop = resolve })
    const runtime = { ...h.runtime, stop: async (instance: Parameters<typeof h.runtime.stop>[0]) => {
      if (instance.userId === alice) { enteredStop(); await released }
      await h.runtime.stop(instance)
    } }
    const users = createUserProvisioner({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime })
    const service = createProvisionerService({ config: h.config, store: h.store, directory: h.directory, runner: h.runner, runtime, users })
    const suspension = service.lifecycle.suspend(alice)
    let admission: Promise<{ error?: unknown }> | undefined
    try {
      await entered
      admission = users.beginStart(alice).then(() => ({}), error => ({ error }))
      // Bob drains the capacity lock while Alice's suspension owns only Alice's lock.
      await users.beginStart(bob)
      releaseStop()
      await suspension
      expect((await admission).error).toBeInstanceOf(AccountSuspendedError)
      expect(await h.store.get(alice)).toMatchObject({ lifecycle: 'suspended', instance: null })
    } finally {
      releaseStop()
      await Promise.allSettled([suspension, ...(admission === undefined ? [] : [admission])])
      await h.runtime.close()
    }
  })

  it('reserves capacity for only one simultaneous first allocation', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    try {
      const results = await Promise.allSettled([h.users.ensureUser(alice), h.users.ensureUser(bob)])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
      expect(refused.reason).toBeInstanceOf(CapacityError)
      expect(h.directory.created).toHaveLength(1)
      expect(await h.users.activeCount()).toBe(1)
    } finally { await h.runtime.close() }
  })

  it('lists only valid records and reports damaged ones without deleting them', async () => {
    const h = await makeHarness()
    await h.users.ensureUser(alice)
    const name = `${deriveNames(bob).account}.json`
    await writeFile(`${h.config.paths.stateDir}/${name}`, '{"version":1}')
    const listed = await h.store.list()
    expect(listed.records.map(record => record.userId)).toEqual(['alice'])
    expect(listed.invalid).toEqual([name])
  })

  it('stopUser keeps the account and data', async () => {
    const h = await makeHarness()
    const record = await h.users.ensureUser(alice)
    await h.users.beginStart(alice)
    await h.users.markRunning(alice)
    await h.users.stopUser(alice)
    expect((await h.store.get(alice))?.lifecycle).toBe('stopped')
    expect((await stat(record.layout.workspace)).isDirectory()).toBe(true)
    expect(h.directory.removed).toEqual([])
  })
})


describe.skipIf(process.platform === 'win32')('runtime record migration', () => {
  it('legacy_records_keep_container_backend', async () => {
    const { migrateUserState } = await import('../src/state.ts')
    const legacy = { version: 1, userId: alice, account: deriveNames(alice).account, lifecycle: 'stopped',
      steps: { account: true, storage: true, workspace: true }, uid: process.getuid!(), gid: process.getgid!(),
      createdAt: 1, updatedAt: 2 }
    expect(migrateUserState(legacy)).toMatchObject({ version: 2, runtime: { kind: 'podman-gvisor', container: legacy.account }, instance: null,
      acquired: ['account', 'storage'] })
    expect(legacy.version).toBe(1)
  })

  it('reads a valid legacy file unchanged and writes version 2 on its next mutation', async () => {
    const h = await makeHarness()
    const legacy = { version: 1, userId: alice, account: deriveNames(alice).account, lifecycle: 'stopped',
      steps: { account: true, storage: true, workspace: true }, uid: process.getuid!(), gid: process.getgid!(), createdAt: 1, updatedAt: 2 }
    const file = `${h.config.paths.stateDir}/${legacy.account}.json`
    const original = JSON.stringify(legacy) + '\n'
    await writeFile(file, original)
    const migrated = (await h.store.get(alice))!
    expect(migrated.runtime.kind).toBe('podman-gvisor')
    expect(await readFile(file, 'utf8')).toBe(original)
    await h.store.put(migrated)
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  })

  it.each([{ version: 99 }, { version: 2, runtime: { kind: 'unknown' } }, { version: 1, userId: alice }])('refuses damaged or unknown records without rewriting them', async value => {
    const h = await makeHarness()
    const file = `${h.config.paths.stateDir}/${deriveNames(alice).account}.json`
    const text = JSON.stringify(value) + '\n'
    await writeFile(file, text)
    await expect(h.store.get(alice)).rejects.toThrow()
    expect((await h.store.list()).invalid).toEqual([`${deriveNames(alice).account}.json`])
    expect(await readFile(file, 'utf8')).toBe(text)
  })
})
