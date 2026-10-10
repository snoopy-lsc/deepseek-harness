import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { ProvisionerClient, startProvisionerServer } from '../src/protocol.ts'

describe.skipIf(process.platform === 'win32')('fixed provisioner protocol', () => {
  it('round trips allowed operations over a private socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
    await chmod(dir, 0o700)
    const path = join(dir, 'control.sock')
    const server = await startProvisionerServer(path, async request => {
      if (request.op === 'ensure') return { kind: 'tcp', host: '127.0.0.1', port: 4123 }
      if (request.op === 'launch-grant') return 'private-grant'
      if (request.op === 'status') return 'ready'
      return null
    })
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const client = new ProvisionerClient(path)
      expect(await client.ensure(parseUserId('alice'))).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 4123 })
      expect(await client.launchGrant(parseUserId('alice'))).toBe('private-grant')
      expect(await client.status(parseUserId('alice'))).toBe('ready')
      await expect(client.stop(parseUserId('alice'))).resolves.toBeUndefined()
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown fields and operations before invoking the handler', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
    const path = join(dir, 'control.sock')
    let invoked = 0
    const server = await startProvisionerServer(path, async () => { invoked++; return null })
    try {
      const client = new ProvisionerClient(path)
      await expect(client.requestRaw({ op: 'ensure', userId: 'alice', path: '/etc' })).rejects.toThrow()
      await expect(client.requestRaw({ op: 'delete', userId: 'alice' })).rejects.toThrow()
      expect(invoked).toBe(0)
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an oversized response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
    const path = join(dir, 'control.sock')
    const server = await startProvisionerServer(path, async () => 'x'.repeat(70_000))
    try {
      await expect(new ProvisionerClient(path).status(parseUserId('alice'))).rejects.toThrow(/large|size/i)
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a control socket under a group-readable directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
    await chmod(dir, 0o750)
    const started = startProvisionerServer(join(dir, 'control.sock'), async () => null)
    try {
      await expect(started).rejects.toThrow(/private|owner/i)
    } finally {
      await (await started.catch(() => undefined))?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
