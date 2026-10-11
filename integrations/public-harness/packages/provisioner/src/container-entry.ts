/** Container entrypoint: starts the sidecar and the one allowed Harness profile (`dsh --profile web`). */
import { spawn } from 'node:child_process'
import { startSidecar } from './sidecar.ts'

function port(name: string): number {
  const value = Number(process.env[name])
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is required`)
  return value
}

const webPort = port('PUBLIC_HARNESS_WEB_PORT')
const sidecarPort = port('PUBLIC_HARNESS_SIDECAR_PORT')
const patch = process.env.PUBLIC_HARNESS_WEB_PATCH
if (!patch) throw new Error('PUBLIC_HARNESS_WEB_PATCH is required')

// The wildcard address is confined to this container's private network namespace; the host publishes
// the port on 127.0.0.1 only, and the provisioner then relays it to a permission-restricted Unix socket.
const sidecar = await startSidecar({ listenHost: process.env.PUBLIC_HARNESS_SIDECAR_HOST ?? '0.0.0.0', listenPort: sidecarPort, targetPort: webPort })
const child = spawn('dsh', ['--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(webPort), '--no-open'],
  { stdio: ['ignore', 'inherit', 'inherit'] })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
child.once('exit', code => { sidecar.close(); process.exit(code ?? 1) })
child.once('error', () => { sidecar.close(); process.exit(1) })
