/** Private supervisor channel for the Web launch token: a 0600 file in a directory only the instance and host root can reach. */
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** File name inside the per-account control directory. */
export const READY_FILE = 'ready.json'
const MAX_BYTES = 8192

/** The published readiness message; the token is never logged or returned by `toString`. */
export interface ReadyToken { readonly port: number; readonly token: string }

/** Parse the plugin's strict readiness message. */
export function parseReady(text: string): ReadyToken {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('invalid readiness file') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid readiness file')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'kind,port,token' || record.kind !== 'public-harness/web-ready'
    || typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.token !== 'string' || !record.token || record.token.length > 4096) throw new Error('invalid readiness file')
  return { port: record.port, token: record.token }
}

/** Read the readiness file without following links, requiring a private regular file owned by the account. */
export async function readReady(ctlDir: string, uid: number): Promise<ReadyToken | undefined> {
  let handle
  try { handle = await open(join(ctlDir, READY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    throw new Error('readiness file is not readable')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) {
      throw new Error('readiness file is not a private regular file')
    }
    return parseReady(await handle.readFile('utf8'))
  } finally { await handle.close() }
}

/** Remove a stale readiness file so a previous run's token cannot be mistaken for the new one. */
export async function clearReady(ctlDir: string): Promise<void> {
  await unlink(join(ctlDir, READY_FILE)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
}

/** Wait until the instance publishes readiness, or fail without revealing any file content. */
export async function waitForReady(ctlDir: string, uid: number, timeoutMs: number, pollMs = 100,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  clock: () => number = Date.now): Promise<ReadyToken> {
  const deadline = clock() + timeoutMs
  for (;;) {
    const ready = await readReady(ctlDir, uid)
    if (ready !== undefined) return ready
    if (clock() >= deadline) throw new Error('readiness timed out')
    await sleep(pollMs)
  }
}
