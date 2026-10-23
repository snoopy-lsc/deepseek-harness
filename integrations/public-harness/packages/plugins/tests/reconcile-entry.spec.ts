/** 1D.6: reconcile entry — plan validation, recovery, pnpm argv, repair (P0.4 fixtures). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendOp,
  listQueuedRestores,
  queueRestore,
  readOps,
  writeProfileSnapshot,
} from '@public-harness/plugin-sync'
import {
  RECONCILE_ENV_ALLOWLIST,
  ReconcileEntryError,
  assertReconcilePlan,
  buildPnpmAddArgv,
  buildPnpmRepairArgv,
  buildReconcileEnv,
  runReconcileEntry,
  type PnpmRunner,
  type ReconcileEntryPlan,
} from '../src/reconcile-entry.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(): { home: string; profileDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reconcile-'))
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

function writeLockfile(profileDir: string, body: string): void {
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), body)
}

const SHA_OK = 'ab'.repeat(64)
const INTEGRITY_OK = `sha512-${Buffer.from(SHA_OK, 'hex').toString('base64')}`

function plan(overrides: Partial<ReconcileEntryPlan> = {}): ReconcileEntryPlan {
  return {
    registry: 'http://127.0.0.1:31001/npm/',
    entries: [
      {
        name: '@corp-dsh/demo',
        version: '2.0.0',
        fromVersion: null,
        sha512: SHA_OK,
        action: 'install',
        allowedBuilds: ['native-addon'],
        spec: '@corp-dsh/demo@2.0.0',
      },
    ],
    ...overrides,
  }
}

describe('assertReconcilePlan', () => {
  it('accepts_user_market_registry_on_loopback_with_exact_semver_and_sha512', () => {
    const accepted = assertReconcilePlan(plan(), { allowedHosts: ['127.0.0.1'], expectedPort: 31001 })
    expect(accepted.registry).toBe('http://127.0.0.1:31001/npm/')
    expect(accepted.entries[0]!.spec).toBe('@corp-dsh/demo@2.0.0')
  })

  it('aborts_on_bad_registry_host_or_port', () => {
    expect(() => assertReconcilePlan(plan({ registry: 'http://8.8.8.8:31001/npm/' }), {
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
    })).toThrow(ReconcileEntryError)
    expect(() => assertReconcilePlan(plan({ registry: 'http://127.0.0.1:9999/npm/' }), {
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
    })).toThrow(/bad-registry/)
  })

  it('aborts_on_non_exact_semver_or_missing_sha512', () => {
    expect(() => assertReconcilePlan(plan({
      entries: [{
        name: '@corp-dsh/demo',
        version: '^2.0.0',
        fromVersion: null,
        sha512: SHA_OK,
        action: 'install',
        allowedBuilds: [],
        spec: '@corp-dsh/demo@^2.0.0',
      }],
    }), { allowedHosts: ['127.0.0.1'], expectedPort: 31001 })).toThrow(/bad-entry/)

    expect(() => assertReconcilePlan(plan({
      entries: [{
        name: '@corp-dsh/demo',
        version: '2.0.0',
        fromVersion: null,
        sha512: '',
        action: 'install',
        allowedBuilds: [],
        spec: '@corp-dsh/demo@2.0.0',
      }],
    }), { allowedHosts: ['127.0.0.1'], expectedPort: 31001 })).toThrow(/bad-entry/)
  })

  it('accepts_hostAddress_as_registry_host', () => {
    const accepted = assertReconcilePlan(plan({ registry: 'http://192.168.200.1:31001/npm/' }), {
      allowedHosts: ['127.0.0.1', '192.168.200.1'],
      expectedPort: 31001,
    })
    expect(accepted.registry).toContain('192.168.200.1')
  })
})

describe('pnpm argv and env allowlist (P0.4 substitute)', () => {
  it('buildPnpmAddArgv_sets_ignore_pnpmfile_registry_userconfig_and_allow_build', () => {
    const argv = buildPnpmAddArgv({
      registry: 'http://127.0.0.1:31001/npm/',
      spec: '@corp-dsh/demo@2.0.0',
      allowedBuilds: ['native-addon', 'other'],
    })
    expect(argv).toEqual([
      'add',
      '@corp-dsh/demo@2.0.0',
      '--ignore-pnpmfile',
      '--config.registry=http://127.0.0.1:31001/npm/',
      '--config.userconfig=/dev/null',
      '--allow-build=native-addon',
      '--allow-build=other',
    ])
    expect(argv.join(' ')).not.toContain('ignore-scripts')
  })

  it('buildPnpmRepairArgv_offline_then_online_against_mirror', () => {
    expect(buildPnpmRepairArgv({ offline: true, registry: 'http://127.0.0.1:31001/npm/' })).toEqual([
      'install',
      '--frozen-lockfile',
      '--offline',
      '--ignore-pnpmfile',
      '--config.userconfig=/dev/null',
    ])
    expect(buildPnpmRepairArgv({ offline: false, registry: 'http://127.0.0.1:31001/npm/' })).toEqual([
      'install',
      '--frozen-lockfile',
      '--config.registry=http://127.0.0.1:31001/npm/',
      '--ignore-pnpmfile',
      '--config.userconfig=/dev/null',
    ])
  })

  it('buildReconcileEnv_allowlist_exactly_six_keys_no_model_key', () => {
    const env = buildReconcileEnv({
      home: '/home/u',
      dshHome: '/home/u',
      cacheHome: '/home/u/cache',
      tmpdir: '/home/u/tmp',
      path: '/opt/dsh/toolchain:/usr/bin',
      npmGlobalConfig: '/run/dsh/instance-market/u.npmrc',
      inherit: {
        HOME: '/root',
        DSH_MODEL_API_KEY: 'secret',
        npm_config_registry: 'https://evil.example',
        HTTP_PROXY: 'http://proxy',
        EXTRA: 'nope',
      },
    })
    expect(Object.keys(env).sort()).toEqual([...RECONCILE_ENV_ALLOWLIST].sort())
    expect(env.HOME).toBe('/home/u')
    expect(env.NPM_CONFIG_GLOBALCONFIG).toBe('/run/dsh/instance-market/u.npmrc')
    expect(env).not.toHaveProperty('DSH_MODEL_API_KEY')
    expect(env).not.toHaveProperty('npm_config_registry')
    expect(env).not.toHaveProperty('HTTP_PROXY')
    expect(env).not.toHaveProperty('EXTRA')
  })
})

describe('runReconcileEntry', () => {
  it('skips_user_removed_packages', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'user-removed', name: '@corp-dsh/demo', at: 2 })
    const runs: string[][] = []
    const pnpm: PnpmRunner = {
      async run(argv) {
        runs.push([...argv])
        return { code: 0 }
      },
    }
    const report = await runReconcileEntry({
      home,
      profileDir,
      plan: plan(),
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
    })
    expect(report.results).toEqual([
      expect.objectContaining({ name: '@corp-dsh/demo', outcome: 'skipped', reason: 'user-removed' }),
    ])
    expect(runs).toEqual([])
  })

  it('restores_open_failed_sync_from_snapshot_at_start', async () => {
    const { home, profileDir } = fixture()
    const originalPkg = `${JSON.stringify({ name: 'dsh', dependencies: { '@corp-dsh/demo': '1.0.0' } }, null, 2)}\n`
    const originalLock = "lockfileVersion: '9.0'\nsnapshot-marker: true\n"
    writeFileSync(join(profileDir, 'package.json'), originalPkg)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), originalLock)
    await writeProfileSnapshot(home, profileDir, 'op-failed-1')
    // Corrupt profile after the failed sync left it messy.
    writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0-broken' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\nbroken: true\n")
    await appendOp(home, {
      type: 'intent', name: '@corp-dsh/demo', version: '2.0.0', action: 'update', opId: 'op-failed-1', at: 10,
    })
    await appendOp(home, {
      type: 'failed', name: '@corp-dsh/demo', version: '2.0.0', action: 'update', opId: 'op-failed-1',
      reason: 'install-failed', at: 11,
    })
    const pnpm: PnpmRunner = { async run() { return { code: 0 } } }
    await runReconcileEntry({
      home,
      profileDir,
      plan: { registry: 'http://127.0.0.1:31001/npm/', entries: [] },
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
    })
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalPkg)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(originalLock)
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'recovered' && o.opId === 'op-failed-1')).toBe(true)
  })

  it('executes_queued_restores_at_start_then_clears_queue', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(profileDir, "lockfileVersion: '9.0'\nv1: true\n")
    await writeProfileSnapshot(home, profileDir, 'snap-queued')
    writePackageJson(profileDir, { '@corp-dsh/demo': '9.9.9' })
    await queueRestore(home, { snapshotId: 'snap-queued', reason: 'user', at: 50 })
    expect(await listQueuedRestores(home)).toHaveLength(1)
    const pnpm: PnpmRunner = { async run() { return { code: 0 } } }
    await runReconcileEntry({
      home,
      profileDir,
      plan: { registry: 'http://127.0.0.1:31001/npm/', entries: [] },
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
    })
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toContain('"1.0.0"')
    expect(await listQueuedRestores(home)).toEqual([])
  })

  it('installs_with_pnpm_add_argv_and_records_done', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, {})
    writeLockfile(profileDir, "lockfileVersion: '9.0'\npackages: {}\n")
    const runs: string[][] = []
    const pnpm: PnpmRunner = {
      async run(argv, opts) {
        runs.push([...argv])
        expect(opts.env).not.toHaveProperty('DSH_MODEL_API_KEY')
        writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0' })
        writeLockfile(
          profileDir,
          `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@2.0.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`,
        )
        return { code: 0 }
      },
    }
    const report = await runReconcileEntry({
      home,
      profileDir,
      plan: plan(),
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
      pkgTimeoutMs: 5_000,
      totalTimeoutMs: 30_000,
    })
    expect(runs[0]).toEqual(buildPnpmAddArgv({
      registry: 'http://127.0.0.1:31001/npm/',
      spec: '@corp-dsh/demo@2.0.0',
      allowedBuilds: ['native-addon'],
    }))
    expect(report.results[0]).toMatchObject({ outcome: 'done', name: '@corp-dsh/demo' })
    const ops = await readOps(home)
    expect(ops.some((o) => o.type === 'done' && o.name === '@corp-dsh/demo')).toBe(true)
  })

  it('on_failure_restores_snapshot_then_offline_then_online_repair', async () => {
    const { home, profileDir } = fixture()
    const originalPkg = `${JSON.stringify({ name: 'dsh', dependencies: {} }, null, 2)}\n`
    writeFileSync(join(profileDir, 'package.json'), originalPkg)
    writeLockfile(profileDir, "lockfileVersion: '9.0'\nempty: true\n")
    const runs: string[][] = []
    const pnpm: PnpmRunner = {
      async run(argv) {
        runs.push([...argv])
        if (argv[0] === 'add') {
          writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0-partial' })
          return { code: 1 }
        }
        if (argv.includes('--offline')) return { code: 1 }
        // online repair succeeds
        writeFileSync(join(profileDir, 'package.json'), originalPkg)
        writeLockfile(profileDir, "lockfileVersion: '9.0'\nempty: true\n")
        return { code: 0 }
      },
    }
    const report = await runReconcileEntry({
      home,
      profileDir,
      plan: plan(),
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
    })
    expect(report.results[0]).toMatchObject({ outcome: 'failed' })
    expect(runs.some((a) => a[0] === 'add')).toBe(true)
    expect(runs.some((a) => a.includes('--offline'))).toBe(true)
    expect(runs.some((a) => a[0] === 'install' && a.includes('--config.registry=http://127.0.0.1:31001/npm/'))).toBe(true)
    // Offline before online.
    const offlineIdx = runs.findIndex((a) => a.includes('--offline'))
    const onlineIdx = runs.findIndex((a) => a[0] === 'install' && a.includes('--config.registry=http://127.0.0.1:31001/npm/'))
    expect(offlineIdx).toBeGreaterThanOrEqual(0)
    expect(onlineIdx).toBeGreaterThan(offlineIdx)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalPkg)
    expect(report.outcome).toBe('error')
  })

  it('update_uses_single_pnpm_add_name_at_version', async () => {
    const { home, profileDir } = fixture()
    writePackageJson(profileDir, { '@corp-dsh/demo': '1.0.0' })
    writeLockfile(
      profileDir,
      `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@1.0.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`,
    )
    const runs: string[][] = []
    const pnpm: PnpmRunner = {
      async run(argv) {
        runs.push([...argv])
        writePackageJson(profileDir, { '@corp-dsh/demo': '2.0.0' })
        writeLockfile(
          profileDir,
          `lockfileVersion: '9.0'\n\npackages:\n  '@corp-dsh/demo@2.0.0':\n    resolution: {integrity: ${INTEGRITY_OK}}\n`,
        )
        return { code: 0 }
      },
    }
    await runReconcileEntry({
      home,
      profileDir,
      plan: plan({
        entries: [{
          name: '@corp-dsh/demo',
          version: '2.0.0',
          fromVersion: '1.0.0',
          sha512: SHA_OK,
          action: 'update',
          allowedBuilds: [],
          spec: '@corp-dsh/demo@2.0.0',
        }],
      }),
      pnpm,
      allowedHosts: ['127.0.0.1'],
      expectedPort: 31001,
      env: buildReconcileEnv({
        home, dshHome: home, cacheHome: join(home, 'cache'), tmpdir: join(home, 'tmp'),
        path: '/usr/bin', npmGlobalConfig: '/dev/null',
      }),
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]![0]).toBe('add')
    expect(runs[0]![1]).toBe('@corp-dsh/demo@2.0.0')
  })
})
