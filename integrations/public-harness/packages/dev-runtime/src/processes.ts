/** One real Web child per development test user. */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceEndpoint, UserId } from '@public-harness/contracts'
import type { DevRuntimeConfig } from './config.ts'

/** Live child values known only after the Web token plugin publishes readiness. */
export interface RunningWeb {
  readonly endpoint: InstanceEndpoint
  readonly grant: string
  readonly closed: Promise<void>
  stop(): Promise<void>
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('development user path is not a real directory')
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

function childEnvironment(home: string, agentsHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH'].includes(key),
  ))
  return { ...env, HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1' }
}

function readyValues(message: unknown): { port: number; token: string } | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const record = message as Record<string, unknown>
  if (record.kind !== 'public-harness/web-ready') return undefined
  if (Object.keys(record).sort().join(',') !== 'kind,port,token'
    || typeof record.port !== 'number' || !Number.isInteger(record.port)
    || record.port < 1 || record.port > 65535 || typeof record.token !== 'string'
    || !record.token || record.token.length > 4096) {
    throw new Error('invalid private Web readiness message')
  }
  return { port: record.port, token: record.token }
}

/** Start a dsh Web profile, await its private IPC readiness, and retain its stop handle. */
export async function startWebProcess(config: DevRuntimeConfig, userId: UserId): Promise<RunningWeb> {
  const root = join(config.storageRoot, 'users', userId)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const agentsHome = join(root, 'agents')
  for (const path of [config.storageRoot, join(config.storageRoot, 'users'), root, home, workspace, agentsHome]) {
    await privateDirectory(path)
  }
  const args = [...config.args, '--profile', 'web', '--patch', config.webPatch,
    '--host', '127.0.0.1', '--port', '0', '--no-open']
  const child: ChildProcess = spawn(config.command, args, {
    cwd: workspace,
    env: childEnvironment(home, agentsHome),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  let exited = false
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => { exited = true; resolve() })
  })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (exited) return
    if (child.connected) child.send({ kind: 'public-harness/stop' })
    else child.kill()
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, config.stopTimeoutMs)
    try { await closed } finally { clearTimeout(timer) }
  })()
  try {
    const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web startup timed out')), config.startupTimeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('error', onError)
        child.off('close', onClose)
      }
      const onMessage = (message: unknown): void => {
        try {
          const value = readyValues(message)
          if (value === undefined) return
          cleanup()
          resolve(value)
        } catch (error) { cleanup(); reject(error) }
      }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const onClose = (): void => { cleanup(); reject(new Error('Web process exited before readiness')) }
      child.on('message', onMessage)
      child.once('error', onError)
      child.once('close', onClose)
    })
    return { endpoint: { kind: 'tcp', host: '127.0.0.1', port: ready.port }, grant: ready.token, closed, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
