/** Better Auth sessions verified on every request and upgrade through the identity service's private Unix socket. */
import type { IncomingHttpHeaders } from 'node:http'
import { request } from 'node:http'
import type { UserId } from '@public-harness/contracts'
import { parseSessionLookup, SESSION_PATH } from '@public-harness/identity/session-wire'
import { IdentityUnavailableError, type IdentityVerifier } from './config.ts'

/** Session cookie names the identity service issues; only these are sent to it, and the router strips them before forwarding. */
export const NATIVE_SESSION_COOKIES = ['dsh-account.session_token', '__Secure-dsh-account.session_token'] as const

/** Native identity lookup settings. */
export interface NativeIdentityOptions {
  readonly socketPath: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  /** Provisioner status: a suspended or deleted account is denied even with a live session. */
  readonly isActive: (userId: UserId) => Promise<boolean>
}

/** Keep only identity session cookies, so instance or development cookies never reach the identity service.
 * @param header Raw Cookie header.
 * @returns `name=value` pairs joined for the lookup, or undefined when none is present.
 */
export function sessionCookies(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const pairs = header.split(';').map(part => part.trim()).filter(part => NATIVE_SESSION_COOKIES.some(name => part.startsWith(`${name}=`)))
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/** Create the Better Auth verifier. No positive result is cached: an outage or timeout always denies.
 * @param options Socket, bounds and account status.
 * @returns Verifier; invalid sessions reject with a plain error (401), lookup failures with `IdentityUnavailableError` (503).
 */
export function createNativeIdentity(options: NativeIdentityOptions): IdentityVerifier {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
    throw new Error('invalid native identity bounds')
  }
  const lookup = (cookie: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = JSON.stringify({ cookie })
    const req = request({ socketPath: options.socketPath, method: 'POST', path: SESSION_PATH, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > options.maxResponseBytes) { req.destroy(new Error('response too large')); return } chunks.push(chunk) })
      res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.once('error', reject)
    })
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error('identity lookup timed out')))
    req.once('error', reject)
    req.end(payload)
  })
  return {
    async verify(headers: IncomingHttpHeaders) {
      const cookie = sessionCookies(headers.cookie)
      if (cookie === undefined) throw new Error('no session')
      let reply
      try { reply = await lookup(cookie) } catch (cause) { throw new IdentityUnavailableError('identity lookup failed', { cause }) }
      if (reply.status === 401 || reply.status === 400) throw new Error('invalid session')
      if (reply.status !== 200) throw new IdentityUnavailableError('identity service unavailable')
      let session
      try { session = parseSessionLookup(JSON.parse(reply.body)) } catch (cause) { throw new IdentityUnavailableError('invalid identity response', { cause }) }
      let active: boolean
      try { active = await options.isActive(session.userId) } catch (cause) { throw new IdentityUnavailableError('account status unavailable', { cause }) }
      if (!active) throw new Error('inactive account')
      return session.userId
    },
  }
}
