/** Real private Git workspaces for each user instance. */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join } from 'node:path'

/** Runs one fixed `git` invocation in a directory; injectable so a provisioner can run it as a service account. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

/** Identity used only for the workspace's initial commit and as the repository-local default. */
export const WORKSPACE_GIT_IDENTITY = { name: 'Harness user', email: 'user@harness.invalid' } as const

/** Minimal environment so no host-level Git configuration or credentials reach the workspace. */
export function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: WORKSPACE_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: WORKSPACE_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: WORKSPACE_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: WORKSPACE_GIT_IDENTITY.email }
}

/** Run `git` locally with the isolated environment. */
export const localGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', [...args], { cwd, env: isolatedGitEnvironment(), timeout: 30_000, maxBuffer: 1 << 20 },
    (error, stdout) => error ? reject(new Error(`git ${args[0] ?? ''} failed`, { cause: error })) : resolve(stdout))
})

/** Create or verify a private Git repository with one initial commit; safe to repeat. */
export async function ensureGitWorkspace(workspace: string, git: GitRunner = localGit): Promise<void> {
  const entry = await lstat(join(workspace, '.git')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (entry !== undefined && !entry.isDirectory()) throw new Error('workspace .git is not a real directory')
  if (entry === undefined) await git(['init', '--quiet', '--initial-branch=main', '--template='], workspace)
  await git(['config', '--local', 'user.name', WORKSPACE_GIT_IDENTITY.name], workspace)
  await git(['config', '--local', 'user.email', WORKSPACE_GIT_IDENTITY.email], workspace)
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], workspace).then(() => true, () => false)
  if (!head) await git(['commit', '--quiet', '--allow-empty', '-m', 'Initialize private workspace'], workspace)
}
