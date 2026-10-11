import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { createFilesProxy, type FilesProxy } from '../src/files.ts'

const roots: string[] = []
const opened: FilesProxy[] = []
afterEach(async () => {
  for (const proxy of opened.splice(0)) proxy.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const alice = parseUserId('alice')
const bob = parseUserId('bob')
const file = (id: string) => ({ id, type: 'file', mime_type: 'image/png', size_bytes: 3,
  filename: `${id}.png`, created_at: '2026-10-11T10:00:00Z' })

async function setup(fetcher: typeof fetch, limits: { maxUploadBytes?: number; maxFilesPerUser?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'quota-files-'))
  roots.push(root)
  const proxy = createFilesProxy({ databasePath: join(root, 'files.sqlite'),
    upstreamRoot: 'https://api.example.test/anthropic/v1', platformKey: 'platform-secret',
    maxUploadBytes: limits.maxUploadBytes ?? 100, maxFilesPerUser: limits.maxFilesPerUser ?? 2,
    maxMetadataBytes: 4096, maxListLimit: 10, fetcher })
  opened.push(proxy)
  return proxy
}

describe('per-user Files proxy', () => {
  it("keeps uploaded files in the owner's list and rejects forged IDs before upstream access", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Response(JSON.stringify(
      options?.method === 'POST' ? file('file_alice') : { id: 'file_alice', type: 'file_deleted' }), { status: 200 }))
    const proxy = await setup(fetcher)
    const uploaded = await proxy.handle(alice, new Request('http://attacker.invalid/v1/files', {
      method: 'POST', body: Buffer.from('abc'), headers: { 'content-type': 'multipart/form-data; boundary=x' },
    }))
    expect(uploaded.status).toBe(200)
    expect((await (await proxy.handle(alice, new Request('http://local/v1/files'))).json() as { data: unknown[] }).data).toHaveLength(1)
    expect((await (await proxy.handle(bob, new Request('http://local/v1/files'))).json() as { data: unknown[] }).data).toEqual([])
    const calls = fetcher.mock.calls.length
    expect((await proxy.handle(bob, new Request('http://local/v1/files/file_alice'))).status).toBe(404)
    expect((await proxy.handle(bob, new Request('http://local/v1/files/file_alice', { method: 'DELETE' }))).status).toBe(404)
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.test/anthropic/v1/files')
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('attacker.invalid')
  })

  it('enforces upload bytes and file count before forwarding', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(file('file_one')), { status: 200 }))
    const proxy = await setup(fetcher, { maxUploadBytes: 3, maxFilesPerUser: 1 })
    expect((await proxy.handle(alice, new Request('http://local/v1/files', { method: 'POST', body: '1234' }))).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await proxy.handle(alice, new Request('http://local/v1/files', { method: 'POST', body: '123' }))).status).toBe(200)
    expect((await proxy.handle(alice, new Request('http://local/v1/files', { method: 'POST', body: '123' }))).status).toBe(429)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses upstream redirects and unsupported operations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.redirect('https://attacker.invalid/', 302))
    const proxy = await setup(fetcher)
    expect((await proxy.handle(alice, new Request('http://local/v1/files', { method: 'POST', body: 'abc' }))).status).toBe(502)
    expect((await proxy.handle(alice, new Request('http://local/v1/unknown'))).status).toBe(404)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
