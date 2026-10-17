/** Git plumbing for knowledge base repositories. Every invocation ignores system and global configuration, disables hooks and
 * fsmonitor, never prompts and never uses a pager, so a hostile repository configuration cannot run code. Used by the user helper
 * (personal repositories, as the user) and by the service itself (org repositories under `<kbRoot>/org`). */
import { execFile } from 'node:child_process'

/** Environment for every git process: a fixed allow-list, nothing inherited beyond PATH. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', HOME: '/nonexistent', GIT_AUTHOR_NAME: 'dsh-kb', GIT_AUTHOR_EMAIL: 'kb@dsh.invalid', GIT_COMMITTER_NAME: 'dsh-kb',
    GIT_COMMITTER_EMAIL: 'kb@dsh.invalid', ...extra }
}
/** Configuration flags passed before every subcommand. */
export const GIT_SAFE_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never',
  '-c', 'core.symlinks=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'init.defaultBranch=main', '-c', 'safe.directory=*'] as const

/** One git repository handle. */
export interface Git {
  run(args: readonly string[], options?: { input?: Buffer | string; env?: Record<string, string>; maxBuffer?: number }): Promise<Buffer>
  text(args: readonly string[], options?: { input?: Buffer | string; env?: Record<string, string> }): Promise<string>
}

/** Open a git handle.
 * @param gitDir The `.git` directory or bare repository.
 * @param workTree Working tree, for non-bare repositories.
 * @param binary git executable.
 * @returns Handle.
 */
export function openGit(gitDir: string, workTree?: string, binary = 'git'): Git {
  const base = [...GIT_SAFE_FLAGS, `--git-dir=${gitDir}`, ...workTree === undefined ? [] : [`--work-tree=${workTree}`]]
  const run: Git['run'] = (args, options = {}) => new Promise((resolve, reject) => {
    const child = execFile(binary, [...base, ...args], { cwd: workTree ?? gitDir, env: gitEnv(options.env), encoding: 'buffer', maxBuffer: options.maxBuffer ?? 700 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) { reject(Object.assign(new Error(`git ${args[0]} failed: ${String(stderr).slice(0, 300)}`), { code: 'git' })); return }
        resolve(stdout as Buffer)
      })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
  return { run, text: async (args, options) => (await run(args, options)).toString('utf8').trim() }
}

/** Build a commit from `base` with some paths replaced and some prefixes cleared, without touching any working tree.
 * @param git Repository.
 * @param base Parent commit (or undefined for a root commit).
 * @param changes Files to write, and directory prefixes whose existing entries are removed first.
 * @param message Commit message.
 * @param indexFile Scratch index path (a fresh file per call).
 * @returns The new commit ID.
 */
export async function commitTree(git: Git, base: string | undefined, changes: { files: ReadonlyArray<{ path: string; data: Buffer }>; clear?: readonly string[] },
  message: string, indexFile: string): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile }
  if (base !== undefined) await git.run(['read-tree', base], { env })
  else await git.run(['read-tree', '--empty'], { env })
  for (const prefix of changes.clear ?? []) await git.run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', prefix], { env })
  for (const file of changes.files) {
    const sha = await git.text(['hash-object', '-w', '--stdin'], { input: file.data })
    await git.run(['update-index', '--add', '--cacheinfo', `100644,${sha},${file.path}`], { env })
  }
  const tree = await git.text(['write-tree'], { env })
  return git.text(['commit-tree', tree, ...base === undefined ? [] : ['-p', base], '-m', message])
}

/** Tracked size, Markdown page count under `wiki/`, and source count under `raw/` at one commit. */
export async function treeStats(git: Git, rev: string): Promise<{ bytes: number; pages: number; sources: number; tree: string }> {
  const listing = await git.text(['ls-tree', '-r', '-l', '-z', rev]).catch(() => '')
  let bytes = 0, pages = 0, sources = 0
  for (const entry of listing.split('\0')) {
    const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.*)$/s.exec(entry)
    if (match === null) continue
    bytes += Number(match[1])
    const path = match[2]!
    if (path.startsWith('wiki/') && path.toLowerCase().endsWith('.md')) pages++
    if (path.startsWith('raw/') && !path.endsWith('/.gitkeep')) sources++
  }
  const tree = await git.text(['rev-parse', `${rev}^{tree}`])
  return { bytes, pages, sources, tree }
}
