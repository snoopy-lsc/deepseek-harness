import { chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountSuspendedError, CapacityError, parseUserId } from '@public-harness/contracts'
import { startProvisionerServer } from '@public-harness/provisioner'
import { connectProvisioner, createAccountStatusLookup } from '../src/index.ts'

const alice = parseUserId('alice')

describe.skipIf(process.platform === 'win32')('Linux instance manager provider', () => {
  it('maps the InstanceManager service onto the four fixed provisioner operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pc-'))
    await chmod(dir, 0o700)
    const path = join(dir, 'p.sock')
    const seen: string[] = []
    let status = 'running'
    const server = await startProvisionerServer(path, async request => {
      seen.push(request.op)
      if (request.op === 'ensure') return { kind: 'unix', path: '/run/dsh/instances/a.sock' }
      if (request.op === 'launch-grant') return 'grant'
      if (request.op === 'status') return status
      return null
    })
    try {
      const { manager, isActive } = connectProvisioner(path)
      expect(await manager.ensure(alice)).toEqual({ kind: 'unix', path: '/run/dsh/instances/a.sock' })
      expect(await manager.launchGrant(alice)).toBe('grant')
      await manager.stop(alice)
      expect(seen).toEqual(['ensure', 'launch-grant', 'stop'])
      expect(await isActive(alice)).toBe(true)
      for (status of ['suspended', 'pending-deletion']) expect(await isActive(alice)).toBe(false)
      status = 'absent'
      expect(await isActive(alice)).toBe(true)
    } finally { await server.close() }
  })

  it('fails closed when the provisioner is unreachable and carries typed refusals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pc-'))
    const { manager, isActive } = connectProvisioner(join(dir, 'missing.sock'))
    await expect(isActive(alice)).rejects.toThrow()
    await expect(manager.ensure(alice)).rejects.toThrow()
    await chmod(dir, 0o700)
    let error: Error = new CapacityError()
    const server = await startProvisionerServer(join(dir, 'p.sock'), async () => { throw error })
    try {
      const connected = connectProvisioner(join(dir, 'p.sock'))
      await expect(connected.manager.ensure(alice)).rejects.toBeInstanceOf(CapacityError)
      error = new AccountSuspendedError()
      await expect(connected.manager.ensure(alice)).rejects.toBeInstanceOf(AccountSuspendedError)
      await expect(createAccountStatusLookup({ status: async () => { throw new Error('x') } })(alice)).rejects.toThrow()
    } finally { await server.close() }
  })
})
