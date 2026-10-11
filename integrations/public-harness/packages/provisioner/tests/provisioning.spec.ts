import { execFileSync } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, isolatedGitEnvironment } from '@public-harness/contracts'
import { deriveNames, isDerivedAccountName } from '../src/accounts.ts'
import { StorageOwnershipError, layoutFor } from '../src/storage.ts'
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

  it('never lets two simultaneous starts exceed the cap', async () => {
    const h = await makeHarness({ maxActiveInstances: 1 })
    await Promise.all([h.users.ensureUser(alice), h.users.ensureUser(bob)])
    const results = await Promise.allSettled([h.users.beginStart(alice), h.users.beginStart(bob)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await h.users.activeCount()).toBe(1)
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
