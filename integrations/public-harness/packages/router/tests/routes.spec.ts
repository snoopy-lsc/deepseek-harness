import { describe, expect, it, vi } from 'vitest'
import { parseUserId, type InstanceEndpoint } from '../../contracts/src/index.ts'
import { createOwnerRouter } from '../src/routes.ts'

const alice = parseUserId('alice')
const endpoint: InstanceEndpoint = { kind: 'tcp', host: '127.0.0.1', port: 4321 }
const setup = () => {
  const ensure = vi.fn(async (): Promise<InstanceEndpoint> => endpoint)
  const isActive = vi.fn(async () => true)
  const hasCapacity = vi.fn(async () => true)
  const router = createOwnerRouter({ instanceManager: { ensure, async launchGrant() { return '' }, async stop() {} },
    isActive, hasCapacity, maxWaitMs: 100 })
  return { router, ensure, isActive, hasCapacity }
}

describe('owner-only instance routing', () => {
  it('redirects root and strips only the exact signed-in owner prefix', async () => {
    const { router, ensure } = setup()
    expect(await router.route('/', alice)).toEqual({ kind: 'redirect', location: '/u/alice/' })
    expect(await router.route('/u/alice/api/list?limit=2', alice)).toEqual({ kind: 'ready',
      endpoint, upstreamPath: '/api/list?limit=2' })
    expect(ensure).toHaveBeenCalledExactlyOnceWith(alice)
  })

  it.each(['/u/bob/', '/u/alice2/', '/u/alice', '/unknown', '/u/%61lice/',
    '/u/alice/%2fadmin', '/u/alice/%5cadmin', '/u/alice/%2e%2e/bob',
    '/u/alice/../bob', '/u/alice/./api', '/u/alice//api', '/u/alice//', '//u/alice/',
    '/u/alice/%00', '/u/alice/%ZZ'])('rejects an unsafe or cross-user path: %s', async path => {
    const { router, ensure } = setup()
    expect(await router.route(path, alice)).toEqual({ kind: 'rejected', status: 404, reason: 'path' })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('checks suspension and capacity before starting an instance', async () => {
    const { router, ensure, isActive, hasCapacity } = setup()
    isActive.mockResolvedValueOnce(false)
    expect(await router.route('/u/alice/', alice)).toEqual({ kind: 'rejected', status: 403, reason: 'account' })
    hasCapacity.mockResolvedValueOnce(false)
    expect(await router.route('/u/alice/', alice)).toEqual({ kind: 'rejected', status: 503, reason: 'capacity' })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('joins simultaneous startup for one user', async () => {
    const { router, ensure } = setup()
    const [first, second] = await Promise.all([router.route('/u/alice/', alice), router.route('/u/alice/api', alice)])
    expect(first.kind).toBe('ready')
    expect(second.kind).toBe('ready')
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('returns a bounded starting state while the instance is unavailable', async () => {
    const { router } = setup()
    const slow = createOwnerRouter({ instanceManager: { ensure: () => new Promise<InstanceEndpoint>(() => {}),
      async launchGrant() { return '' }, async stop() {} },
      isActive: async () => true, hasCapacity: async () => true, maxWaitMs: 10 })
    expect(await slow.route('/u/alice/', alice)).toEqual({ kind: 'starting' })
    expect(await router.route('/u/alice/', alice)).toMatchObject({ kind: 'ready' })
  })

  it('joins a slow start across requests and starts it again only after it failed', async () => {
    const { router, ensure } = setup()
    let finish!: (value: InstanceEndpoint) => void
    let fail!: (error: Error) => void
    ensure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    expect(await router.route('/u/alice/', alice)).toEqual({ kind: 'starting' })
    expect(await router.route('/u/alice/', alice)).toEqual({ kind: 'starting' })
    expect(ensure).toHaveBeenCalledTimes(1)
    finish(endpoint)
    expect(await router.route('/u/alice/', alice)).toMatchObject({ kind: 'ready', endpoint })
    // A provisioner request that gives up (for example the client's ensure timeout) is a service error, not a hang,
    // and the next request asks again; the provisioner joins that ask to the start it still has in flight.
    ensure.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    const waiting = router.route('/u/alice/', alice)
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
    fail(new Error('request timed out'))
    expect(await waiting).toEqual({ kind: 'rejected', status: 503, reason: 'service' })
    expect(await router.route('/u/alice/', alice)).toMatchObject({ kind: 'ready' })
    expect(ensure).toHaveBeenCalledTimes(4)
  })
})
