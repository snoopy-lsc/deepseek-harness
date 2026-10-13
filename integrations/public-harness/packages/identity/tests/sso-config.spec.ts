import { describe, expect, it } from 'vitest'
import { IdentityConfigError } from '../src/config.ts'
import { parseSsoEnv } from '../src/sso/config.ts'
import { setup } from './helpers.ts'

const SECRET = 'placeholder-client-secret-value'
const oidc = (extra: Record<string, string | undefined> = {}) => ({
  DSH_SSO_PROVIDER: 'oidc', DSH_OIDC_ISSUER: 'https://idp.example.test/realms/corp', DSH_OIDC_CLIENT_ID: 'harness',
  DSH_OIDC_CLIENT_SECRET: SECRET, DSH_SSO_ALLOWED_GROUPS: 'engineering, /corp/research', ...extra,
})
const failure = (fn: () => unknown) => { try { fn() } catch (error) { return error } throw new Error('expected failure') }

describe('SSO environment', () => {
  it('unset_or_off_keeps_sso_disabled', () => {
    expect(parseSsoEnv({}, 'production')).toEqual({ sso: { kind: 'off' }, emergency: { enabled: false } })
    expect(parseSsoEnv({ DSH_SSO_PROVIDER: 'off' }, 'production').sso).toEqual({ kind: 'off' })
  })

  it('oidc_settings_parse_with_defaults', () => {
    expect(parseSsoEnv(oidc(), 'production').sso).toEqual({ kind: 'oidc', issuer: 'https://idp.example.test/realms/corp', clientId: 'harness', clientSecret: SECRET,
      scopes: ['openid', 'email', 'profile'], groupClaims: ['groups'], allowedGroups: ['engineering', '/corp/research'], timeoutMs: 5000 })
    const custom = parseSsoEnv(oidc({ DSH_OIDC_SCOPES: 'openid email', DSH_OIDC_GROUP_CLAIMS: 'groups,department', DSH_OIDC_TIMEOUT_MS: '8000' }), 'production').sso
    expect(custom).toMatchObject({ scopes: ['openid', 'email'], groupClaims: ['groups', 'department'], timeoutMs: 8000 })
    expect(parseSsoEnv(oidc({ DSH_OIDC_ISSUER: 'http://127.0.0.1:9000' }), 'local').sso).toMatchObject({ issuer: 'http://127.0.0.1:9000' })
  })

  it('invalid_settings_refuse_start_naming_the_variable', () => {
    const cases: Array<[Record<string, string | undefined>, string, 'production' | 'local']> = [
      [{ DSH_SSO_PROVIDER: 'saml' }, 'DSH_SSO_PROVIDER', 'production'],
      [{ DSH_SSO_PROVIDER: 'OIDC' }, 'DSH_SSO_PROVIDER', 'production'],
      [oidc({ DSH_OIDC_CLIENT_ID: undefined }), 'DSH_OIDC_CLIENT_ID', 'production'],
      [oidc({ DSH_OIDC_CLIENT_SECRET: '' }), 'DSH_OIDC_CLIENT_SECRET', 'production'],
      [oidc({ DSH_OIDC_SCOPES: 'email profile' }), 'DSH_OIDC_SCOPES', 'production'],
      [oidc({ DSH_SSO_ALLOWED_GROUPS: undefined }), 'DSH_SSO_ALLOWED_GROUPS', 'production'],
      [oidc({ DSH_SSO_ALLOWED_GROUPS: ' , ' }), 'DSH_SSO_ALLOWED_GROUPS', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'https://idp.example.test/?x=1' }), 'DSH_OIDC_ISSUER', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'https://idp.example.test/#a' }), 'DSH_OIDC_ISSUER', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'https://user:pw@idp.example.test' }), 'DSH_OIDC_ISSUER', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'http://idp.example.test' }), 'DSH_OIDC_ISSUER', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'http://127.0.0.1:9000' }), 'DSH_OIDC_ISSUER', 'production'],
      [oidc({ DSH_OIDC_ISSUER: 'http://idp.example.test' }), 'DSH_OIDC_ISSUER', 'local'],
      [oidc({ DSH_OIDC_TIMEOUT_MS: '100' }), 'DSH_OIDC_TIMEOUT_MS', 'production'],
      [oidc({ DSH_OIDC_GROUP_CLAIMS: 'groups,,x' }), 'DSH_OIDC_GROUP_CLAIMS', 'production'],
      [oidc({ DSH_SSO_EMERGENCY_ALLOWED_IPS: '10.0.0.0/33' }), 'DSH_SSO_EMERGENCY_ALLOWED_IPS', 'production'],
      [oidc({ DSH_SSO_EMERGENCY_ALLOWED_IPS: 'intranet' }), 'DSH_SSO_EMERGENCY_ALLOWED_IPS', 'production'],
      [{ DSH_SSO_EMERGENCY_ALLOWED_IPS: '10.0.0.1' }, 'DSH_SSO_EMERGENCY_ALLOWED_IPS', 'production'],
    ]
    for (const [env, field, mode] of cases) {
      const error = failure(() => parseSsoEnv(env, mode))
      expect(error, field).toBeInstanceOf(IdentityConfigError)
      expect((error as IdentityConfigError).field).toBe(field)
      expect((error as Error).message).not.toContain(SECRET)
    }
  })

  it('emergency_allow_list_parses_addresses_and_prefixes', () => {
    expect(parseSsoEnv(oidc({ DSH_SSO_EMERGENCY_ALLOWED_IPS: '10.20.0.0/16, 192.0.2.7 ,2001:db8::/32' }), 'production').emergency)
      .toEqual({ enabled: true, allowedIps: ['10.20.0.0/16', '192.0.2.7', '2001:db8::/32'] })
  })

  it('identity_config_carries_sso_from_env_and_refuses_file_keys', async () => {
    const { config } = await setup({}, oidc({ DSH_OIDC_ISSUER: 'http://127.0.0.1:9000' }))
    expect(config.sso.kind).toBe('oidc')
    expect(config.emergency).toEqual({ enabled: false })
    await expect(setup({ sso: { kind: 'oidc' } })).rejects.toBeInstanceOf(IdentityConfigError)
    expect((await setup()).config.sso).toEqual({ kind: 'off' })
  })
})

describe('WeCom environment', () => {
  const WECOM_SECRET = 'placeholder-wecom-app-secret'
  const wecom = (extra: Record<string, string | undefined> = {}) => ({ DSH_SSO_PROVIDER: 'wecom', DSH_WECOM_CORP_ID: 'wwplaceholdercorp', DSH_WECOM_AGENT_ID: '1000002',
    DSH_WECOM_SECRET: WECOM_SECRET, DSH_SSO_ALLOWED_GROUPS: '2, 15', ...extra })

  it('wecom_settings_parse_with_public_defaults', () => {
    expect(parseSsoEnv(wecom(), 'production').sso).toEqual({ kind: 'wecom', corpId: 'wwplaceholdercorp', agentId: '1000002', secret: WECOM_SECRET,
      apiBase: 'https://qyapi.weixin.qq.com', loginUrl: 'https://login.work.weixin.qq.com/wwlogin/sso/login', allowedGroups: ['2', '15'], recursiveDepartments: true, timeoutMs: 5000 })
    // A private (私有化) deployment points both URLs at the intranet server.
    expect(parseSsoEnv(wecom({ DSH_WECOM_API_BASE: 'https://wecom.corp.example/', DSH_WECOM_LOGIN_URL: 'https://wecom.corp.example/wwopen/sso/qrConnect',
      DSH_WECOM_DEPARTMENT_RECURSIVE: 'false' }), 'production').sso).toMatchObject({ apiBase: 'https://wecom.corp.example', loginUrl: 'https://wecom.corp.example/wwopen/sso/qrConnect', recursiveDepartments: false })
    expect(parseSsoEnv(wecom({ DSH_WECOM_API_BASE: 'http://127.0.0.1:9100', DSH_WECOM_LOGIN_URL: 'http://127.0.0.1:9100/wwlogin/sso/login' }), 'local').sso).toMatchObject({ apiBase: 'http://127.0.0.1:9100' })
  })

  it('invalid_wecom_settings_refuse_start', () => {
    const cases: Array<[Record<string, string | undefined>, string, 'production' | 'local']> = [
      [wecom({ DSH_WECOM_CORP_ID: undefined }), 'DSH_WECOM_CORP_ID', 'production'],
      [wecom({ DSH_WECOM_CORP_ID: 'ww corp' }), 'DSH_WECOM_CORP_ID', 'production'],
      [wecom({ DSH_WECOM_AGENT_ID: 'abc' }), 'DSH_WECOM_AGENT_ID', 'production'],
      [wecom({ DSH_WECOM_SECRET: '' }), 'DSH_WECOM_SECRET', 'production'],
      [wecom({ DSH_SSO_ALLOWED_GROUPS: 'engineering' }), 'DSH_SSO_ALLOWED_GROUPS', 'production'],
      [wecom({ DSH_SSO_ALLOWED_GROUPS: undefined }), 'DSH_SSO_ALLOWED_GROUPS', 'production'],
      [wecom({ DSH_WECOM_API_BASE: 'http://wecom.corp.example' }), 'DSH_WECOM_API_BASE', 'production'],
      [wecom({ DSH_WECOM_API_BASE: 'https://wecom.corp.example/x?y=1' }), 'DSH_WECOM_API_BASE', 'production'],
      [wecom({ DSH_WECOM_LOGIN_URL: 'http://127.0.0.1:9100/login' }), 'DSH_WECOM_LOGIN_URL', 'production'],
      [wecom({ DSH_WECOM_LOGIN_URL: 'https://login.example/?appid=x' }), 'DSH_WECOM_LOGIN_URL', 'production'],
      [wecom({ DSH_WECOM_DEPARTMENT_RECURSIVE: 'yes' }), 'DSH_WECOM_DEPARTMENT_RECURSIVE', 'production'],
      [wecom({ DSH_WECOM_TIMEOUT_MS: '99' }), 'DSH_WECOM_TIMEOUT_MS', 'production'],
    ]
    for (const [env, field, mode] of cases) {
      const error = failure(() => parseSsoEnv(env, mode))
      expect((error as IdentityConfigError).field, field).toBe(field)
      expect((error as Error).message).not.toContain(WECOM_SECRET)
    }
  })

  const DT_SECRET = 'placeholder-dingtalk-app-secret'
  const dingtalk = (extra: Record<string, string | undefined> = {}) => ({ DSH_SSO_PROVIDER: 'dingtalk', DSH_DINGTALK_CLIENT_ID: 'dingplaceholderkey', DSH_DINGTALK_CLIENT_SECRET: DT_SECRET,
    DSH_DINGTALK_CORP_ID: 'dingplaceholdercorp', DSH_SSO_ALLOWED_GROUPS: '2, 409', ...extra })
  it('dingtalk_settings_parse_with_public_defaults', () => {
    expect(parseSsoEnv(dingtalk(), 'production').sso).toEqual({ kind: 'dingtalk', clientId: 'dingplaceholderkey', clientSecret: DT_SECRET, corpId: 'dingplaceholdercorp',
      apiBase: 'https://api.dingtalk.com', oapiBase: 'https://oapi.dingtalk.com', loginUrl: 'https://login.dingtalk.com/oauth2/auth', exclusiveLogin: false,
      allowedGroups: ['2', '409'], recursiveDepartments: true, timeoutMs: 5000 })
    expect(parseSsoEnv(dingtalk({ DSH_DINGTALK_API_BASE: 'https://api.ding.corp.example', DSH_DINGTALK_OAPI_BASE: 'https://oapi.ding.corp.example/',
      DSH_DINGTALK_LOGIN_URL: 'https://login.ding.corp.example/oauth2/auth', DSH_DINGTALK_EXCLUSIVE_LOGIN: 'true', DSH_DINGTALK_DEPARTMENT_RECURSIVE: 'false' }), 'production').sso)
      .toMatchObject({ apiBase: 'https://api.ding.corp.example', oapiBase: 'https://oapi.ding.corp.example', exclusiveLogin: true, recursiveDepartments: false })
  })
  it('invalid_dingtalk_settings_refuse_start', () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [dingtalk({ DSH_DINGTALK_CLIENT_ID: undefined }), 'DSH_DINGTALK_CLIENT_ID'],
      [dingtalk({ DSH_DINGTALK_CLIENT_SECRET: '' }), 'DSH_DINGTALK_CLIENT_SECRET'],
      [dingtalk({ DSH_DINGTALK_CORP_ID: undefined }), 'DSH_DINGTALK_CORP_ID'],
      [dingtalk({ DSH_SSO_ALLOWED_GROUPS: 'sales' }), 'DSH_SSO_ALLOWED_GROUPS'],
      [dingtalk({ DSH_DINGTALK_OAPI_BASE: 'http://oapi.ding.corp.example' }), 'DSH_DINGTALK_OAPI_BASE'],
      [dingtalk({ DSH_DINGTALK_API_BASE: 'https://api.example/v1.0' }), 'DSH_DINGTALK_API_BASE'],
      [dingtalk({ DSH_DINGTALK_LOGIN_URL: 'https://login.example/?client_id=x' }), 'DSH_DINGTALK_LOGIN_URL'],
      [dingtalk({ DSH_DINGTALK_EXCLUSIVE_LOGIN: '1' }), 'DSH_DINGTALK_EXCLUSIVE_LOGIN'],
      [dingtalk({ DSH_DINGTALK_TIMEOUT_MS: '70000' }), 'DSH_DINGTALK_TIMEOUT_MS'],
    ]
    for (const [env, name] of cases) expect(() => parseSsoEnv(env, 'production'), name).toThrow(name)
  })
})
