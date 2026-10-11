/** Private launch-token exchange against a user's Harness Web instance. */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { InstanceEndpoint, InstanceManager, UserId } from '@public-harness/contracts'
import { scopeHarnessCookie } from './cookies.ts'

/** Bounded private exchange using the instance manager's current launch grant. */
export interface BrowserLaunchConfig {
  readonly instanceManager: InstanceManager
  readonly maxExchangeMs: number
}

interface Exchange { readonly status: number; readonly headers: IncomingHttpHeaders }

function exchange(endpoint: InstanceEndpoint, authority: string, grant: string, timeoutMs: number): Promise<Exchange> {
  if (!grant || grant.length > 4096) throw new Error('invalid private launch grant')
  return new Promise((resolve, reject) => {
    const request = httpRequest({ ...endpoint.kind === 'unix'
      ? { socketPath: endpoint.path } : { host: endpoint.host, port: endpoint.port },
      method: 'GET', path: `/?token=${encodeURIComponent(grant)}`,
      headers: { host: authority }, agent: false }, response => {
      response.resume()
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
      response.once('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('private launch exchange timed out')))
    request.once('error', reject)
    request.end()
  })
}

/** Create server-side cookie exchange with one retry after a stale grant. */
export function createBrowserLaunch(config: BrowserLaunchConfig): {
  open(userId: UserId, endpoint: InstanceEndpoint, authority: string, secure: boolean): Promise<{
    readonly location: string; readonly setCookie: string
  }>
} {
  if (!Number.isSafeInteger(config.maxExchangeMs) || config.maxExchangeMs <= 0) {
    throw new Error('launch exchange timeout must be positive')
  }
  return {
    async open(userId, endpoint, authority, secure) {
      let current = endpoint
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt === 1) current = await config.instanceManager.ensure(userId)
        const grant = await config.instanceManager.launchGrant(userId)
        let result: Exchange
        try { result = await exchange(current, authority, grant, config.maxExchangeMs) }
        catch (error) {
          if (attempt === 0) continue
          throw new Error('private Harness launch exchange unavailable', { cause: error })
        }
        if (result.status === 401 && attempt === 0) continue
        const cookies = result.headers['set-cookie']
        if (result.status !== 303 || result.headers.location !== './' || cookies?.length !== 1) {
          throw new Error('unexpected private Harness launch response')
        }
        return { location: `/u/${userId}/`, setCookie: scopeHarnessCookie(cookies[0]!, userId, authority, secure) }
      }
      throw new Error('private Harness launch grant rejected')
    },
  }
}
