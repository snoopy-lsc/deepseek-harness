import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, parseUserId } from '@public-harness/contracts'
import { AdminClient, startAdminServer } from '../src/admin.ts'
import { startUnixForwarder } from '../src/forwarder.ts'
import { ProvisionerClient, startProvisionerServer } from '../src/protocol.ts'
import { gid } from './helpers.ts'

const alice = parseUserId('alice')
async function privateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wire-'))
  await chmod(dir, 0o700)
  return dir
}

describe.skipIf(process.platform === 'win32')('provisioner wire behavior', () => {
  it('carries only typed capacity and suspension refusals, hiding every other failure', async () => {
    const path = join(await privateDir(), 'p.sock')
    let mode: 'capacity' | 'suspended' | 'other' = 'capacity'
    const server = await startProvisionerServer(path, async () => {
      if (mode === 'capacity') throw new CapacityError()
      if (mode === 'suspended') throw new AccountSuspendedError()
      throw new Error('/var/lib/dsh/users/secret path and token abc')
    })
    try {
      const client = new ProvisionerClient(path)
      await expect(client.ensure(alice)).rejects.toBeInstanceOf(CapacityError)
      mode = 'suspended'
      await expect(client.ensure(alice)).rejects.toBeInstanceOf(AccountSuspendedError)
      mode = 'other'
      await expect(client.ensure(alice)).rejects.toThrow(/^request failed$/)
    } finally { await server.close() }
  })

  it('grants the router group access to a 0660 socket in a group-traversable directory only', async () => {
    const dir = await privateDir()
    await chmod(dir, 0o750)
    const path = join(dir, 'p.sock')
    const server = await startProvisionerServer(path, async () => null, { gid })
    try { expect((await stat(path)).mode & 0o777).toBe(0o660) } finally { await server.close() }
    await chmod(dir, 0o770)
    await expect(startProvisionerServer(join(dir, 'q.sock'), async () => null, { gid })).rejects.toThrow(/owner-only/)
    await chmod(dir, 0o755)
    await expect(startProvisionerServer(join(dir, 'r.sock'), async () => null)).rejects.toThrow(/owner-only/)
  })

  it('serves the administrative operations on a separate fixed protocol', async () => {
    const path = join(await privateDir(), 'a.sock')
    const seen: string[] = []
    const lifecycle = { suspend: async (u: string) => { seen.push(`suspend:${u}`) }, reactivate: async () => {}, requestDeletion: async () => {},
      confirmDeletion: async () => {}, deleteUser: async () => {}, reconcile: async () => ({ restored: 0 }), idleStop: async () => [] } as never
    const server = await startAdminServer(path, lifecycle)
    try {
      const client = new AdminClient(path)
      await client.userOperation('suspend', alice)
      expect(seen).toEqual(['suspend:alice'])
      await expect(client.requestRaw({ op: 'ensure', userId: 'alice' })).rejects.toThrow('invalid request')
      await expect(client.requestRaw({ op: 'suspend', userId: '../x' })).rejects.toThrow()
      await expect(client.requestRaw({ op: 'suspend', userId: 'alice', path: '/etc' })).rejects.toThrow()
      expect(await client.reconcile()).toEqual({ restored: 0 })
    } finally { await server.close() }
  })

  it('forwards a restricted Unix socket to its loopback target and revokes it on close', async () => {
    const target = createServer(socket => socket.end('pong'))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    const port = (target.address() as { port: number }).port
    const dir = await privateDir()
    const path = join(dir, 'i.sock')
    const forwarder = await startUnixForwarder({ socketPath: path, port, gid })
    expect((await stat(path)).mode & 0o777).toBe(0o660)
    const data = await new Promise<string>(resolve => { let text = ''; connect(path).on('data', c => { text += c }).on('close', () => resolve(text)) })
    expect(data).toBe('pong')
    await forwarder.close()
    await expect(stat(path)).rejects.toThrow()
    target.close()
  })

  it('refuses to replace a non-socket path', async () => {
    const dir = await privateDir()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'f.sock'), 'x')
    await expect(startUnixForwarder({ socketPath: join(dir, 'f.sock'), port: 1234, gid })).rejects.toThrow(/non-socket/)
  })
})
