import { describe, expect, it } from 'vitest'
import { AdminApiError, createAdminApi } from '../src/client/admin-api.ts'

function recorder(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }) as unknown as typeof fetch
  return { calls, api: createAdminApi(fetcher) }
}

describe('administration client', () => {
  it('reads_with_get_and_writes_same_origin_json_including_the_reauth_proof', async () => {
    const r = recorder(200, { users: [], total: 0, offset: 0, limit: 20, self: 'a' })
    await r.api.users({ q: 'ann', role: 'admin', offset: 20 })
    expect(r.calls[0]!.url).toBe('/api/admin/users?q=ann&role=admin&offset=20')
    expect(r.calls[0]!.init.method).toBeUndefined()
    await r.api.disable('u1', 'left', { password: 'pw' })
    expect(r.calls[1]!.url).toBe('/api/admin/users/disable')
    expect(r.calls[1]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(r.calls[1]!.init.body))).toEqual({ userId: 'u1', reason: 'left', password: 'pw' })
    await r.api.setUserQuota('u1', null)
    expect(JSON.parse(String(r.calls[2]!.init.body))).toEqual({ userId: 'u1', dailyTokens: null })
    await r.api.setOverLimit('grace', 15, { password: 'pw' })
    expect(r.calls[3]!.url).toBe('/api/admin/quota/over-limit')
    expect(JSON.parse(String(r.calls[3]!.init.body))).toEqual({ mode: 'grace', gracePercent: 15, password: 'pw' })
  })

  it('builds_the_csv_export_address_from_the_current_filters', () => {
    const { api } = recorder()
    expect(api.auditCsvUrl({})).toBe('/api/admin/audit.csv')
    expect(api.auditCsvUrl({ event: 'admin-user-disable', outcome: '', q: 'a&b=中' })).toBe('/api/admin/audit.csv?event=admin-user-disable&q=a%26b%3D%E4%B8%AD')
  })

  it('surfaces_the_server_code_and_reauth_method', async () => {
    const r = recorder(401, { code: 'reauth-required', method: 'sso' })
    const error = await r.api.setRole('u1', 'admin').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AdminApiError)
    expect(error).toMatchObject({ status: 401, code: 'reauth-required', method: 'sso' })
    expect(await recorder(404, { code: 'quota-unavailable' }).api.quota()).toBeUndefined()
  })
})
