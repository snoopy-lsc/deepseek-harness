/** The only way the provisioner touches the host: fixed absolute commands through an injectable runner. */
import { execFile } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'

/** Outcome of one command; `code` is the process exit status. */
export interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Optional per-call settings. `env` replaces the child environment entirely. */
export interface CommandOptions { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> }

/** Run one executable with an argument vector; never a shell string. */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>
}

/** A command failed; the message names only the executable and exit status, never arguments or output. */
export class CommandError extends Error {
  override readonly name = 'CommandError'
  constructor(readonly command: string, readonly code: number) {
    super(`command failed: ${basename(command)} (exit ${code})`)
  }
}

/** Production runner backed by `execFile`; relative commands are refused so PATH never selects a binary. */
export function createCommandRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      if (!isAbsolute(command) || command.includes('\0') || args.some(arg => arg.includes('\0'))) {
        return Promise.reject(new Error('commands must be absolute and free of NUL bytes'))
      }
      return new Promise(resolve => {
        execFile(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 4 << 20,
          env: options.env === undefined ? { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } : { ...options.env },
          encoding: 'utf8' }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code : 127
          resolve({ code, stdout, stderr })
        })
      })
    },
  }
}

/** Run a command and return stdout, throwing `CommandError` on a non-zero exit. */
export async function runChecked(runner: CommandRunner, command: string, args: readonly string[],
  options?: CommandOptions): Promise<string> {
  const result = await runner.run(command, args, options)
  if (result.code !== 0) throw new CommandError(command, result.code)
  return result.stdout
}

/** Per-key serialization: calls with the same key never overlap; different keys run in parallel. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    try { return await result } finally { if (this.tails.get(key) === tail) this.tails.delete(key) }
  }
}
