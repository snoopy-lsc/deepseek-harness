import { afterEach, describe, expect, it } from 'vitest'
import type { SsoConfig } from '../src/sso/config.ts'
import { SsoRejectedError } from '../src/sso/provider.ts'
import { createWecomProvider, wecomPlaceholderEmail } from '../src/sso/wecom.ts'
import { IdentityUnavailableError } from '../src/transports.ts'
import { MOCK_AGENT_ID, MOCK_CORP_ID, MOCK_WECOM_SECRET, startMockWecom, type MockWecom } from './mock-wecom.ts'

const REDIRECT = 'http://127.0.0.1:18443/api/auth/sso/callback'
type WecomConfig = Extract<SsoConfig, { kind: 'wecom' }>
const mocks: MockWecom[] = []
afterEach(async () => { for (const mock of mocks.splice(0)) await mock.close() })
const start = async () => { const mock = await startMockWecom(); mocks.push(mock); return mock }
const config = (mock: MockWecom, extra: Partial<WecomConfig> = {}): WecomConfig => ({ kind: 'wecom', corpId: MOCK_CORP_ID, agentId: MOCK_AGENT_ID, secret: MOCK_WECOM_SECRET,
  apiBase: mock.base, loginUrl: mock.loginUrl, allowedGroups: ['2'], recursiveDepartments: true, timeoutMs: 1000, ...extra })

async function login(mock: MockWecom, provider = createWecomProvider(config(mock))) {
  const { url, secrets } = await provider.begin({ redirectUri: REDIRECT })
  const back = await mock.scan(url)
  expect(back.searchParams.get('state')).toBe(secrets.state)
  return provider.finish({ code: back.searchParams.get('code')!, redirectUri: REDIRECT, nonce: secrets.nonce, verifier: secrets.verifier })
}
async function rejected(promise: Promise<unknown>) {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(SsoRejectedError); return (error as SsoRejectedError).code }
  throw new Error('expected rejection')
}

describe('WeCom provider', () => {
  it('login_url_follows_the_official_web_login_link', async () => {
    const mock = await start()
    const { url, secrets } = await createWecomProvider(config(mock)).begin({ redirectUri: REDIRECT })
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe(mock.loginUrl)
    expect(Object.fromEntries(target.searchParams)).toEqual({ login_type: 'CorpApp', appid: MOCK_CORP_ID, agentid: MOCK_AGENT_ID, redirect_uri: REDIRECT, state: secrets.state })
    expect(secrets.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The browser never sees the secret or an access token.
    expect(url).not.toContain(MOCK_WECOM_SECRET)
    expect(mock.tokensIssued).toBe(0)
  })

  it('member_maps_to_a_corp_scoped_subject_with_departments', async () => {
    const mock = await start()
    const identity = await login(mock)
    expect(identity).toEqual({ subject: `${MOCK_CORP_ID}:zhangsan`, email: wecomPlaceholderEmail(`${MOCK_CORP_ID}:zhangsan`), name: '张三', groups: ['3', '2'] })
    expect(identity.email).toMatch(/^wecom-[0-9a-f]{32}@sso\.invalid$/)
    // WeCom user IDs are case-insensitive, so the subject is too.
    mock.members.set('zhangsan', mock.members.get('ZhangSan')!); mock.members.delete('ZhangSan'); mock.scanner = 'zhangsan'
    expect((await login(mock)).subject).toBe(`${MOCK_CORP_ID}:zhangsan`)
  })

  it('directory_email_is_used_when_the_app_may_read_it', async () => {
    const mock = await start()
    mock.members.set('LiSi', { name: '李四', department: [4], email: 'LiSi@Corp.Example', biz_mail: 'lisi@corp.wecom.work' }); mock.scanner = 'LiSi'
    expect((await login(mock, createWecomProvider(config(mock, { allowedGroups: ['4'] })))).email).toBe('lisi@corp.wecom.work')
    mock.members.set('LiSi', { name: '李四', department: [4], email: 'LiSi@Corp.Example' })
    expect((await login(mock, createWecomProvider(config(mock, { allowedGroups: ['4'] })))).email).toBe('lisi@corp.example')
  })

  it('sub_department_membership_depends_on_the_recursive_switch', async () => {
    const mock = await start()
    mock.members.set('WangWu', { name: '王五', department: [5], status: 1 }); mock.scanner = 'WangWu'
    expect((await login(mock)).groups).toEqual(['5', '2'])
    expect((await login(mock, createWecomProvider(config(mock, { recursiveDepartments: false })))).groups).toEqual(['5'])
    mock.members.set('WangWu', { name: '王五', department: [4] })
    expect((await login(mock)).groups).toEqual(['4'])
  })

  it('access_token_is_cached_and_refreshed_once_when_wecom_revokes_it', async () => {
    const mock = await start(), provider = createWecomProvider(config(mock))
    await login(mock, provider); await login(mock, provider)
    expect(mock.tokensIssued).toBe(1)
    mock.expireTokens()
    expect((await login(mock, provider)).subject).toBe(`${MOCK_CORP_ID}:zhangsan`)
    expect(mock.tokensIssued).toBe(2)
    let now = Date.now()
    const timed = createWecomProvider(config(mock), { clock: () => now })
    await login(mock, timed)
    now += 7200_000
    await login(mock, timed)
    expect(mock.tokensIssued).toBe(4)
  })

  it('non_members_inactive_members_and_bad_codes_are_rejected', async () => {
    const mock = await start()
    mock.scanner = { openid: 'external-openid' }
    expect(await rejected(login(mock))).toBe('not-member')
    mock.scanner = 'OtherCorp/someone'
    expect(await rejected(login(mock))).toBe('not-member')
    mock.members.set('Gone', { name: 'Gone', department: [2], status: 5 }); mock.scanner = 'Gone'
    expect(await rejected(login(mock))).toBe('inactive')
    mock.scanner = 'Missing'
    expect(await rejected(login(mock))).toBe('directory')
    const provider = createWecomProvider(config(mock))
    await expect(provider.finish({ code: 'forged', redirectUri: REDIRECT, nonce: 'n', verifier: 'v' })).rejects.toMatchObject({ code: 'token-exchange' })
  })

  it('wecom_errors_and_timeouts_fail_closed_as_unavailable', async () => {
    const mock = await start()
    mock.failOnce.set('/cgi-bin/gettoken', 40001)
    await expect(login(mock)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.failOnce.set('/cgi-bin/auth/getuserinfo', -1)
    await expect(login(mock)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.failOnce.set('/cgi-bin/department/simplelist', 60011)
    await expect(login(mock)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.httpStatus = 502
    await expect(login(mock)).rejects.toBeInstanceOf(IdentityUnavailableError)
    mock.httpStatus = undefined; mock.delayMs = 1500
    const provider = createWecomProvider(config(mock))
    const { secrets } = await provider.begin({ redirectUri: REDIRECT })
    await expect(provider.finish({ code: 'x', redirectUri: REDIRECT, nonce: secrets.nonce, verifier: secrets.verifier })).rejects.toBeInstanceOf(IdentityUnavailableError)
  })
})
