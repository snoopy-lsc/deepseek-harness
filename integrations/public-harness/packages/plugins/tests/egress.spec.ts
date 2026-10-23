/** Allowlisting CONNECT egress proxy: forbidden ranges, DNS rebinding pin, IP literals, allowlist. */
import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startEgressProxy, type EgressProxy, type EgressResolve } from '../src/egress/server.ts'
import { isForbiddenAddress } from '../src/egress/ranges.ts'

const proxies: EgressProxy[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

async function listenEcho(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((socket: Socket) => {
    socket.on('data', chunk => {
      seen.push(chunk.toString('utf8'))
      socket.write(chunk)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP address')
  return { port: address.port, seen }
}

async function connectThrough(
  proxyPort: number,
  target: string,
  body = '',
): Promise<{ status: number; header: string; body: string }> {
  const socket = connect({ host: '127.0.0.1', port: proxyPort })
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      resolve()
    })
  })
  const header = await new Promise<string>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const text = buffered.toString('latin1')
      const split = text.indexOf('\r\n\r\n')
      if (split === -1) return
      socket.off('data', onData)
      socket.off('error', reject)
      const head = text.slice(0, split)
      const rest = buffered.subarray(split + 4)
      if (rest.length > 0) chunks.push(rest)
      resolve(head)
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.setTimeout(3000, () => reject(new Error('CONNECT response timeout')))
  })
  const status = Number(header.split(' ')[1])
  if (status === 200 && body.length > 0) {
    socket.write(body)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tunnel body timeout')), 3000)
      const check = () => {
        if (Buffer.concat(chunks).length >= body.length) {
          clearTimeout(timer)
          resolve()
        }
      }
      socket.on('data', chunk => { chunks.push(chunk); check() })
      check()
    })
  }
  socket.destroy()
  return { status, header, body: Buffer.concat(chunks).toString('utf8') }
}

describe('forbidden address ranges', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::1',
    '2002::1',
    '2001::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('classifies %s as forbidden', address => {
    expect(isForbiddenAddress(address)).toBe(true)
  })

  it('allows a public unicast address', () => {
    expect(isForbiddenAddress('1.1.1.1')).toBe(false)
    expect(isForbiddenAddress('2001:4860:4860::8888')).toBe(false)
  })
})

describe('egress CONNECT proxy', () => {
  it('refuses an allowlisted name whose A/AAAA set includes a forbidden address', async () => {
    const resolve: EgressResolve = async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '::ffff:127.0.0.1', family: 6 },
    ]
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: ['registry.npmjs.org'],
      intranet: {},
      fetchUidOnly: true,
      resolve,
      allowedTargetPorts: [443],
    })
    proxies.push(proxy)
    const result = await connectThrough(proxy.port, 'registry.npmjs.org:443')
    expect(result.status).toBe(403)
  })

  it.each(['64:ff9b::9', '2002::9', '::ffff:10.0.0.1'])(
    'refuses allowlisted name resolving only to forbidden %s',
    async address => {
      const resolve: EgressResolve = async () => [{ address, family: 6 }]
      const proxy = await startEgressProxy({
        listen: '127.0.0.1',
        port: 0,
        allow: ['evil.example'],
        intranet: {},
        fetchUidOnly: true,
        resolve,
      })
      proxies.push(proxy)
      expect((await connectThrough(proxy.port, 'evil.example:443')).status).toBe(403)
    },
  )

  it('refuses an IP-literal target outside intranet CIDRs', async () => {
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: [],
      intranet: { 'git.corp.example': ['10.0.0.0/8'] },
      fetchUidOnly: true,
    })
    proxies.push(proxy)
    expect((await connectThrough(proxy.port, '8.8.8.8:443')).status).toBe(403)
    expect((await connectThrough(proxy.port, '127.0.0.1:443')).status).toBe(403)
  })

  it('refuses a host that is not on allow or intranet', async () => {
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: ['registry.npmjs.org'],
      intranet: {},
      fetchUidOnly: true,
      resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    })
    proxies.push(proxy)
    expect((await connectThrough(proxy.port, 'unlisted.example:443')).status).toBe(403)
  })

  it('fails a redirect-style follow-up CONNECT to an unlisted host', async () => {
    // CONNECT has no redirects; a client that follows Location must open a new CONNECT,
    // which fails when the next host is not allowlisted.
    const echo = await listenEcho()
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: ['registry.npmjs.org'],
      intranet: {},
      fetchUidOnly: true,
      resolve: async host => host === 'registry.npmjs.org'
        ? [{ address: '1.1.1.1', family: 4 }]
        : [{ address: '9.9.9.9', family: 4 }],
      allowedTargetPorts: [echo.port, 443],
      // Dial the local echo regardless of the validated public address so the first CONNECT succeeds.
      connect: () => connect({ host: '127.0.0.1', port: echo.port }),
    })
    proxies.push(proxy)
    expect((await connectThrough(proxy.port, `registry.npmjs.org:${echo.port}`)).status).toBe(200)
    expect((await connectThrough(proxy.port, 'cdn.unlisted.example:443')).status).toBe(403)
  })

  it('pins the checked address across a DNS rebinding swap', async () => {
    const echo = await listenEcho()
    let lookups = 0
    const resolve: EgressResolve = async () => {
      lookups += 1
      if (lookups === 1) return [{ address: '127.0.0.1', family: 4 }]
      return [{ address: '8.8.8.8', family: 4 }]
    }
    const connected: string[] = []
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: [],
      intranet: { 'git.corp.example': ['127.0.0.0/8'] },
      fetchUidOnly: true,
      resolve,
      allowedTargetPorts: [echo.port],
      connect: (options) => {
        connected.push(options.host)
        // Re-resolve between check and connect would return 8.8.8.8; the proxy must not.
        void resolve('git.corp.example')
        return connect({ host: options.host, port: options.port })
      },
    })
    proxies.push(proxy)
    const result = await connectThrough(proxy.port, `git.corp.example:${echo.port}`, 'pin-check')
    expect(result.status).toBe(200)
    expect(connected).toEqual(['127.0.0.1'])
    expect(result.body).toContain('pin-check')
    expect(echo.seen.some(chunk => chunk.includes('pin-check'))).toBe(true)
    expect(lookups).toBeGreaterThan(1)
  })

  it('listens only on 127.0.0.1', async () => {
    const proxy = await startEgressProxy({
      listen: '127.0.0.1',
      port: 0,
      allow: [],
      intranet: {},
      fetchUidOnly: true,
    })
    proxies.push(proxy)
    expect(proxy.address).toBe('127.0.0.1')
  })

  it('rejects listen addresses other than 127.0.0.1', async () => {
    await expect(startEgressProxy({
      listen: '0.0.0.0' as '127.0.0.1',
      port: 0,
      allow: [],
      intranet: {},
      fetchUidOnly: true,
    })).rejects.toThrow(/127\.0\.0\.1/)
  })
})
