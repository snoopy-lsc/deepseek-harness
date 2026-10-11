/** In-container forwarding sidecar: the Web CLI binds loopback inside its own network namespace, so a sidecar relays published traffic to it. */
import { connect, createServer, type Server, type Socket } from 'node:net'

/** Relay every connection on `listenHost:listenPort` to `127.0.0.1:targetPort`. */
export async function startSidecar(options: { listenHost: string; listenPort: number; targetPort: number }): Promise<Server> {
  const sockets = new Set<Socket>()
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: options.targetPort })
    sockets.add(client); sockets.add(upstream)
    const done = (): void => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream) }
    client.once('close', done); upstream.once('close', done)
    client.on('error', done); upstream.on('error', done)
    client.pipe(upstream).pipe(client)
  })
  server.once('close', () => { for (const socket of sockets) socket.destroy() })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listenPort, options.listenHost, () => { server.off('error', reject); resolve() })
  })
  return server
}
