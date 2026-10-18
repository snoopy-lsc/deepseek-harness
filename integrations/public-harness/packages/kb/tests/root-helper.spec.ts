/** Root helper threats: the only privileged step (starting the user helper as the tree's owner) accepts a fixed verb set, strictly
 * validated arguments, and a canonical, symlink-free tree whose owners match the host layout; everything else is refused. */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalKbDir, createRootHelperRunner, parseRootRequest, ROOT_VERBS, RootHelperError, serveRootConnection, type RootHelperDeps } from '../src/root-helper.ts'
import type { UserTree } from '../src/runner.ts'

const USER = 'user_0123456789abcdef'
const KB = 'kb_abcdefghijklmnop'
const SHA = 'a'.repeat(40)
const uid = process.getuid!()
const header = (value: unknown) => `${JSON.stringify(value)}\n`

describe('root helper request', () => {
  it('accepts_only_the_fixed_verb_set', () => {
    expect([...ROOT_VERBS].sort()).toEqual(['apply', 'archive', 'commit', 'head', 'init', 'log', 'put', 'show', 'stats'])
    for (const verb of ['rm', 'exec', 'mount', 'swap-view', 'git', '__proto__', 'constructor', 'toString', 'INIT', ' init', 'init\n']) {
      expect(() => parseRootRequest(header({ verb, userId: USER, args: { kb: KB }, input: 0 }))).toThrow(/verb/)
    }
    expect(parseRootRequest(header({ verb: 'stats', userId: USER, args: { kb: KB }, input: 0 }))).toEqual({ verb: 'stats', userId: USER, args: { kb: KB }, input: 0 })
  })
  it('refuses_argument_injection_into_the_helper_command_line', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['archive', { kb: KB, rev: '--output=/etc/passwd' }],
      ['archive', { kb: KB, rev: `${SHA} --remote=x` }],
      ['show', { kb: KB, rev: 'HEAD', path: '--output=/tmp/x' }],
      ['head', { kb: KB, rev: 'HEAD~1' }],
      ['apply', { kb: KB, base: SHA, job: 'job_abcdefghijklmnop', mode: 'auto; rm -rf /' }],
      ['apply', { kb: KB, base: SHA, job: '$(id)', mode: 'auto' }],
      ['log', { kb: KB, limit: '50 --all' }],
      ['log', { kb: KB, limit: 1e9 }],
      ['commit', { kb: KB, message: 'line\n--author=evil' }],
      ['commit', { kb: KB, message: 'nul\0byte' }],
      ['init', { kb: KB, title: 'x', from: 'git' }],
      ['stats', { kb: KB, extra: true }],
      ['stats', { kb: `${KB} --exec` }],
      ['stats', { kb: { toString: 'x' } }],
      ['put', { kb: KB, path: 'raw/a', pages: 'yes' }],
      ['stats', {}],
    ]
    for (const [verb, args] of bad) expect(() => parseRootRequest(header({ verb, userId: USER, args, input: 0 })), `${verb} ${JSON.stringify(args)}`).toThrow(/args/)
    expect(() => parseRootRequest(header({ verb: 'stats', userId: USER, args: { kb: KB }, input: 0, uid: 0 }))).toThrow(/request/)
    expect(() => parseRootRequest(header({ verb: 'stats', userId: USER, args: { kb: KB }, input: 0, kbDir: '/' }))).toThrow(/request/)
    expect(() => parseRootRequest(header({ verb: 'stats', userId: USER, args: { kb: KB }, input: 5 }))).toThrow(/input/)
    expect(() => parseRootRequest('{"verb":"stats"')).toThrow(/request/)
    expect(() => parseRootRequest(header({ verb: 'stats', userId: USER, args: JSON.parse('{"__proto__":{"x":1},"kb":"kb_abcdefghijklmnop"}'), input: 0 }))).toThrow(/args/)
  })
  it('refuses_path_traversal_in_user_ids_and_paths', () => {
    for (const userId of ['../etc', '..', 'a/b', '', 'x'.repeat(129), '.org', 'root\n', 'user 1']) {
      expect(() => parseRootRequest(header({ verb: 'stats', userId, args: { kb: KB }, input: 0 }))).toThrow(/user/)
    }
    for (const path of ['../../etc/passwd', 'raw/../../x', '/etc/shadow', 'raw//a', 'raw/./a', 'raw\\a', '']) {
      expect(() => parseRootRequest(header({ verb: 'put', userId: USER, args: { kb: KB, path }, input: 1 }))).toThrow(/args/)
      expect(() => parseRootRequest(header({ verb: 'show', userId: USER, args: { kb: KB, path }, input: 0 }))).toThrow(/args/)
    }
    expect(parseRootRequest(header({ verb: 'put', userId: USER, args: { kb: KB, path: 'raw/notes.md', message: 'Add source raw/notes.md (a@corp.example)' }, input: 3 })).input).toBe(3)
  })
})

describe('canonical tree', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kb-root-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const layout = async (account = 'dsh-0123') => { await mkdir(join(dir, 'users', account, 'kb'), { recursive: true, mode: 0o700 }); return join(dir, 'users', account, 'kb') }
  const check = (account: string, owner = uid) => canonicalKbDir({ storageRoot: dir, rootUid: uid }, account, owner)

  it('returns_the_canonical_kb_dir_of_the_owner', async () => {
    expect(await check(await layout().then(() => 'dsh-0123'))).toBe(join(dir, 'users', 'dsh-0123', 'kb'))
  })
  it('refuses_symlinks_anywhere_on_the_path', async () => {
    await mkdir(join(dir, 'users', 'other', 'kb'), { recursive: true })
    await symlink(join(dir, 'users', 'other'), join(dir, 'users', 'dsh-link'))
    await expect(check('dsh-link')).rejects.toThrow(/tree/)
    await mkdir(join(dir, 'users', 'dsh-kblink'))
    await symlink('/etc', join(dir, 'users', 'dsh-kblink', 'kb'))
    await expect(check('dsh-kblink')).rejects.toThrow(/tree/)
    const outer = await mkdtemp(join(tmpdir(), 'kb-root-link-'))
    try {
      await symlink(dir, join(outer, 'storage'))
      await layout()
      await expect(canonicalKbDir({ storageRoot: join(outer, 'storage'), rootUid: uid }, 'dsh-0123', uid)).rejects.toThrow(/tree/)
    } finally { await rm(outer, { recursive: true, force: true }) }
  })
  it('refuses_wrong_owners_writable_parents_missing_trees_and_unsafe_accounts', async () => {
    await layout()
    await expect(check('dsh-0123', uid + 1)).rejects.toThrow(/tree/)
    await expect(canonicalKbDir({ storageRoot: dir, rootUid: uid + 1 }, 'dsh-0123', uid)).rejects.toThrow(/tree/)
    await expect(check('dsh-missing')).rejects.toThrow(/tree/)
    for (const account of ['..', '.', '../users', 'a/b', '']) await expect(check(account)).rejects.toThrow(/tree/)
    await expect(canonicalKbDir({ storageRoot: 'relative', rootUid: uid }, 'dsh-0123', uid)).rejects.toThrow(/tree/)
  })
})

describe('root helper connection', () => {
  let server: Server | undefined, dir: string
  const calls: Array<{ tree: UserTree; verb: string; args: unknown; input: string }> = []
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kb-root-sock-')); calls.length = 0 })
  afterEach(async () => { await new Promise(resolve => server ? server.close(resolve) : resolve(undefined)); server = undefined; await rm(dir, { recursive: true, force: true }) })

  const deps: RootHelperDeps = {
    resolve: async userId => userId === USER ? { userId, account: 'dsh-0123', kbDir: '/srv/users/dsh-0123/kb', uid: 61000, gid: 61000 } : undefined,
    run: async (tree, verb, args, input) => {
      calls.push({ tree, verb, args, input: input.toString('utf8') })
      if (args.kb === 'kb_failfailfailfai2') throw new RootHelperError('helper', 'fatal: bad revision')
      return Buffer.from(JSON.stringify({ ok: verb }))
    },
  }
  const listen = async () => {
    const path = join(dir, 'root.sock')
    server = createServer({ allowHalfOpen: true }, socket => { void serveRootConnection(socket.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>, chunk => socket.write(chunk), deps).finally(() => socket.end()) })
    await new Promise<void>(resolve => server!.listen(path, resolve))
    return createRootHelperRunner({ socket: path })
  }
  const tree: UserTree = { userId: USER, account: 'forged', kbDir: '/', uid: 0, gid: 0 }

  it('round_trips_and_ignores_every_path_or_id_the_caller_supplies', async () => {
    const runner = await listen()
    expect(JSON.parse((await runner.run(tree, 'put', { kb: KB, path: 'raw/a.md' }, Buffer.from('hello'))).toString())).toEqual({ ok: 'put' })
    expect(calls).toEqual([{ tree: { userId: USER, account: 'dsh-0123', kbDir: '/srv/users/dsh-0123/kb', uid: 61000, gid: 61000 }, verb: 'put', args: { kb: KB, path: 'raw/a.md' }, input: 'hello' }])
  })
  it('reports_refusals_without_running_anything', async () => {
    const runner = await listen()
    await expect(runner.run({ ...tree, userId: 'user_unknown000000000' }, 'stats', { kb: KB })).rejects.toThrow(/kb helper failed/)
    await expect(runner.run(tree, 'stats' as never, { kb: '../../etc' })).rejects.toMatchObject({ detail: 'root-helper: args' })
    await expect(runner.run(tree, 'rm' as never, { kb: KB })).rejects.toMatchObject({ detail: 'root-helper: verb' })
    await expect(runner.run({ ...tree, userId: 'user_unknown000000000' }, 'stats', { kb: KB })).rejects.toMatchObject({ detail: 'root-helper: user' })
    await expect(runner.run(tree, 'stats', { kb: 'kb_failfailfailfai2' })).rejects.toMatchObject({ detail: 'fatal: bad revision' })
    expect(calls.map(call => call.args)).toEqual([{ kb: 'kb_failfailfailfai2' }])
  })
  it('refuses_trailing_bytes_and_oversized_headers', async () => {
    const out: Buffer[] = []
    const frames = async function* (...chunks: string[]) { for (const chunk of chunks) yield Buffer.from(chunk) }
    await serveRootConnection(frames(header({ verb: 'stats', userId: USER, args: { kb: KB }, input: 0 }), 'extra'), chunk => out.push(chunk), deps)
    expect(Buffer.concat(out).toString()).toBe(`${JSON.stringify({ ok: false, error: 'input' })}\n`)
    out.length = 0
    await serveRootConnection(frames('x'.repeat(20_000)), chunk => out.push(chunk), deps)
    expect(Buffer.concat(out).toString()).toBe(`${JSON.stringify({ ok: false, error: 'request' })}\n`)
    expect(calls).toEqual([])
  })
})
