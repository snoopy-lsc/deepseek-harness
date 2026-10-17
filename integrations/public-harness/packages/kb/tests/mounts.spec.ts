/** Phase 1 mounts, checked on generated configuration (the real binds need a native host; see the README): the systemd unit binds
 * `kb/mine` read-write and the view read-only and hides the KB root, the podman argv adds the two volumes and still passes the argv guard,
 * the view directory is created service-owned, and the development runtime links the two paths. */
import { lstat, mkdir, mkdtemp, readlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSystemdConfig } from '../../runtime-systemd/src/config.ts'
import { kbUnitLines, renderUnit } from '../../runtime-systemd/src/units.ts'
import { common, instance, native } from '../../runtime-systemd/tests/fixture.ts'
import { deriveNames } from '../../provisioner/src/accounts.ts'
import { resolveContainerConfig, validateProvisionerConfig } from '../../provisioner/src/config.ts'
import { assertSafeRunArgv, buildRunArgv, CONTAINER, kbVolumes } from '../../provisioner/src/runtime.ts'
import { ensureKbView, ensureStorage, layoutFor } from '../../provisioner/src/storage.ts'
import type { UserRecord } from '../../provisioner/src/users.ts'
import { alice, gid, makeConfig, uid } from '../../provisioner/tests/helpers.ts'
import { linkKnowledgeBases } from '../../dev-runtime/src/processes.ts'

const ownership = { chown: async () => {} }

describe('systemd unit', () => {
  it('binds_mine_rw_and_shared_ro_and_hides_the_kb_root', () => {
    const config = parseSystemdConfig({ common: { ...common, paths: { ...common.paths, kbRoot: '/srv/dsh-public/kb' } }, native })
    const i = instance(), unit = renderUnit(i, config)
    expect(unit).toContain(`BindPaths=/srv/dsh/data/users/${i.account}/kb:${i.home}/kb/mine\n`)
    expect(unit).toContain(`BindReadOnlyPaths=/srv/dsh-public/kb/views/${i.account}:${i.home}/kb/shared\n`)
    expect(unit).toContain('InaccessiblePaths=/srv/dsh/state /run/dsh/sockets /srv/dsh-public/kb /run/dbus /run/systemd /run/user\n')
    // The KB tree is reachable only through the binds: it is not a ReadWritePaths entry.
    expect(unit.split('\n').find(line => line.startsWith('ReadWritePaths='))).not.toContain('/kb')
    // Without a KB root nothing changes.
    expect(kbUnitLines(i, parseSystemdConfig({ common, native }))).toEqual([])
    expect(renderUnit(i, parseSystemdConfig({ common, native }))).not.toContain('kb/')
  })
  it('refuses_a_kb_root_under_hidden_or_overlapping_trees', () => {
    expect(() => parseSystemdConfig({ common: { ...common, paths: { ...common.paths, kbRoot: '/home/kb' } }, native })).toThrow()
    expect(() => validateProvisionerConfig({ ...common, paths: { ...common.paths, kbRoot: '/srv/dsh/data/kb' } })).toThrow(/overlap/)
  })
})

describe('podman volumes', () => {
  it('adds_the_two_volumes_and_the_guard_accepts_exactly_them', async () => {
    const base = await makeConfig()
    const kbRoot = join(base.paths.storageRoot, '..', 'kbroot')
    const config = resolveContainerConfig({ ...base, paths: { ...base.paths, kbRoot } })
    const account = deriveNames(alice)
    const layout = layoutFor(config.paths, account.account)
    const record: UserRecord = { userId: alice, account: account.account, container: account.container, uid, gid, lifecycle: 'starting', layout }
    const argv = buildRunArgv(config, record, config.ports.sidecar.min)
    expect(kbVolumes(config, record)).toEqual([`${layout.kb}:${CONTAINER.home}/kb/mine:rw,Z`, `${kbRoot}/views/${account.account}:${CONTAINER.home}/kb/shared:ro,z`])
    for (const value of kbVolumes(config, record)) expect(argv[argv.indexOf(value) - 1]).toBe('--volume')
    expect(() => assertSafeRunArgv(argv, config, record)).not.toThrow()
    // A view of another account, or a writable view, is refused.
    const other = argv.map(arg => arg.replace(`views/${account.account}:`, 'views/someone-else:'))
    expect(() => assertSafeRunArgv(other, config, record)).toThrow()
    const writable = argv.map(arg => arg.endsWith('/kb/shared:ro,z') ? arg.replace(':ro,z', ':rw,z') : arg)
    expect(() => assertSafeRunArgv(writable, config, record)).toThrow()
  })
  it('storage_creates_the_private_kb_directory_and_a_service_owned_view', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-mount-'))
    const kbRoot = join(dir, 'kb'), storageRoot = join(dir, 'storage')
    await mkdir(join(kbRoot, 'views'), { recursive: true, mode: 0o750 })
    const account = deriveNames(alice).account
    const layout = layoutFor({ storageRoot, socketDir: join(dir, 's') }, account)
    await ensureStorage({ storageRoot, kbRoot }, layout, { uid: process.getuid!(), gid: process.getgid!() }, ownership, 'podman-gvisor')
    expect((await stat(layout.kb)).mode & 0o777).toBe(0o700)
    expect((await stat(join(kbRoot, 'views', account))).mode & 0o777).toBe(0o755)
    await expect(ensureKbView(kbRoot, '../escape', ownership)).rejects.toThrow()
  })
})

describe('development links', () => {
  it('links_mine_and_shared_and_is_idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-dev-'))
    const root = join(dir, 'users', 'alice'), home = join(root, 'home'), kbRoot = join(dir, 'kb')
    await mkdir(home, { recursive: true })
    await linkKnowledgeBases(kbRoot, root, home, 'alice')
    await linkKnowledgeBases(kbRoot, root, home, 'alice')
    expect(await readlink(join(home, 'kb', 'mine'))).toBe(join(root, 'kb'))
    expect(await readlink(join(home, 'kb', 'shared'))).toBe(join(kbRoot, 'views', 'alice'))
    expect((await lstat(join(kbRoot, 'views', 'alice'))).isDirectory()).toBe(true)
  })
})
