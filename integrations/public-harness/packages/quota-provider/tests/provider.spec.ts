import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRotatingCredential } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('private quota credential file', () => {
  it('reads the new credential on the next call after rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-provider-'))
    roots.push(root)
    const path = join(root, 'credential.json')
    await writeFile(path, JSON.stringify({ token: 'first.signed', expiresAt: 2000 }), { mode: 0o600 })
    expect(await readRotatingCredential(path, 1000)).toBe('first.signed')
    await writeFile(path, JSON.stringify({ token: 'second.signed', expiresAt: 3000 }), { mode: 0o600 })
    expect(await readRotatingCredential(path, 2000)).toBe('second.signed')
    await expect(readRotatingCredential(path, 3000)).rejects.toThrow(/expired/i)
  })

  it('rejects malformed or overly large credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quota-provider-'))
    roots.push(root)
    const path = join(root, 'credential.json')
    await writeFile(path, '{}', { mode: 0o600 })
    await expect(readRotatingCredential(path, 0)).rejects.toThrow(/credential/i)
    await writeFile(path, 'x'.repeat(4097), { mode: 0o600 })
    await expect(readRotatingCredential(path, 0)).rejects.toThrow(/credential/i)
  })
})
