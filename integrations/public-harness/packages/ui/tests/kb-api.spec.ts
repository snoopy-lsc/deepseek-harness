import { describe, expect, it } from 'vitest'
import { createKbApi } from '../src/client/kb-api.ts'
import { kbCopy, size } from '../src/client/kb-copy.ts'
import { AccountApiError } from '../src/client/me.ts'

function recorder(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }) as unknown as typeof fetch
  return { calls, api: createKbApi(fetcher) }
}

describe('knowledge base client', () => {
  it('uses_the_personal_center_paths_json_writes_and_a_streamed_upload', async () => {
    const r = recorder(200, { kb: { id: 'kb_a' }, job: { id: 'job_a' }, jobs: [], kbs: [] })
    await r.api.overview()
    await r.api.create('Runbooks', '')
    await r.api.upload('kb_a', { name: '部署 notes.md', data: new Blob(['# x']) })
    await r.api.compile('kb_a', 'lint')
    await r.api.jobs('kb_a')
    await r.api.share('kb_a', 'please')
    await r.api.withdraw('kb_a')
    await r.api.archive('kb_a')
    await r.api.shared()
    expect(r.calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual(['GET /account/api/me/kb', 'POST /account/api/me/kb',
      'POST /account/api/me/kb/sources?kb=kb_a&name=%E9%83%A8%E7%BD%B2%20notes.md', 'POST /account/api/me/kb/compile', 'GET /account/api/me/kb/jobs?kb=kb_a',
      'POST /account/api/me/kb/share', 'POST /account/api/me/kb/share/withdraw', 'POST /account/api/me/kb/archive', 'GET /account/api/me/kb/shared'])
    expect(r.calls[2]!.init.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
    expect(r.calls[2]!.init.credentials).toBe('same-origin')
    expect(JSON.parse(String(r.calls[3]!.init.body))).toEqual({ kb: 'kb_a', op: 'lint' })
  })
  it('turns_refusals_into_coded_errors', async () => {
    const r = recorder(409, { code: 'kb-limit', limit: 'max_kbs' })
    await expect(r.api.create('x', '')).rejects.toEqual(new AccountApiError(409, 'kb-limit'))
  })
  it('has_paired_copy_and_readable_sizes', () => {
    const en = Object.keys(kbCopy.en).sort()
    expect(Object.keys(kbCopy.zh).sort()).toEqual(en)
    expect(en.every(k => k.startsWith('kb_'))).toBe(true)
    expect(en.length).toBeGreaterThan(50)
    expect([size(2048), size(5 * 1024 * 1024), size(200 * 1024 * 1024)]).toEqual(['2 KB', '5.0 MB', '200 MB'])
  })
})
