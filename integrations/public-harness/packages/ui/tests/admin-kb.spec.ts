import { describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/client/admin-api.ts'
import { kbAdminCopy } from '../src/client/admin-kb-text.ts'

function recorder(body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status: 200 }) }) as unknown as typeof fetch
  return { calls, api: createAdminApi(fetcher) }
}

describe('System Admin knowledge base client', () => {
  it('uses_the_admin_kb_paths_and_carries_the_reauth_proof', async () => {
    const r = recorder({ requests: [] })
    await r.api.kbRequests('pending')
    await r.api.kbRequestContent('req_a')
    await r.api.kbRequestFile('req_a', 'wiki/部署.md')
    await r.api.approveKb('req_a', [{ kind: 'group', target: 'local:ops' }], true, { password: 'pw' })
    await r.api.rejectKb('req_a', 'needs sources')
    await r.api.setKbScope('kb_a', [{ kind: 'company', target: '*' }])
    await r.api.revokeKb('kb_a', { password: 'pw' })
    expect(r.calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/admin/kb/requests?state=pending', 'GET /api/admin/kb/requests/content?id=req_a', 'GET /api/admin/kb/requests/content?id=req_a&path=wiki%2F%E9%83%A8%E7%BD%B2.md',
      'POST /api/admin/kb/requests/approve', 'POST /api/admin/kb/requests/reject', 'POST /api/admin/kb/scope', 'POST /api/admin/kb/revoke'])
    expect(JSON.parse(String(r.calls[3]!.init.body))).toEqual({ id: 'req_a', scope: [{ kind: 'group', target: 'local:ops' }], includeRaw: true, password: 'pw' })
    expect(JSON.parse(String(r.calls[4]!.init.body))).toEqual({ id: 'req_a', reason: 'needs sources' })
    expect(JSON.parse(String(r.calls[6]!.init.body))).toEqual({ kb: 'kb_a', password: 'pw' })
  })
  it('has_paired_admin_copy', () => {
    expect(Object.keys(kbAdminCopy.zh).sort()).toEqual(Object.keys(kbAdminCopy.en).sort())
    expect(Object.values(kbAdminCopy.zh).every(v => v.length > 0)).toBe(true)
  })
})
