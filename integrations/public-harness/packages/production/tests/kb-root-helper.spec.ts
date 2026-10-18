/** Production root helper: strict configuration, the account re-derived from the user ID, ids from passwd (never root or a system
 * account), the canonical tree only, and the exact hardened `systemd-run` command it starts (checked through a recording stand-in). */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveRootConnection, RootHelperError } from '@public-harness/kb'
import { parseUserId } from '@public-harness/contracts'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { kbRootDeps, parseKbRootConfig } from '../src/kb-root-helper.ts'

const base = { storageRoot: '/srv/dsh-public/storage', kbRoot: '/var/lib/dsh-public/kb', systemdRun: '/usr/bin/systemd-run', node: '/opt/dsh/node/bin/node',
  getent: '/usr/bin/getent', inaccessible: ['/var/lib/dsh-public/kb', '/etc/dsh-public/secrets'] }
const USER = 'user_0123456789abcdef'
const KB = 'kb_abcdefghijklmnop'
const uid = process.getuid!()

describe('kb root helper configuration', () => {
  it('parses_strictly_and_always_hides_the_kb_root', () => {
    expect(parseKbRootConfig(base)).toMatchObject({ minUid: 1000, kbRoot: '/var/lib/dsh-public/kb' })
    expect(parseKbRootConfig({ ...base, minUid: 2000, timeoutMs: 60_000 })).toMatchObject({ minUid: 2000, timeoutMs: 60_000 })
    expect(() => parseKbRootConfig({ ...base, inaccessible: ['/etc/dsh-public/secrets'] })).toThrow(/KB root/)
    expect(() => parseKbRootConfig({ ...base, inaccessible: [...base.inaccessible, '/a b'] })).toThrow(/spaces/)
    expect(() => parseKbRootConfig({ ...base, minUid: 0 })).toThrow(/minUid/)
    expect(() => parseKbRootConfig({ ...base, storageRoot: 'srv' })).toThrow(/storageRoot/)
    expect(() => parseKbRootConfig({ ...base, verbs: ['rm'] })).toThrow(/exactly/)
  })
})

describe('kb root helper', () => {
  let dir: string, storage: string, fake: string
  const account = deriveNames(parseUserId(USER)).account
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-root-prod-'))
    storage = join(dir, 'storage')
    await mkdir(join(storage, 'users', account, 'kb'), { recursive: true, mode: 0o700 })
    fake = join(dir, 'systemd-run')
    // Records argv and stdin instead of starting a unit.
    await writeFile(fake, `#!${process.execPath}\nlet input = '';process.stdin.on('data', c => input += c).on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input })))\n`)
    await chmod(fake, 0o755)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const config = (overrides: Record<string, unknown> = {}) => parseKbRootConfig({ ...base, storageRoot: storage, systemdRun: fake, ...overrides })
  const ids = (value: { uid: number; gid: number } | undefined) => async (name: string) => name === account ? value : undefined
  const serve = async (deps: ReturnType<typeof kbRootDeps>, header: unknown, input = '') => {
    const out: Buffer[] = []
    await serveRootConnection((async function* () { yield Buffer.from(`${JSON.stringify(header)}\n${input}`) })(), chunk => out.push(chunk), deps)
    const all = Buffer.concat(out), newline = all.indexOf(0x0a)
    return { head: JSON.parse(all.subarray(0, newline).toString()), body: all.subarray(newline + 1).toString() }
  }

  it('starts_the_hardened_helper_unit_as_the_derived_account_on_its_canonical_tree', async () => {
    const deps = kbRootDeps(config({ minUid: 1 }), { lookup: ids({ uid, gid: uid }), rootUid: uid })
    const { head, body } = await serve(deps, { verb: 'put', userId: USER, args: { kb: KB, path: 'raw/a.md' }, input: 5 }, 'hello')
    expect(head).toEqual({ ok: true, bytes: Buffer.byteLength(body) })
    const { argv, input } = JSON.parse(body) as { argv: string[]; input: string }
    const kbDir = join(storage, 'users', account, 'kb')
    expect(input).toBe('hello')
    expect(argv).toEqual(expect.arrayContaining([`--uid=${uid}`, `--gid=${uid}`, '--property=NoNewPrivileges=yes', '--property=PrivateNetwork=yes', '--property=CapabilityBoundingSet=',
      '--property=ProtectSystem=strict', `--property=ReadWritePaths=${kbDir}`, '--property=InaccessiblePaths=/var/lib/dsh-public/kb /etc/dsh-public/secrets']))
    expect(argv.slice(argv.indexOf('--') + 1).slice(-3)).toEqual([kbDir, 'put', JSON.stringify({ kb: KB, path: 'raw/a.md' })])
  })
  it('refuses_root_system_accounts_unknown_users_and_unsafe_trees_before_starting_anything', async () => {
    const header = { verb: 'stats', userId: USER, args: { kb: KB }, input: 0 }
    expect((await serve(kbRootDeps(config(), { lookup: ids({ uid: 0, gid: 0 }), rootUid: uid }), header)).head).toEqual({ ok: false, error: 'tree' })
    expect((await serve(kbRootDeps(config({ minUid: uid + 1 }), { lookup: ids({ uid, gid: uid }), rootUid: uid }), header)).head).toEqual({ ok: false, error: 'tree' })
    expect((await serve(kbRootDeps(config({ minUid: 1 }), { lookup: ids(undefined), rootUid: uid }), header)).head).toEqual({ ok: false, error: 'user' })
    // The layout must be root's: the same tree owned by another "root" uid is refused.
    expect((await serve(kbRootDeps(config({ minUid: 1 }), { lookup: ids({ uid, gid: uid }), rootUid: uid + 1 }), header)).head).toEqual({ ok: false, error: 'tree' })
    // A link where the tree should be.
    await rm(join(storage, 'users', account, 'kb'), { recursive: true })
    await mkdir(join(dir, 'elsewhere'))
    await symlink(join(dir, 'elsewhere'), join(storage, 'users', account, 'kb'))
    expect((await serve(kbRootDeps(config({ minUid: 1 }), { lookup: ids({ uid, gid: uid }), rootUid: uid }), header)).head).toEqual({ ok: false, error: 'tree' })
    expect(new RootHelperError('tree').message).toBe('tree')
  })
})
