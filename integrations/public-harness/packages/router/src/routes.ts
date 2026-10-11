/** Exact owner-path selection before a Harness instance can receive traffic. */
import { AccountSuspendedError, CapacityError, type InstanceEndpoint, type InstanceManager, type UserId } from '@public-harness/contracts'

/** One route result consumed by the browser HTTP and upgrade handlers. */
export type OwnerRoute =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'ready'; readonly endpoint: InstanceEndpoint; readonly upstreamPath: string }
  | { readonly kind: 'starting' }
  | { readonly kind: 'rejected'; readonly status: 403 | 404 | 503; readonly reason: 'account' | 'path' | 'capacity' | 'service' }

/** Account, capacity, and startup checks required before selecting an instance. */
export interface OwnerRouterConfig {
  readonly instanceManager: InstanceManager
  readonly isActive: (userId: UserId) => Promise<boolean>
  readonly hasCapacity: (userId: UserId) => Promise<boolean>
  readonly maxWaitMs: number
}

function ownerPath(rawUrl: string, userId: UserId): string | undefined {
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || /[\\#\u0000-\u001f]/.test(rawUrl)) return undefined
  const queryIndex = rawUrl.indexOf('?')
  const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex)
  const query = queryIndex < 0 ? '' : rawUrl.slice(queryIndex)
  const segments = path.split('/')
  if (segments[1] !== 'u' || segments[2] !== userId || segments.length < 4) return undefined
  for (let index = 3; index < segments.length; index += 1) {
    const segment = segments[index]!
    let decoded: string
    try { decoded = decodeURIComponent(segment) }
    catch { return undefined }
    if (decoded === '.' || decoded === '..' || /[\/\\\u0000-\u001f]/.test(decoded)
      || (segment === '' && index !== segments.length - 1)) return undefined
  }
  return `/${segments.slice(3).join('/')}${query}`
}

async function bounded<T>(operation: Promise<T>, maxWaitMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), maxWaitMs)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Create per-user first-start joins with bounded request waiting. */
export function createOwnerRouter(config: OwnerRouterConfig): { route(rawUrl: string, userId: UserId): Promise<OwnerRoute> } {
  if (!Number.isSafeInteger(config.maxWaitMs) || config.maxWaitMs <= 0) throw new Error('router wait limit must be positive')
  const starting = new Map<UserId, Promise<InstanceEndpoint>>()
  const ensure = (userId: UserId): Promise<InstanceEndpoint> => {
    let pending = starting.get(userId)
    if (pending === undefined) {
      pending = config.instanceManager.ensure(userId)
      starting.set(userId, pending)
      void pending.finally(() => { if (starting.get(userId) === pending) starting.delete(userId) }).catch(() => {})
    }
    return pending
  }
  return {
    async route(rawUrl, userId) {
      const upstreamPath = rawUrl === '/' ? undefined : ownerPath(rawUrl, userId)
      if (rawUrl !== '/' && upstreamPath === undefined) return { kind: 'rejected', status: 404, reason: 'path' }
      try {
        const active = await bounded(config.isActive(userId), config.maxWaitMs)
        if (active === undefined) return { kind: 'rejected', status: 503, reason: 'service' }
        if (!active) return { kind: 'rejected', status: 403, reason: 'account' }
        if (rawUrl === '/') return { kind: 'redirect', location: `/u/${userId}/` }
        const capacity = await bounded(config.hasCapacity(userId), config.maxWaitMs)
        if (capacity === undefined) return { kind: 'rejected', status: 503, reason: 'service' }
        if (!capacity) return { kind: 'rejected', status: 503, reason: 'capacity' }
        const endpoint = await bounded(ensure(userId), config.maxWaitMs)
        if (endpoint === undefined) return { kind: 'starting' }
        return { kind: 'ready', endpoint, upstreamPath: upstreamPath! }
      } catch (error) {
        // The provisioner is authoritative for capacity and account state; its typed refusals map to bounded pages.
        if (error instanceof CapacityError) return { kind: 'rejected', status: 503, reason: 'capacity' }
        if (error instanceof AccountSuspendedError) return { kind: 'rejected', status: 403, reason: 'account' }
        return { kind: 'rejected', status: 503, reason: 'service' }
      }
    },
  }
}
