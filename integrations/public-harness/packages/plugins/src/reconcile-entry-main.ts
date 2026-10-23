/**
 * Node entry for the native reconcile one-shot:
 *   `node reconcile-entry.mjs <planPath> [--market-port=N]`
 * Env is already allowlisted by the transient unit (HOME / DSH_HOME / …)
 * plus entry-only `DSH_MARKET_PORT` / `DSH_HOST_ADDRESS` (not passed to pnpm).
 *
 * `expectedPort` MUST come from argv/env (provisioner / unit setenv) — never from
 * the plan's own registry URL (that would make assertReconcilePlan tautological).
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertReconcilePlan,
  buildReconcileEnv,
  runReconcileEntry,
  type PnpmRunner,
} from './reconcile-entry.ts'

function envOr(name: string, fallback: string): string {
  const value = process.env[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

function createPnpmRunner(command: string): PnpmRunner {
  return {
    run(argv, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...argv], {
          cwd: options.cwd,
          env: { ...options.env },
          stdio: 'ignore',
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ code: 124 })
        }, options.timeoutMs)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve({ code: code ?? 1 })
        })
      })
    },
  }
}

/** Parse `--market-port=N` / `--market-port N` from argv; returns remaining positional args. */
export function takeMarketPortArg(
  argv: readonly string[],
): { readonly port: number | undefined; readonly rest: string[] } {
  const rest: string[] = []
  let port: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--market-port=')) {
      const raw = arg.slice('--market-port='.length)
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n
      continue
    }
    if (arg === '--market-port') {
      const raw = argv[i + 1]
      i += 1
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n
      continue
    }
    rest.push(arg)
  }
  return { port, rest }
}

/**
 * Independent market port for registry checks.
 * Prefer argv `--market-port`, then `DSH_MARKET_PORT` env. Never derived from the plan.
 */
export function resolveExpectedMarketPort(
  argvPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (argvPort !== undefined) return argvPort
  const raw = env.DSH_MARKET_PORT
  if (typeof raw !== 'string' || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined
  return n
}

/** Parse plan, run reconcile; exit 0 on ok, 1 on error, 2 on usage (provisioner starts instance anyway). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { port: argvPort, rest } = takeMarketPortArg(argv)
  const planPath = rest[0]
  if (typeof planPath !== 'string' || planPath === '') {
    process.stderr.write('reconcile-entry: missing plan path\n')
    return 2
  }
  const home = envOr('HOME', '')
  const dshHome = envOr('DSH_HOME', home)
  if (home === '') {
    process.stderr.write('reconcile-entry: HOME is required\n')
    return 2
  }
  const expectedPort = resolveExpectedMarketPort(argvPort, process.env)
  if (expectedPort === undefined) {
    process.stderr.write('reconcile-entry: market port required via --market-port or DSH_MARKET_PORT\n')
    return 2
  }
  const profile = envOr('DSH_PROFILE', 'public-user')
  const profileDir = rest[1] ?? join(dshHome, 'profiles', profile)
  const raw: unknown = JSON.parse(await readFile(planPath, 'utf8'))
  const hostAddress = process.env.DSH_HOST_ADDRESS
  const allowedHosts = hostAddress !== undefined && hostAddress !== ''
    ? ['127.0.0.1', hostAddress]
    : ['127.0.0.1']

  // Validate early so bad plans fail closed before touching the profile.
  assertReconcilePlan(raw, { allowedHosts, expectedPort })

  const env = buildReconcileEnv({
    home,
    dshHome,
    cacheHome: envOr('XDG_CACHE_HOME', join(home, '.cache')),
    tmpdir: envOr('TMPDIR', join(home, 'tmp')),
    path: envOr('PATH', '/usr/bin:/bin'),
    npmGlobalConfig: envOr('NPM_CONFIG_GLOBALCONFIG', '/dev/null'),
  })
  const report = await runReconcileEntry({
    home,
    profileDir,
    plan: raw,
    pnpm: createPnpmRunner(envOr('DSH_PNPM', 'pnpm')),
    allowedHosts,
    expectedPort,
    env,
  })
  return report.outcome === 'ok' ? 0 : 1
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`reconcile-entry: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
