/** HTTP CONNECT allowlisting egress proxy for dsh-plugins-fetch. */
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { Transform } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { evaluateConnectTarget, type EgressPolicyOptions, type EgressResolve } from './policy.ts'

export type { EgressResolve } from './policy.ts'

export interface EgressConnectOptions {
  readonly host: string
  readonly port: number
  readonly family: 4 | 6
}

export interface EgressProxyOptions extends EgressPolicyOptions {
  /** Must be loopback only. */
  readonly listen: '127.0.0.1'
  readonly port: number
  /** Declares that only the fetch UID may reach this listener; enforcement is the host firewall (1B). */
  readonly fetchUidOnly: boolean
  /** Inject dial for tests; production uses `net.connect` to the validated address. */
  readonly connect?: (options: EgressConnectOptions) => Socket | Promise<Socket>
  readonly log?: (entry: EgressLogEntry) => void
}

export interface EgressLogEntry {
  readonly requestId: string
  readonly host: string
  readonly address: string
  readonly port: number
  readonly bytesUp: number
  readonly bytesDown: number
  readonly outcome: 'ok' | 'refused' | 'error'
  readonly reason?: string
}

export interface EgressProxy {
  readonly address: '127.0.0.1'
  readonly port: number
  close(): Promise<void>
}

function requestId(): string {
  return randomBytes(8).toString('hex')
}

function writeHead(socket: Socket, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
}

async function readConnectHead(socket: Socket): Promise<{ method: string; target: string } | undefined> {
  const chunks: Buffer[] = []
  return await new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      const buffered = Buffer.concat(chunks)
      if (buffered.length > 16_384) {
        cleanup()
        resolve(undefined)
        return
      }
      const text = buffered.toString('latin1')
      const split = text.indexOf('\r\n\r\n')
      if (split === -1) return
      cleanup()
      const leftover = buffered.subarray(split + 4)
      if (leftover.length > 0) socket.unshift(leftover)
      const first = text.slice(0, split).split('\r\n')[0] ?? ''
      const parts = first.split(' ')
      if (parts.length < 2) {
        resolve(undefined)
        return
      }
      resolve({ method: parts[0]!.toUpperCase(), target: parts[1]! })
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); resolve(undefined) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

async function waitConnected(socket: Socket): Promise<void> {
  if (!socket.connecting) return
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
}

/**
 * Start the allowlisting CONNECT proxy on `127.0.0.1`. It resolves each name once, refuses any
 * forbidden A/AAAA record, and dials only the address it validated so DNS rebinding cannot swap the target.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  if (options.listen !== '127.0.0.1') throw new Error('dsh-plugins-egress must listen on 127.0.0.1')
  if (!options.fetchUidOnly) throw new Error('dsh-plugins-egress requires fetchUidOnly')

  const dial = options.connect ?? ((opts: EgressConnectOptions) => netConnect({ host: opts.host, port: opts.port, family: opts.family }))
  const log = options.log ?? (() => {})

  const server: Server = createServer({ allowHalfOpen: false }, socket => {
    void handleClient(socket)
  })

  async function handleClient(client: Socket): Promise<void> {
    const id = requestId()
    let bytesUp = 0
    let bytesDown = 0
    let finished = false
    const finish = (entry: Omit<EgressLogEntry, 'requestId' | 'bytesUp' | 'bytesDown'> & Partial<Pick<EgressLogEntry, 'bytesUp' | 'bytesDown'>>) => {
      if (finished) return
      finished = true
      log({ requestId: id, bytesUp, bytesDown, ...entry })
    }
    try {
      const head = await readConnectHead(client)
      if (head === undefined) {
        writeHead(client, 400, 'Bad Request')
        client.end()
        finish({ host: '', address: '', port: 0, outcome: 'refused', reason: 'bad-request' })
        return
      }
      if (head.method !== 'CONNECT') {
        writeHead(client, 405, 'Method Not Allowed')
        client.end()
        finish({ host: head.target, address: '', port: 0, outcome: 'refused', reason: 'method' })
        return
      }
      const decision = await evaluateConnectTarget(head.target, options)
      if (!decision.ok) {
        writeHead(client, 403, 'Forbidden')
        client.end()
        finish({ host: head.target, address: '', port: 0, outcome: 'refused', reason: decision.reason })
        return
      }
      let upstream: Socket
      try {
        upstream = await dial({ host: decision.address, port: decision.port, family: decision.family })
        await waitConnected(upstream)
      } catch (error) {
        writeHead(client, 502, 'Bad Gateway')
        client.end()
        finish({
          host: decision.host, address: decision.address, port: decision.port, outcome: 'error',
          reason: error instanceof Error ? error.message : 'dial-failed',
        })
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const upCounter = new Transform({
        transform(chunk, _enc, cb) { bytesUp += chunk.length; cb(null, chunk) },
      })
      const downCounter = new Transform({
        transform(chunk, _enc, cb) { bytesDown += chunk.length; cb(null, chunk) },
      })
      client.pipe(upCounter).pipe(upstream)
      upstream.pipe(downCounter).pipe(client)
      client.on('error', () => { upstream.destroy(); finish({ host: decision.host, address: decision.address, port: decision.port, outcome: 'error', reason: 'client' }) })
      upstream.on('error', () => { client.destroy(); finish({ host: decision.host, address: decision.address, port: decision.port, outcome: 'error', reason: 'upstream' }) })
      client.on('close', () => {
        upstream.destroy()
        finish({ host: decision.host, address: decision.address, port: decision.port, outcome: 'ok' })
      })
      upstream.on('close', () => { client.destroy() })
    } catch (error) {
      try { writeHead(client, 500, 'Internal Server Error') } catch { /* ignore */ }
      client.destroy()
      finish({
        host: '', address: '', port: 0, outcome: 'error',
        reason: error instanceof Error ? error.message : 'handler',
      })
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.listen, () => resolve())
  })
  const bound = server.address()
  if (bound === null || typeof bound === 'string') {
    server.close()
    throw new Error('egress proxy failed to bind a TCP port')
  }

  return {
    address: '127.0.0.1',
    port: bound.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
