/** Publish the Web process's startup credential only over the supervisor IPC channel. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-cmdline'

/** One IPC message containing the bound loopback port and startup credential. */
export interface ReadyMessage { kind: 'public-harness/web-ready'; port: number; token: string }

/** The Connection method used to derive a process-owned startup credential. */
export interface AuthenticatedUrl { authenticatedUrl(baseUrl: string): string }

/** Derive a bounded, loopback-only supervisor message from Connection's authenticated URL. */
export function createReadyMessage(connection: AuthenticatedUrl, port: number): ReadyMessage {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid Web port')
  const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${port}`))
  const token = url.searchParams.getAll('token')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
    || url.pathname !== '/' || url.hash || token.length !== 1 || !token[0]
    || [...url.searchParams.keys()].some(key => key !== 'token')) {
    throw new Error('invalid authenticated Web URL')
  }
  return { kind: 'public-harness/web-ready', port, token: token[0] }
}

/** Stable Cordis plugin name. */
export const name = 'public-harness-web-token'

/** A development Web child requires both services before it can publish readiness. */
export const inject = ['connection', 'webServer']

/** Register private readiness and graceful supervisor shutdown. */
export function apply(ctx: Context): void {
  if (process.send === undefined) throw new Error('Web token publisher requires a private IPC channel')
  // The released Cordis type package omits the fiber's Context augmentation.
  const lifecycle = ctx as Context & Pick<Fiber, 'effect'>
  lifecycle.effect(() => {
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null || !('kind' in message)
        || message.kind !== 'public-harness/stop') return
      ctx.appExit?.(0)
    }
    process.on('message', onMessage)
    return () => process.off('message', onMessage)
  })
  const settled = ctx.loader?.await()
  if (settled === undefined) throw new Error('Web token publisher requires a Loader profile')
  void settled.then(() => {
    process.send?.(createReadyMessage(ctx.connection, ctx.webServer.port))
  }).catch(() => {
    // Profile boot reports its own failure and no startup credential is published.
  })
}
