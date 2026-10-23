/**
 * Node entry for the native reconcile one-shot: `node reconcile-entry.mjs <planPath>`.
 * Env is already allowlisted by the transient unit (HOME / DSH_HOME / …).
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

/** Parse plan, run reconcile; exit 0 on ok, 1 on error (provisioner starts instance anyway). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const planPath = argv[0]
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
  const profile = envOr('DSH_PROFILE', 'public-user')
  const profileDir = argv[1] ?? join(dshHome, 'profiles', profile)
  const raw: unknown = JSON.parse(await readFile(planPath, 'utf8'))
  const hostAddress = process.env.DSH_HOST_ADDRESS
  const allowedHosts = hostAddress !== undefined && hostAddress !== ''
    ? ['127.0.0.1', hostAddress]
    : ['127.0.0.1']

  let expectedPort = -1
  try {
    const registry = (raw as { registry?: unknown }).registry
    if (typeof registry === 'string') {
      const url = new URL(registry)
      expectedPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    }
  } catch {
    expectedPort = -1
  }
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
