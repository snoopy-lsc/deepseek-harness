import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { authenticatedWebProbe } from '../src/systemd-runtime.ts'

describe('native authenticated readiness probe', () => {
  it('accepts only the grant exchange the router performs', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/?token=good') { res.writeHead(303, { location: './', 'set-cookie': 'harness=1; HttpOnly' }); res.end(); return }
      res.writeHead(req.url?.startsWith('/?token=') ? 401 : 200); res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      expect(await authenticatedWebProbe(port, 'good')).toBe(true)
      expect(await authenticatedWebProbe(port, 'stale')).toBe(false)
    } finally { server.close() }
    // Nothing listening is not ready either.
    expect(await authenticatedWebProbe(port, 'good', 500)).toBe(false)
  })
})
