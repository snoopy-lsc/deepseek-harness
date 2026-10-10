/** Fixed, bounded Unix-socket protocol for the Linux provisioner. */
import { chmod, lstat, stat, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { InstanceEndpoint, UserId } from '@public-harness/contracts'
import { parseInstanceEndpoint, parseUserId } from '@public-harness/contracts'

const MAX_MESSAGE_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 10_000
const OPERATIONS = ['ensure', 'launch-grant', 'stop', 'status'] as const

/** Only these operations can cross the router-to-provisioner socket. */
export type ProvisionerRequest = { op: typeof OPERATIONS[number]; userId: UserId }

/** The provisioner owns the operation and returns its result. */
export type ProvisionerHandler = (request: ProvisionerRequest) => Promise<InstanceEndpoint | string | null>

function parseRequest(value: unknown): ProvisionerRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid request')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'op,userId' || typeof record.op !== 'string'
    || !OPERATIONS.some(op => op === record.op) || typeof record.userId !== 'string') {
    throw new Error('invalid request')
  }
  return { op: record.op as ProvisionerRequest['op'], userId: parseUserId(record.userId) }
}

function readLine(socket: Socket): Promise<unknown> {
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

function sendLine(socket: Socket, value: unknown): void {
  const data = Buffer.from(`${JSON.stringify(value)}\n`)
  if (data.byteLength > MAX_MESSAGE_BYTES) throw new Error('response too large')
  socket.end(data)
}

/** Start one private control socket. Its parent directory must be owner-only. */
export async function startProvisionerServer(path: string, handler: ProvisionerHandler): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('Unix provisioner sockets require Linux or macOS')
  const parent = await stat(dirname(path))
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('control socket requires an owner-only private directory')
  }
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    void (async () => {
      try {
        const request = parseRequest(await readLine(socket))
        const result = await handler(request)
        sendLine(socket, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error && /^(invalid request|invalid user ID|message too large|response too large)$/.test(error.message)
          ? error.message : 'request failed'
        try { sendLine(socket, { ok: false, error: message }) }
        catch { socket.destroy() }
      }
    })()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
    await chmod(path, 0o600)
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

/** Client for the four provisioner operations. */
export class ProvisionerClient {
  constructor(readonly path: string) {}

  /** Send one raw request; the server still rejects unknown fields and tags. */
  async requestRaw(request: unknown): Promise<unknown> {
    const encoded = Buffer.from(`${JSON.stringify(request)}\n`)
    if (encoded.byteLength > MAX_MESSAGE_BYTES) throw new Error('request too large')
    const socket = createConnection(this.path)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.write(encoded)
      const response = await readLine(socket)
      if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error('invalid response')
      const record = response as Record<string, unknown>
      if (record.ok === false && typeof record.error === 'string') throw new Error(record.error)
      if (record.ok !== true || !Object.hasOwn(record, 'result')) throw new Error('invalid response')
      return record.result
    } finally {
      socket.destroy()
    }
  }

  /** Ensure one user runtime exists and return its private address. */
  async ensure(userId: UserId): Promise<InstanceEndpoint> {
    return parseInstanceEndpoint(await this.requestRaw({ op: 'ensure', userId }))
  }

  /** Fetch the current one-use Web launch grant without logging it. */
  async launchGrant(userId: UserId): Promise<string> {
    const result = await this.requestRaw({ op: 'launch-grant', userId })
    if (typeof result !== 'string' || !result) throw new Error('invalid launch grant')
    return result
  }

  /** Stop a user's runtime while retaining its stored data. */
  async stop(userId: UserId): Promise<void> {
    if (await this.requestRaw({ op: 'stop', userId }) !== null) throw new Error('invalid stop response')
  }

  /** Read the user's runtime status. */
  async status(userId: UserId): Promise<string> {
    const result = await this.requestRaw({ op: 'status', userId })
    if (typeof result !== 'string') throw new Error('invalid status response')
    return result
  }
}
