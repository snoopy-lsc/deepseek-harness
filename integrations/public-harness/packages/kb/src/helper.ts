#!/usr/bin/env node
/** The user helper: every operation on a personal knowledge base tree runs here, as the tree's owner.
 *
 * Production starts it through a transient `systemd-run --uid=<user>` unit with the instance's sandbox, so the host never follows
 * paths the user controls; development spawns it directly (not enforcing). Usage: `helper <op> <json>`; binary input arrives on stdin,
 * results leave on stdout (JSON, or the tar stream for `archive`). Git runs with hooks, fsmonitor and system configuration disabled. */
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { commitTree, openGit, treeStats } from './git.ts'
import { readTar, safeRelativePath, SOURCE_EXTENSIONS } from './tar.ts'
import { templateFiles } from './templates.ts'

/** Operations the helper accepts. */
export const HELPER_OPS = ['init', 'put', 'commit', 'head', 'archive', 'stats', 'apply', 'log', 'show'] as const
export type HelperOp = typeof HELPER_OPS[number]

const KB_ID = /^kb_[a-z2-7]{16}$/
const JOB_ID = /^job_[a-z2-7]{16}$/
const SHA = /^[0-9a-f]{40,64}$/

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}
async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a real directory')
}

/** Run one helper operation.
 * @param root The user's `kb` directory.
 * @param op Operation.
 * @param args Operation arguments.
 * @param input Binary input (sources, apply archives).
 * @returns JSON result or archive bytes.
 */
export async function runHelper(root: string, op: HelperOp, args: Record<string, unknown>, input: Buffer): Promise<unknown> {
  const kb = String(args.kb ?? '')
  if (!KB_ID.test(kb)) throw new Error('kb id')
  const dir = join(root, kb)
  const git = openGit(join(dir, '.git'), dir)
  const scratch = join(dir, '.git', `dsh-index-${process.pid}-${Date.now()}`)
  const head = async () => git.text(['rev-parse', 'HEAD'])
  const clean = async () => (await git.text(['status', '--porcelain', '--untracked-files=all'])) === ''
  if (op === 'init') {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await realDirectory(root)
    await mkdir(dir, { mode: 0o700 })
    await git.run(['init', '-q', '-b', 'main'])
    for (const file of templateFiles(String(args.title ?? kb), new Date())) {
      const target = join(dir, file.path)
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      await writeFile(target, file.data, { mode: 0o600, flag: 'wx' })
    }
    // `from` (org conversion): the tree of a published snapshot arrives as a validated tar and replaces the template.
    if (args.from === 'tar') {
      const { files } = readTar(input, { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, extensions: SOURCE_EXTENSIONS })
      for (const file of files) {
        const target = join(dir, safeRelativePath(file.path))
        await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, file.data, { mode: 0o600 })
      }
    }
    await git.run(['add', '-A'])
    await git.run(['commit', '-q', '-m', String(args.message ?? 'Create knowledge base')])
    return { head: await head() }
  }
  await realDirectory(dir)
  if (op === 'put') {
    const path = safeRelativePath(String(args.path ?? ''))
    // Sources always; pages and the index only when the caller edits pages (org knowledge bases).
    const page = args.pages === true && /^(wiki\/[^/]+\.md|index\.md|schema\.md)$/.test(path)
    if (!/^raw\/[^/]+$/.test(path) && !page) throw new Error('path')
    const parent = path.includes('/') ? path.slice(0, path.indexOf('/')) : ''
    if (parent !== '') {
      await mkdir(join(dir, parent), { recursive: true, mode: 0o700 })
      await realDirectory(join(dir, parent))
    }
    const target = join(dir, path), temp = `${target}.dsh-upload-${process.pid}`
    const existing = await lstat(target).catch(() => undefined)
    if (existing !== undefined && !existing.isFile()) throw new Error('target is not a regular file')
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(input); await handle.sync() } finally { await handle.close() }
    await rename(temp, target)
    await git.run(['add', '--', path])
    const staged = await git.run(['diff', '--cached', '--quiet']).then(() => false, () => true)
    if (staged) await git.run(['commit', '-q', '-m', String(args.message ?? `Add ${path}`)])
    return { head: await head(), bytes: input.length, changed: staged }
  }
  if (op === 'commit') {
    await git.run(['add', '-A'])
    const staged = await git.run(['diff', '--cached', '--quiet']).then(() => false, () => true)
    if (staged) await git.run(['commit', '-q', '-m', String(args.message ?? 'Commit working tree')])
    return { head: await head(), committed: staged }
  }
  if (op === 'head') {
    const commit = args.rev === undefined ? await head() : SHA.test(String(args.rev)) ? await git.text(['rev-parse', '--verify', `${String(args.rev)}^{commit}`]) : (() => { throw new Error('rev') })()
    return { head: commit, tree: await git.text(['rev-parse', `${commit}^{tree}`]), clean: await clean() }
  }
  if (op === 'log') {
    const out = await git.text(['log', '-n', String(Math.min(100, Math.max(1, Number(args.limit ?? 50)))), '--format=%H%x09%ct%x09%s', 'HEAD'])
    return { commits: out === '' ? [] : out.split('\n').map(line => { const [sha, at, ...subject] = line.split('\t'); return { sha, at: Number(at) * 1000, subject: subject.join('\t') } }) }
  }
  if (op === 'show') {
    const rev = String(args.rev ?? 'HEAD'), path = safeRelativePath(String(args.path ?? ''))
    if (rev !== 'HEAD' && !SHA.test(rev)) throw new Error('rev')
    return git.run(['show', `${rev}:${path}`])
  }
  if (op === 'stats') return { head: await head(), ...await treeStats(git, 'HEAD') }
  if (op === 'archive') {
    const rev = String(args.rev ?? '')
    if (!SHA.test(rev)) throw new Error('rev')
    return git.run(['archive', '--format=tar', rev, ...args.excludeRaw === true ? ['--', '.', ':(exclude)raw'] : []])
  }
  if (op === 'apply') {
    const base = String(args.base ?? ''), job = String(args.job ?? '')
    if (!SHA.test(base) || !JOB_ID.test(job)) throw new Error('apply args')
    const { files } = readTar(input, { maxFiles: 5000, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, extensions: ['.md'] })
    if (files.some(file => !(file.path.startsWith('wiki/') || file.path === 'index.md' || file.path === 'log.md'))) throw new Error('apply paths')
    let commit: string
    try { commit = await commitTree(git, base, { files, clear: ['wiki'] }, String(args.message ?? `Compile ${job}`), scratch) }
    finally { await rm(scratch, { force: true }) }
    const current = await head()
    if (args.mode === 'auto' && current === base && await clean()) {
      await git.run(['merge', '--ff-only', '-q', commit])
      return { commit, applied: 'head' }
    }
    await git.run(['update-ref', `refs/heads/kb/compile/${job}`, commit])
    return { commit, applied: 'branch' }
  }
  throw new Error('op')
}

/** List the KB repositories present in a user's tree (used by tests and repair). */
export async function listRepositories(root: string): Promise<string[]> {
  return (await readdir(root).catch(() => [] as string[])).filter(name => KB_ID.test(name)).sort()
}

const invoked = process.argv[1] !== undefined && /helper\.(?:js|ts)$/.test(process.argv[1])
if (invoked) {
  void (async () => {
    try {
      const [root, op, json] = process.argv.slice(2)
      if (root === undefined || !root.startsWith('/') || !HELPER_OPS.includes(op as HelperOp)) throw new Error('usage')
      const args = JSON.parse(json ?? '{}') as Record<string, unknown>
      const input = op === 'put' || op === 'apply' ? await readStdin() : Buffer.alloc(0)
      const result = await runHelper(root, op as HelperOp, args, input)
      if (Buffer.isBuffer(result)) process.stdout.write(result)
      else process.stdout.write(JSON.stringify(result))
    } catch (error) {
      process.stderr.write(`kb-helper: ${(error as Error).message.slice(0, 300)}\n`)
      process.exitCode = 1
    }
  })()
}
