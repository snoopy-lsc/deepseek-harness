import { describe, expect, it } from 'vitest'
import { createAccountApi, AccountApiError } from '../src/client/me.ts'

function recorder(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies.shift()!
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('personal center client', () => {
  it('reads_are_same_origin_gets_under_account_api_me', async () => {
    const { calls, fetcher } = recorder([{ status: 200, body: { provider: 'oidc', passwordChange: false, bindings: [] } },
      { status: 200, body: { sessions: [] } }, { status: 404, body: { code: 'usage-unavailable' } }])
    const api = createAccountApi(fetcher)
    expect(await api.security()).toEqual({ provider: 'oidc', passwordChange: false, bindings: [] })
    expect(await api.sessions()).toEqual([])
    expect(await api.usage()).toBeUndefined()
    expect(calls.map(c => [c.url, c.init.method ?? 'GET', c.init.credentials])).toEqual([
      ['/account/api/me/security', 'GET', 'same-origin'], ['/account/api/me/sessions', 'GET', 'same-origin'], ['/account/api/me/usage', 'GET', 'same-origin']])
  })

  it('writes_post_json_and_surface_the_server_code', async () => {
    const { calls, fetcher } = recorder([{ status: 200, body: { revoked: 1 } }, { status: 200, body: { revoked: 3 } }, { status: 403, body: { code: 'reauth' } }])
    const api = createAccountApi(fetcher)
    await api.revoke('s1')
    expect(await api.revokeOthers()).toBe(3)
    await expect(api.changePassword('old', 'a new long passphrase')).rejects.toEqual(new AccountApiError(403, 'reauth'))
    expect(calls.map(c => [c.url, c.init.method, (c.init.headers as Record<string, string>)['content-type'], c.init.body])).toEqual([
      ['/account/api/me/sessions/revoke', 'POST', 'application/json', '{"id":"s1"}'],
      ['/account/api/me/sessions/revoke-others', 'POST', 'application/json', '{}'],
      ['/account/api/me/password', 'POST', 'application/json', '{"currentPassword":"old","newPassword":"a new long passphrase"}']])
  })
})
