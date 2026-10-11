import { createHash } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUserId, type InstanceEndpoint } from '../../contracts/src/index.ts'
import { createBrowserLaunch } from '../src/launch.ts'

const alice = parseUserId('alice')
const host = 'example.test'
const name = `dsh-auth-${createHash('sha256').update(host).digest('base64url')}`
const cookie = `${name}=v1.abc.def; Max-Age=3600; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; SameSite=Strict`
const openServers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function backend(handler: RequestListener): Promise<InstanceEndpoint> {
  const server = createServer(handler)
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { kind: 'tcp', host: '127.0.0.1', port: (server.address() as AddressInfo).port }
}

describe('private Harness launch exchange', () => {
  it('exchanges the token internally and scopes the cookie to the owner path', async () => {
    const seen: string[] = []
    const endpoint = await backend((request, response) => {
      seen.push(`${request.headers.host} ${request.url}`)
      response.writeHead(303, { location: './', 'set-cookie': cookie }).end()
    })
    const launchGrant = vi.fn(async () => 'private-token')
    const launch = createBrowserLaunch({ instanceManager: { ensure: async () => endpoint, launchGrant, async stop() {} },
      maxExchangeMs: 1000 })
    const result = await launch.open(alice, endpoint, host, true)
    expect(seen).toEqual(['example.test /?token=private-token'])
    expect(result).toEqual({ location: '/u/alice/', setCookie: cookie.replace('Path=/', 'Path=/u/alice/') + '; Secure' })
    expect(JSON.stringify(result)).not.toContain('private-token')
  })

  it('retries once with a new grant after the first process rejects a stale token', async () => {
    let requests = 0
    const endpoint = await backend((_request, response) => {
      requests += 1
      if (requests === 1) response.writeHead(401).end()
      else response.writeHead(303, { location: './', 'set-cookie': cookie }).end()
    })
    const launchGrant = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new')
    const ensure = vi.fn(async () => endpoint)
    const launch = createBrowserLaunch({ instanceManager: { ensure, launchGrant, async stop() {} }, maxExchangeMs: 1000 })
    expect((await launch.open(alice, endpoint, host, false)).setCookie).not.toContain('Secure')
    expect(launchGrant).toHaveBeenCalledTimes(2)
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it.each([
    [200, cookie], [303, 'other=abc; Path=/; HttpOnly; SameSite=Strict'],
    [303, `${cookie}; Domain=example.test`], [303, `${cookie}; Secure`],
  ])('rejects an unexpected exchange response', async (status, setCookie) => {
    const endpoint = await backend((_request, response) => response.writeHead(status, { location: './', 'set-cookie': setCookie }).end())
    const launch = createBrowserLaunch({ instanceManager: { ensure: async () => endpoint,
      launchGrant: async () => 'private-token', async stop() {} }, maxExchangeMs: 1000 })
    await expect(launch.open(alice, endpoint, host, true)).rejects.toThrow()
  })
})
