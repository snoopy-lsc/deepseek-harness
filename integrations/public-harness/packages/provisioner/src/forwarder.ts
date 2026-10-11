/** Host-side forwarder: one private Unix socket per instance, bridged to that instance's published loopback port. */
import { chmod, chown, lstat, unlink } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'

/** A running forwarder; closing it revokes the router-facing socket. */
export interface Forwarder { close(): Promise<void> }

/** Remove only a stale socket at the path, never any other file type. */
export async function removeStaleSocket(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => undefined)
  if (entry === undefined) return
  if (!entry.isSocket()) throw new Error('refusing to replace a non-socket path')
  await unlink(path)
}

/** Listen on `socketPath` (0660, group `gid`) and pipe every connection to 127.0.0.1:`port`. */
export async function startUnixForwarder(options: { socketPath: string; port: number; gid: number }): Promise<Forwarder> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid forward port')
  await removeStaleSocket(options.socketPath)
  const sockets = new Set<Socket>()
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: options.port })
    sockets.add(client); sockets.add(upstream)
    const done = (): void => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream) }
    client.once('close', done); upstream.once('close', done)
    client.on('error', done); upstream.on('error', done)
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => { server.off('error', reject); resolve() })
  })
  try {
    await chown(options.socketPath, process.getuid!(), options.gid)
    await chmod(options.socketPath, 0o660)
  } catch (error) { server.close(); throw error }
  return {
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await removeStaleSocket(options.socketPath).catch(() => {})
    },
  }
}
