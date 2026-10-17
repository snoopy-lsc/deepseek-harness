import { describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/client/admin-api.ts'
import { kbAdminCopy } from '../src/client/admin-kb-text.ts'
import { limitText, parseLimit } from '../src/client/admin-kb-units.ts'

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

describe('System Admin knowledge base inventory and limits client', () => {
  it('uses_the_inventory_org_and_limit_paths_with_put_and_delete', async () => {
    const r = recorder({ kbs: [], kb: {}, global: {} })
    await r.api.kbInventory('over')
    await r.api.kbPreview('u1')
    await r.api.kbContent('kb_a', 'wiki/a.md', 'abc')
    await r.api.createOrgKb('Handbook', '', { password: 'pw' })
    await r.api.uploadOrgSource('kb_a', { name: 'leave.md', data: new Blob(['# x']) })
    await r.api.editOrgPage('kb_a', 'wiki/a.md', '# A', '')
    await r.api.compileOrgKb('kb_a', 'ingest')
    await r.api.publishOrgKb('kb_a', undefined, [{ kind: 'company', target: '*' }], { password: 'pw' })
    await r.api.convertKb('kb_b', { password: 'pw' })
    await r.api.kbLimits()
    await r.api.setKbLimit({ type: 'group', id: 'local:1' }, 'max_kbs', null, { password: 'pw' })
    await r.api.deleteKbLimit({ type: 'user', id: 'u1' }, 'max_pages', { password: 'pw' })
    await r.api.kbEffective('u1')
    expect(r.calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual(['GET /api/admin/kb?filter=over', 'GET /api/admin/kb/preview?user=u1',
      'GET /api/admin/kb/content?kb=kb_a&path=wiki%2Fa.md&rev=abc', 'POST /api/admin/kb/org', 'POST /api/admin/kb/org/sources?kb=kb_a&name=leave.md', 'POST /api/admin/kb/org/edit',
      'POST /api/admin/kb/org/compile', 'POST /api/admin/kb/org/rollback', 'POST /api/admin/kb/convert', 'GET /api/admin/kb/limits', 'PUT /api/admin/kb/limits', 'DELETE /api/admin/kb/limits',
      'GET /api/admin/kb/limits/effective?user=u1'])
    expect(r.calls[4]!.init.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
    expect(JSON.parse(String(r.calls[7]!.init.body))).toEqual({ kb: 'kb_a', scope: [{ kind: 'company', target: '*' }], password: 'pw' })
    expect(JSON.parse(String(r.calls[10]!.init.body))).toEqual({ scope: { type: 'group', id: 'local:1' }, name: 'max_kbs', value: null, password: 'pw' })
    expect(JSON.parse(String(r.calls[11]!.init.body))).toEqual({ scope: { type: 'user', id: 'u1' }, name: 'max_pages', password: 'pw' })
  })
  it('enters_sizes_in_mb_and_checks_ranges', () => {
    const range = [1024 * 1024, 1024 ** 4] as const
    expect(limitText('max_bytes', 209_715_200)).toBe('200')
    expect(limitText('max_kbs', null)).toBe('')
    expect(parseLimit('max_bytes', '200', range)).toBe(209_715_200)
    expect(parseLimit('max_bytes', '0', range)).toBeUndefined()
    expect(parseLimit('max_kbs', '12', [1, 10_000])).toBe(12)
    expect(parseLimit('max_kbs', '10001', [1, 10_000])).toBeUndefined()
    expect(parseLimit('max_pages', '1.5', [1, 1_000_000])).toBeUndefined()
  })
})
