/** 1D.3: apply one sync plan entry — preconditions + disabled install flow. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySyncEntry, type ApplyDeps, type PluginManagerLike, type SyncPlanEntry } from '../src/apply.ts'
import { appendOp, readOps, type SyncOp } from '../src/oplog.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(): { home: string; profileDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-apply-'))
  roots.push(home)
  const profileDir = join(home, 'profile')
  mkdirSync(profileDir, { recursive: true })
  return { home, profileDir }
}

function writePackageJson(profileDir: string, deps: Record<string, string>): void {
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh', dependencies: deps }, null, 2)}\n`,
  )
}

/** Minimal lockfile snippet whose integrity matches a hex sha512 plan field. */
function writeLockfile(profileDir: string, name: string, version: string, integrity: string): void {
  const key = name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`
  writeFileSync(
    join(profileDir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\npackages:\n  ${key}:\n    resolution: {integrity: ${integrity}}\n`,
  )
}

function hexToIntegrity(hex: string): string {
  return `sha512-${Buffer.from(hex, 'hex').toString('base64')}`
}

const SHA_OK = 'ab'.repeat(64)
const SHA_BAD = 'cd'.repeat(64)
const INTEGRITY_OK = hexToIntegrity(SHA_OK)

function mockManager(overrides: Partial<PluginManagerLike> = {}): PluginManagerLike {
  return {
    installBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
    setBundleEnabled: vi.fn(async () => ({ application: 'applied', changed: true })),
    removeBundle: vi.fn(async () => ({ application: 'applied', changed: true })),
    ...overrides,
  }
}

async function withLockPassthrough<T>(_file: string, op: () => Promise<T>): Promise<T> {
  return op()
}

function deps(partial: {
  home: string
  profileDir: string
  manager?: PluginManagerLike
  registry?: string
}): ApplyDeps {
  return {
    home: partial.home,
    profileDir: partial.profileDir,
    manager: partial.manager ?? mockManager(),
    registry: partial.registry ?? 'http://127.0.0.1:31000/npm/',
    withFileLock: withLockPassthrough,
  }
}

function installEntry(over: Partial<SyncPlanEntry> = {}): SyncPlanEntry {
  return {
    name: '@corp-dsh/demo',
    version: '1.2.0',
    fromVersion: null,
    sha512: SHA_OK,
    action: 'install',
    allowedBuilds: ['native'],
    ...over,
  }
}

describe('applySyncEntry preconditions', () => {
  it('skips_install_when_already_present', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const manager = mockManager()
    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'already-present' })
    expect(manager.installBundle).not.toHaveBeenCalled()
  })

  it('skips_install_when_user_removed_since_last_reset', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'user-removed', name: '@corp-dsh/demo', at: 2 })
    const manager = mockManager()
    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'user-removed' })
    expect(manager.installBundle).not.toHaveBeenCalled()
  })

  it('allows_install_after_reset_clears_user_removed', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeLockfile(profileDir, '@corp-dsh/demo', '1.2.0', INTEGRITY_OK)
    await appendOp(home, { type: 'user-removed', name: '@corp-dsh/demo', at: 1 })
    await appendOp(home, { type: 'reset', name: '@corp-dsh/demo', at: 2 })
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
        writeLockfile(profileDir, '@corp-dsh/demo', '1.2.0', INTEGRITY_OK)
        return { application: 'applied', changed: true }
      }),
    })
    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result.outcome).toBe('done')
    expect(manager.installBundle).toHaveBeenCalled()
  })

  it('skips_update_when_fromVersion_mismatch', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const manager = mockManager()
    const result = await applySyncEntry(
      installEntry({ action: 'update', fromVersion: '1.1.0', version: '2.0.0' }),
      deps({ home, profileDir, manager }),
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'from-version-mismatch' })
    expect(manager.removeBundle).not.toHaveBeenCalled()
  })

  it('skips_update_when_package_absent', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    const manager = mockManager()
    const result = await applySyncEntry(
      installEntry({ action: 'downgrade', fromVersion: '2.0.0', version: '1.0.0' }),
      deps({ home, profileDir, manager }),
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'from-version-mismatch' })
  })
})

describe('applySyncEntry disabled install then enable', () => {
  it('installs_with_enabled_false_then_enables_after_checks', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
        writeLockfile(profileDir, '@corp-dsh/demo', '1.2.0', INTEGRITY_OK)
        return { application: 'applied', changed: true }
      }),
    })
    const order: string[] = []
    manager.installBundle = vi.fn(async (...args) => {
      order.push('install')
      writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
      writeLockfile(profileDir, '@corp-dsh/demo', '1.2.0', INTEGRITY_OK)
      return { application: 'applied', changed: true }
    })
    manager.setBundleEnabled = vi.fn(async () => {
      order.push('enable')
      return { application: 'applied', changed: true }
    })

    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result.outcome).toBe('done')
    expect(manager.installBundle).toHaveBeenCalledWith('@corp-dsh/demo@1.2.0', {
      registry: 'http://127.0.0.1:31000/npm/',
      enabled: false,
      approvedBuilds: ['native'],
    })
    expect(manager.setBundleEnabled).toHaveBeenCalledWith('@corp-dsh/demo', true)
    expect(order).toEqual(['install', 'enable'])
    const ops = await readOps(home)
    expect(ops.some((o: SyncOp) => o.type === 'intent' && o.name === '@corp-dsh/demo')).toBe(true)
    expect(ops.some((o: SyncOp) => o.type === 'done' && o.name === '@corp-dsh/demo')).toBe(true)
  })

  it('update_removes_then_installs_disabled_then_enables', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const manager = mockManager()
    const order: string[] = []
    manager.removeBundle = vi.fn(async () => {
      order.push('remove')
      writePackageJson(profileDir, {})
      return { application: 'applied', changed: true }
    })
    manager.installBundle = vi.fn(async () => {
      order.push('install')
      writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0' })
      writeLockfile(profileDir, '@corp-dsh/demo', '2.0.0', INTEGRITY_OK)
      return { application: 'applied', changed: true }
    })
    manager.setBundleEnabled = vi.fn(async () => {
      order.push('enable')
      return { application: 'applied', changed: true }
    })

    const result = await applySyncEntry(
      installEntry({ action: 'update', fromVersion: '1.0.0', version: '2.0.0' }),
      deps({ home, profileDir, manager }),
    )
    expect(result.outcome).toBe('done')
    expect(order).toEqual(['remove', 'install', 'enable'])
    expect(manager.installBundle).toHaveBeenCalledWith(
      '@corp-dsh/demo@2.0.0',
      expect.objectContaining({ enabled: false }),
    )
  })
})

describe('applySyncEntry integrity mismatch never enables', () => {
  it('removes_never_enabled_bundle_and_does_not_call_setBundleEnabled', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
        writeLockfile(profileDir, '@corp-dsh/demo', '1.2.0', hexToIntegrity(SHA_BAD))
        return { application: 'applied', changed: true }
      }),
    })
    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'failed', reason: 'integrity-mismatch' })
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(manager.removeBundle).toHaveBeenCalledWith('@corp-dsh/demo')
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'failed' && o.name === '@corp-dsh/demo')).toBe(true)
  })

  it('on_update_integrity_fail_reinstalls_fromVersion', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const manager = mockManager()
    const installs: string[] = []
    manager.removeBundle = vi.fn(async () => {
      writePackageJson(profileDir, {})
      return { application: 'applied', changed: true }
    })
    manager.installBundle = vi.fn(async (spec: string) => {
      installs.push(spec)
      if (spec.endsWith('@2.0.0')) {
        writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0' })
        writeLockfile(profileDir, '@corp-dsh/demo', '2.0.0', hexToIntegrity(SHA_BAD))
      } else {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
        writeLockfile(profileDir, '@corp-dsh/demo', '1.0.0', INTEGRITY_OK)
      }
      return { application: 'applied', changed: true }
    })

    const result = await applySyncEntry(
      installEntry({ action: 'update', fromVersion: '1.0.0', version: '2.0.0', sha512: SHA_OK }),
      deps({ home, profileDir, manager }),
    )
    expect(result).toMatchObject({ outcome: 'failed', reason: 'integrity-mismatch' })
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(installs).toEqual(['@corp-dsh/demo@2.0.0', '@corp-dsh/demo@1.0.0'])
    // reinstall fromVersion also disabled
    expect(manager.installBundle).toHaveBeenLastCalledWith(
      '@corp-dsh/demo@1.0.0',
      expect.objectContaining({ enabled: false }),
    )
  })
})

describe('applySyncEntry abandon on manager refusals', () => {
  it('abandons_on_already_installed', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    const manager = mockManager({
      installBundle: vi.fn(async () => ({
        application: 'failed',
        changed: false,
        error: { code: 'already-installed' },
      })),
    })
    const result = await applySyncEntry(installEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'abandoned', reason: 'already-installed' })
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('abandons_update_on_not_removable', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const manager = mockManager({
      removeBundle: vi.fn(async () => ({
        application: 'failed',
        changed: false,
        error: { code: 'not-removable' },
      })),
    })
    const result = await applySyncEntry(
      installEntry({ action: 'update', fromVersion: '1.0.0', version: '2.0.0' }),
      deps({ home, profileDir, manager }),
    )
    expect(result).toMatchObject({ outcome: 'abandoned', reason: 'not-removable' })
    expect(manager.installBundle).not.toHaveBeenCalled()
  })
})

describe('applySyncEntry lock usage', () => {
  it('runs_precondition_under_injected_withFileLock', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    const locked: string[] = []
    const result = await applySyncEntry(
      installEntry(),
      {
        ...deps({ home, profileDir }),
        withFileLock: async (file, op) => {
          locked.push(file)
          return op()
        },
      },
    )
    expect(result.outcome).toBe('skipped')
    expect(locked[0]).toBe(join(profileDir, 'package.json'))
  })
})

describe('pollSyncPlan stub', () => {
  it('is_exported_and_calls_injected_fetch', async () => {
    const { pollSyncPlan } = await import('../src/apply.ts')
    const fetchImpl = vi.fn(async () => ({
      entries: [installEntry()],
    }))
    const plan = await pollSyncPlan('http://127.0.0.1:31000/sync', { fetchPlan: fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:31000/sync')
    expect(plan.entries).toHaveLength(1)
  })
})
