/** 1D.5: profile snapshots, tenant-file reads, apply recovery, restore queue stubs. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySyncEntry, type ApplyDeps, type PluginManagerLike, type SyncPlanEntry } from '../src/apply.ts'
import { readOps, snapshotsDir } from '../src/oplog.ts'
import {
  MAX_SNAPSHOTS,
  MAX_TENANT_FILE_BYTES,
  hashBytesSha256,
  listQueuedRestores,
  listSnapshotIds,
  queueRestore,
  readTenantFile,
  restoreSnapshotFiles,
  snapshotHashes,
  writeProfileSnapshot,
} from '../src/snapshots.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(): { home: string; profileDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-snap-'))
  roots.push(home)
  const profileDir = join(home, 'profile')
  mkdirSync(profileDir, { recursive: true })
  return { home, profileDir }
}

function writePackageJson(profileDir: string, deps: Record<string, string>, extra = ''): void {
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh', dependencies: deps }, null, 2)}${extra}\n`,
  )
}

function writeLockfile(profileDir: string, body: string): void {
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), body)
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
  withFileLock?: ApplyDeps['withFileLock']
}): ApplyDeps {
  return {
    home: partial.home,
    profileDir: partial.profileDir,
    manager: partial.manager ?? mockManager(),
    registry: 'http://127.0.0.1:31000/npm/',
    withFileLock: partial.withFileLock ?? withLockPassthrough,
  }
}

function updateEntry(over: Partial<SyncPlanEntry> = {}): SyncPlanEntry {
  return {
    name: '@corp-dsh/demo',
    version: '2.0.0',
    fromVersion: '1.0.0',
    sha512: SHA_OK,
    action: 'update',
    allowedBuilds: ['native'],
    ...over,
  }
}

describe('readTenantFile', () => {
  it('reads_regular_file_with_content', async () => {
    const { profileDir } = fixture()
    writePackageJson(profileDir, { a: '1.0.0' })
    const bytes = await readTenantFile(join(profileDir, 'package.json'))
    expect(bytes.toString('utf8')).toContain('"a": "1.0.0"')
  })

  it('refuses_symlink', async () => {
    const { home, profileDir } = fixture()
    const target = join(home, 'evil.json')
    writeFileSync(target, '{"evil":true}\n')
    symlinkSync(target, join(profileDir, 'package.json'))
    await expect(readTenantFile(join(profileDir, 'package.json'))).rejects.toMatchObject({
      code: 'ELOOP',
    })
  })

  it('refuses_oversized_file', async () => {
    const { profileDir } = fixture()
    const path = join(profileDir, 'package.json')
    writeFileSync(path, Buffer.alloc(MAX_TENANT_FILE_BYTES + 1, 0x61))
    await expect(readTenantFile(path)).rejects.toMatchObject({ code: 'EFBIG' })
  })

  it('refuses_directory', async () => {
    const { profileDir } = fixture()
    const path = join(profileDir, 'package.json')
    mkdirSync(path)
    await expect(readTenantFile(path)).rejects.toThrow()
  })
})

describe('writeProfileSnapshot rotate', () => {
  it('copies_package_json_and_lockfile_under_op_dir', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    await writeProfileSnapshot(home, profileDir, 'op-aaa')
    const snap = join(snapshotsDir(home), 'op-aaa')
    expect(readFileSync(join(snap, 'package.json'), 'utf8')).toContain('"@corp-dsh/demo"')
    expect(readFileSync(join(snap, 'pnpm-lock.yaml'), 'utf8')).toContain('lockfileVersion')
  })

  it('keeps_only_last_five_snapshots', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    for (let i = 0; i < 7; i++) {
      writePackageJson(profileDir, { n: String(i) })
      await writeProfileSnapshot(home, profileDir, `op-${String(i).padStart(2, '0')}`)
      // Ensure distinct meta.json `at` values for rotation ordering.
      await new Promise((r) => setTimeout(r, 5))
    }
    const ids = await listSnapshotIds(home)
    expect(ids).toHaveLength(MAX_SNAPSHOTS)
    expect(ids).not.toContain('op-00')
    expect(ids).not.toContain('op-01')
    expect(ids).toEqual(expect.arrayContaining(['op-02', 'op-03', 'op-04', 'op-05', 'op-06']))
  })

  it('refuses_symlink_planted_as_package_json', async () => {
    const { home, profileDir } = fixture()
    const target = join(home, 'evil.json')
    writeFileSync(target, '{"evil":true}\n')
    symlinkSync(target, join(profileDir, 'package.json'))
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    await expect(writeProfileSnapshot(home, profileDir, 'op-bad')).rejects.toMatchObject({
      code: 'ELOOP',
    })
    expect(existsSync(join(snapshotsDir(home), 'op-bad'))).toBe(false)
  })

  it('refuses_oversized_lockfile', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), Buffer.alloc(MAX_TENANT_FILE_BYTES + 1, 0x20))
    await expect(writeProfileSnapshot(home, profileDir, 'op-big')).rejects.toMatchObject({
      code: 'EFBIG',
    })
  })
})

describe('restoreSnapshotFiles + hashes', () => {
  it('restores_both_files_from_snapshot', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\npackages: {}\n")
    await writeProfileSnapshot(home, profileDir, 'op-restore')
    writePackageJson(profileDir, { '@corp-dsh/demo': '9.9.9' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\nbroken: true\n")
    await restoreSnapshotFiles(home, profileDir, 'op-restore')
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toContain('"1.0.0"')
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toContain('packages: {}')
  })

  it('hash_helpers_match_sha256_of_snapshotted_bytes', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { x: '1' })
    writeLockfile(profileDir, 'lock: 1\n')
    await writeProfileSnapshot(home, profileDir, 'op-hash')
    const hashes = await snapshotHashes(home, 'op-hash')
    const pkg = readFileSync(join(snapshotsDir(home), 'op-hash', 'package.json'))
    const lock = readFileSync(join(snapshotsDir(home), 'op-hash', 'pnpm-lock.yaml'))
    expect(hashes.manifestSha256).toBe(hashBytesSha256(pkg))
    expect(hashes.lockSha256).toBe(hashBytesSha256(lock))
  })
})

describe('queued restore stubs', () => {
  it('queues_user_and_admin_restores_without_executing', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    await writeProfileSnapshot(home, profileDir, 'snap-1')
    await queueRestore(home, { snapshotId: 'snap-1', reason: 'user', at: 100 })
    await queueRestore(home, { snapshotId: 'snap-1', reason: 'admin', at: 200 })
    const queued = await listQueuedRestores(home)
    expect(queued).toEqual([
      { snapshotId: 'snap-1', reason: 'user', at: 100 },
      { snapshotId: 'snap-1', reason: 'admin', at: 200 },
    ])
    // Stub only — profile files unchanged until 1D.6 reconcile start.
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toContain('"1.0.0"')
  })
})

describe('apply recovery: remove ok + install fail', () => {
  it('reinstalls_fromVersion_when_install_fails_after_remove', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(profileDir, `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@1.0.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`)
    const installs: string[] = []
    const manager = mockManager({
      removeBundle: vi.fn(async () => {
        writePackageJson(profileDir, {})
        return { application: 'applied', changed: true }
      }),
      installBundle: vi.fn(async (spec: string) => {
        installs.push(spec)
        if (spec.endsWith('@2.0.0')) {
          return { application: 'failed', changed: false, error: { code: 'network-error' } }
        }
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
        writeLockfile(
          profileDir,
          `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@1.0.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`,
        )
        return { application: 'applied', changed: true }
      }),
    })
    const result = await applySyncEntry(updateEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'failed', reason: 'network-error' })
    expect(installs).toEqual(['@corp-dsh/demo@2.0.0', '@corp-dsh/demo@1.0.0'])
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toContain('"1.0.0"')
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'failed' && o.reason === 'network-error')).toBe(true)
    expect(ops.some((o) => o.type === 'intent')).toBe(true)
  })

  it('restores_snapshot_files_when_fromVersion_reinstall_also_fails', async () => {
    const { home, profileDir } = fixture()
    const originalPkg = JSON.stringify({ name: 'dsh', dependencies: { '@corp-dsh/demo': '1.0.0' } }, null, 2) + '\n'
    const originalLock = "lockfileVersion: '9.0'\nsnapshot-marker: true\n"
    writeFileSync(join(profileDir, 'package.json'), originalPkg)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), originalLock)
    const manager = mockManager({
      removeBundle: vi.fn(async () => {
        writePackageJson(profileDir, {})
        writeLockfile(profileDir, "lockfileVersion: '9.0'\nempty: true\n")
        return { application: 'applied', changed: true }
      }),
      installBundle: vi.fn(async () => ({
        application: 'failed',
        changed: false,
        error: { code: 'mirror-down' },
      })),
    })
    const result = await applySyncEntry(updateEntry(), deps({ home, profileDir, manager }))
    expect(result).toMatchObject({ outcome: 'failed', reason: 'mirror-down' })
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalPkg)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(originalLock)
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'failed')).toBe(true)
    // Snapshot was written for the op.
    const snapIds = readdirSync(snapshotsDir(home))
    expect(snapIds.length).toBeGreaterThanOrEqual(1)
  })
})

describe('apply integrity mismatch never enables (snapshot-aware)', () => {
  it('never_calls_setBundleEnabled_and_leaves_failed', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
        writeLockfile(
          profileDir,
          `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@1.2.0':\n    resolution: {integrity: ${hexToIntegrity(SHA_BAD)}}\n`,
        )
        return { application: 'applied', changed: true }
      }),
    })
    const result = await applySyncEntry(
      {
        name: '@corp-dsh/demo',
        version: '1.2.0',
        fromVersion: null,
        sha512: SHA_OK,
        action: 'install',
        allowedBuilds: [],
      },
      deps({ home, profileDir, manager }),
    )
    expect(result).toMatchObject({ outcome: 'failed', reason: 'integrity-mismatch' })
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(manager.removeBundle).toHaveBeenCalledWith('@corp-dsh/demo')
  })
})

describe('intent + snapshot under package.json lock', () => {
  it('writes_intent_and_snapshot_inside_withFileLock', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeLockfile(profileDir, "lockfileVersion: '9.0'\n")
    const events: string[] = []
    let sawIntentInsideLock = false
    let sawSnapshotInsideLock = false
    const manager = mockManager({
      installBundle: vi.fn(async () => {
        writePackageJson(profileDir, { '@corp-dsh/demo': '1.2.0' })
        writeLockfile(
          profileDir,
          `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@1.2.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`,
        )
        return { application: 'applied', changed: true }
      }),
    })
    const result = await applySyncEntry(
      {
        name: '@corp-dsh/demo',
        version: '1.2.0',
        fromVersion: null,
        sha512: SHA_OK,
        action: 'install',
        allowedBuilds: [],
      },
      deps({
        home,
        profileDir,
        manager,
        withFileLock: async (file, op) => {
          events.push(`lock:${file}`)
          const out = await op()
          // After precondition+intent lock releases, intent and snapshot must exist.
          if (file === join(profileDir, 'package.json') && events.filter((e) => e.startsWith('lock:')).length === 1) {
            const ops = await readOps(home)
            sawIntentInsideLock = ops.some((o) => o.type === 'intent')
            const ids = existsSync(snapshotsDir(home)) ? readdirSync(snapshotsDir(home)) : []
            sawSnapshotInsideLock = ids.length >= 1
          }
          events.push(`unlock:${file}`)
          return out
        },
      }),
    )
    expect(result.outcome).toBe('done')
    expect(sawIntentInsideLock).toBe(true)
    expect(sawSnapshotInsideLock).toBe(true)
    expect(events[0]).toBe(`lock:${join(profileDir, 'package.json')}`)
  })
})
