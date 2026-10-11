/** Bounded, line-framed JSON over private Unix sockets, shared by every control channel. */
import { chmod, chown, lstat, stat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { fromWireError, toWireError } from './errors.ts'

/** Largest request or response, in bytes. */
export const MAX_MESSAGE_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 10_000

/** Read exactly one newline-terminated JSON message. */
export function readLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0)
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('timeout', onTimeout)
    }
    const fail = (error: Error): void => { cleanup(); reject(error); socket.destroy() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onEnd = (): void => fail(new Error('incomplete message'))
    const onTimeout = (): void => fail(new Error('request timed out'))
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      if (pending.byteLength > MAX_MESSAGE_BYTES) return fail(new Error('message too large'))
      const newline = pending.indexOf(10)
      if (newline < 0) return
      if (newline !== pending.length - 1) return fail(new Error('multiple messages'))
      cleanup()
      try { resolve(JSON.parse(pending.subarray(0, newline).toString('utf8'))) }
      catch { reject(new Error('invalid JSON')) }
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('timeout', onTimeout)
    socket.setTimeout(REQUEST_TIMEOUT_MS)
  })
}

/** Write one JSON message and end the socket. */
export function sendLine(socket: Socket, value: unknown): void {
  const data = Buffer.from(`${JSON.stringify(value)}\n`)
  if (data.byteLength > MAX_MESSAGE_BYTES) throw new Error('response too large')
  socket.end(data)
}

/** Who besides the owner may connect: one dedicated group, never other users. */
export interface SocketAccess { readonly gid: number }

/** Start one private line-framed control socket. Its parent directory must be owner-only (or owner plus one group). */
export async function startLineServer(path: string, handle: (raw: unknown) => Promise<unknown>,
  access?: SocketAccess): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('Unix control sockets require Linux or macOS')
  const parent = await stat(dirname(path))
  const forbidden = access === undefined ? 0o077 : 0o027
  if (!parent.isDirectory() || (parent.mode & forbidden) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('control socket requires an owner-only private directory')
  }
  if (access !== undefined && (!Number.isSafeInteger(access.gid) || access.gid < 0)) throw new Error('invalid socket group')
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    void (async () => {
      try {
        sendLine(socket, { ok: true, result: await handle(await readLine(socket)) })
      } catch (error) {
        try { sendLine(socket, { ok: false, error: toWireError(error) }) }
        catch { socket.destroy() }
      }
    })()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
    if (access !== undefined) { await chown(path, process.getuid!(), access.gid); await chmod(path, 0o660) }
    else await chmod(path, 0o600)
  } catch (error) {
    server.close()
    throw error
  }
  return {
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      const entry = await lstat(path).catch(() => undefined)
      if (entry?.isSocket()) await unlink(path)
    },
  }
}

/** Send one request over a Unix socket and return the `result` field, throwing typed errors for failures. */
export async function requestLine(path: string, request: unknown): Promise<unknown> {
  const encoded = Buffer.from(`${JSON.stringify(request)}\n`)
  if (encoded.byteLength > MAX_MESSAGE_BYTES) throw new Error('request too large')
  const socket = createConnection(path)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(encoded)
    const response = await readLine(socket)
    if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error('invalid response')
    const record = response as Record<string, unknown>
    if (record.ok === false && typeof record.error === 'string') throw fromWireError(record.error)
    if (record.ok !== true || !Object.hasOwn(record, 'result')) throw new Error('invalid response')
    return record.result
  } finally {
    socket.destroy()
  }
}
