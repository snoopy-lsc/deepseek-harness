import { afterEach, describe, expect, it } from 'vitest'
import type { SsoConfig } from '../src/sso/config.ts'
import { createDingtalkProvider, dingtalkPlaceholderEmail } from '../src/sso/dingtalk.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { IdentityUnavailableError } from '../src/transports.ts'
import { MOCK_DT_CLIENT_ID, MOCK_DT_CORP_ID, MOCK_DT_SECRET, startMockDingtalk, type MockDingtalk } from './mock-dingtalk.ts'

const REDIRECT = 'http://127.0.0.1:18443/api/auth/sso/callback'
type DingtalkConfig = Extract<SsoConfig, { kind: 'dingtalk' }>
const mocks: MockDingtalk[] = []
afterEach(async () => { for (const mock of mocks.splice(0)) await mock.close() })
const start = async () => { const mock = await startMockDingtalk(); mocks.push(mock); return mock }
const config = (mock: MockDingtalk, extra: Partial<DingtalkConfig> = {}): DingtalkConfig => ({ kind: 'dingtalk', clientId: MOCK_DT_CLIENT_ID, clientSecret: MOCK_DT_SECRET,
  corpId: MOCK_DT_CORP_ID, apiBase: mock.base, oapiBase: mock.base, loginUrl: mock.loginUrl, exclusiveLogin: false, allowedGroups: ['2'], recursiveDepartments: true, timeoutMs: 1000, ...extra })
async function login(mock: MockDingtalk, provider = createDingtalkProvider(config(mock))) {
  const { url, secrets } = await provider.begin({ redirectUri: REDIRECT })
  const back = await mock.scan(url)
  expect(back.searchParams.get('state')).toBe(secrets.state)
  return provider.finish({ code: back.searchParams.get('authCode')!, redirectUri: REDIRECT, nonce: secrets.nonce, verifier: secrets.verifier })
}
async function rejected(promise: Promise<unknown>) {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}
async function unavailable(promise: Promise<unknown>) { await expect(promise).rejects.toBeInstanceOf(IdentityUnavailableError) }

describe('DingTalk provider', () => {
  it('login_url_follows_the_official_oauth2_authorize_link', async () => {
    const mock = await start()
    const { url, secrets } = await createDingtalkProvider(config(mock)).begin({ redirectUri: REDIRECT })
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe(mock.loginUrl)
    expect(Object.fromEntries(target.searchParams)).toEqual({ redirect_uri: REDIRECT, response_type: 'code', client_id: MOCK_DT_CLIENT_ID, scope: 'openid corpid',
      prompt: 'consent', corpId: MOCK_DT_CORP_ID, state: secrets.state })
    expect(secrets.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url).not.toContain(MOCK_DT_SECRET)
    const exclusive = new URL((await createDingtalkProvider(config(mock, { exclusiveLogin: true })).begin({ redirectUri: REDIRECT })).url)
    expect(exclusive.searchParams.get('exclusiveLogin')).toBe('true')
    expect(exclusive.searchParams.get('exclusiveCorpId')).toBe(MOCK_DT_CORP_ID)
  })

  it('member_maps_to_corp_scoped_union_id_with_departments_and_placeholder_email', async () => {
    const mock = await start()
    const subject = `${MOCK_DT_CORP_ID}:UnionZhang01`
    expect(await login(mock)).toEqual({ subject, email: dingtalkPlaceholderEmail(subject), name: '张三', groups: ['3', '2'] })
    expect(dingtalkPlaceholderEmail(subject)).toMatch(/^dingtalk-[0-9a-f]{32}@sso\.invalid$/)
    mock.members.get('UnionZhang01')!.org_email = 'Zhang@Corp.Example'
    expect((await login(mock)).email).toBe('zhang@corp.example')
  })

  it('app_token_is_cached_and_refetched_once_when_revoked', async () => {
    const mock = await start()
    const provider = createDingtalkProvider(config(mock))
    await login(mock, provider); await login(mock, provider)
    expect(mock.appTokensIssued).toBe(1)
    mock.expireTokens()
    await login(mock, provider)
    expect(mock.appTokensIssued).toBe(2)
  })

  it('recursion_walks_sub_departments_and_can_be_disabled', async () => {
    const mock = await start()
    mock.members.get('UnionZhang01')!.dept_id_list = [5]
    expect((await login(mock)).groups).toEqual(['5', '2'])
    expect((await login(mock, createDingtalkProvider(config(mock, { recursiveDepartments: false })))).groups).toEqual(['5'])
  })

  it('refuses_other_orgs_non_members_external_contacts_and_inactive_members', async () => {
    const mock = await start()
    mock.scannerCorp = 'dingothercorp'
    expect(await rejected(login(mock))).toBe('not-member')
    mock.scannerCorp = MOCK_DT_CORP_ID; mock.scanner = 'UnknownUnion'
    expect(await rejected(login(mock))).toBe('not-member')
    mock.members.set('Ext', { userid: 'ext1', dept_id_list: [2], contact_type: 1 }); mock.scanner = 'Ext'
    expect(await rejected(login(mock))).toBe('not-member')
    mock.members.set('Idle', { userid: 'idle1', dept_id_list: [2], active: false }); mock.scanner = 'Idle'
    expect(await rejected(login(mock))).toBe('inactive')
    mock.scanner = 'UnionZhang01'; mock.failOnce.set('/topapi/v2/user/get', 33012)
    expect(await rejected(login(mock))).toBe('directory')
  })

  it('bad_code_is_rejected_and_outages_fail_closed', async () => {
    const mock = await start()
    const provider = createDingtalkProvider(config(mock))
    const { secrets } = await provider.begin({ redirectUri: REDIRECT })
    expect(await rejected(provider.finish({ code: 'nope', redirectUri: REDIRECT, ...secrets }))).toBe('token-exchange')
    expect(await rejected(provider.finish({ code: '', redirectUri: REDIRECT, ...secrets }))).toBe('token-exchange')
    mock.failOnce.set('/topapi/user/getbyunionid', -1)
    await unavailable(login(mock))
    mock.failOnce.set('/topapi/v2/department/listsubid', 60003)
    await unavailable(login(mock))
    mock.httpStatus = 500
    await unavailable(login(mock))
    mock.httpStatus = undefined; mock.delayMs = 1500
    await unavailable(login(mock))
  })
})
