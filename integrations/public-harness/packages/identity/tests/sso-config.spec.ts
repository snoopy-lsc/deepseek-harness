import { describe, expect, it } from 'vitest'
import { IdentityConfigError } from '../src/config.ts'
import { parseSsoEnv } from '../src/sso/config.ts'
import { setup } from './helpers.ts'
import { makeTestPki } from './mock-ldap.ts'
import { makeTestKeys } from './mock-saml.ts'

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
      [{ DSH_SSO_PROVIDER: 'kerberos' }, 'DSH_SSO_PROVIDER', 'production'],
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

  it('saml_settings_parse_with_a_pinned_certificate_and_refuse_bad_values', () => {
    const keys = makeTestKeys()
    try {
      const saml = (extra: Record<string, string | undefined> = {}) => ({ DSH_SSO_PROVIDER: 'saml', DSH_SAML_SP_ENTITY_ID: 'https://harness.corp.example/saml', DSH_SAML_IDP_ENTITY_ID: 'https://idp.corp.example/saml',
        DSH_SAML_IDP_SSO_URL: 'https://idp.corp.example/sso', DSH_SAML_IDP_CERT_FILE: keys.certFile, DSH_SSO_ALLOWED_GROUPS: 'engineering', ...extra })
      expect(parseSsoEnv(saml(), 'production').sso).toEqual({ kind: 'saml', spEntityId: 'https://harness.corp.example/saml', idpEntityId: 'https://idp.corp.example/saml',
        idpSsoUrl: 'https://idp.corp.example/sso', idpCerts: [keys.cert.trim()], nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', groupAttribute: 'groups',
        emailAttribute: 'email', nameAttribute: 'displayName', wantAssertionsSigned: false, clockSkewMs: 60_000, allowedGroups: ['engineering'] })
      expect(parseSsoEnv(saml({ DSH_SAML_NAMEID_FORMAT: 'emailAddress', DSH_SAML_GROUP_ATTRIBUTE: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
        DSH_SAML_WANT_ASSERTIONS_SIGNED: 'true', DSH_SAML_CLOCK_SKEW_MS: '30000' }), 'production').sso)
        .toMatchObject({ nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', groupAttribute: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', wantAssertionsSigned: true, clockSkewMs: 30_000 })
      const cases: Array<[Record<string, string | undefined>, string]> = [
        [saml({ DSH_SAML_SP_ENTITY_ID: undefined }), 'DSH_SAML_SP_ENTITY_ID'],
        [saml({ DSH_SAML_IDP_ENTITY_ID: undefined }), 'DSH_SAML_IDP_ENTITY_ID'],
        [saml({ DSH_SAML_IDP_SSO_URL: undefined }), 'DSH_SAML_IDP_SSO_URL'],
        [saml({ DSH_SAML_IDP_SSO_URL: 'http://idp.corp.example/sso' }), 'DSH_SAML_IDP_SSO_URL'],
        [saml({ DSH_SAML_IDP_CERT_FILE: undefined }), 'DSH_SAML_IDP_CERT_FILE'],
        [saml({ DSH_SAML_IDP_CERT_FILE: `${keys.dir}/missing.crt` }), 'DSH_SAML_IDP_CERT_FILE'],
        // A private key in the pinned-certificate path is refused rather than ignored.
        [saml({ DSH_SAML_IDP_CERT_FILE: `${keys.dir}/idp.key` }), 'DSH_SAML_IDP_CERT_FILE'],
        [saml({ DSH_SAML_NAMEID_FORMAT: 'transient' }), 'DSH_SAML_NAMEID_FORMAT'],
        [saml({ DSH_SAML_CLOCK_SKEW_MS: '600000' }), 'DSH_SAML_CLOCK_SKEW_MS'],
        [saml({ DSH_SAML_WANT_ASSERTIONS_SIGNED: 'yes' }), 'DSH_SAML_WANT_ASSERTIONS_SIGNED'],
        [saml({ DSH_SSO_ALLOWED_GROUPS: undefined }), 'DSH_SSO_ALLOWED_GROUPS'],
      ]
      for (const [env, name] of cases) expect(() => parseSsoEnv(env, 'production'), name).toThrow(name)
    } finally { keys.cleanup() }
  })

  it('ldap_settings_require_tls_and_parse_ad_and_openldap_defaults', () => {
    const pki = makeTestPki()
    try {
      const ldap = (extra: Record<string, string | undefined> = {}) => ({ DSH_SSO_PROVIDER: 'ldap', DSH_LDAP_URL: 'ldaps://dc1.corp.example', DSH_LDAP_BIND_DN: 'CN=svc,OU=Service,DC=corp,DC=example',
        DSH_LDAP_BIND_PASSWORD: 'placeholder-bind-value', DSH_LDAP_BASE_DN: 'DC=corp,DC=example', DSH_SSO_ALLOWED_GROUPS: 'CN=Engineering, OU=Groups,DC=corp,DC=example;cn=ops,dc=corp,dc=example', ...extra })
      expect(parseSsoEnv(ldap(), 'production').sso).toEqual({ kind: 'ldap', url: 'ldaps://dc1.corp.example', startTls: false, bindDn: 'CN=svc,OU=Service,DC=corp,DC=example',
        bindPassword: 'placeholder-bind-value', baseDn: 'DC=corp,DC=example', userFilter: '(&(objectCategory=person)(objectClass=user))', usernameAttribute: 'sAMAccountName',
        idAttribute: 'objectGUID', emailAttribute: 'mail', nameAttribute: 'displayName', groupMode: 'memberOf', groupBaseDn: 'DC=corp,DC=example', groupObjectClass: 'group',
        activeDirectory: true, serverId: 'dc1.corp.example', allowedGroups: ['cn=engineering,ou=groups,dc=corp,dc=example', 'cn=ops,dc=corp,dc=example'], timeoutMs: 5000 })
      expect(parseSsoEnv(ldap({ DSH_LDAP_URL: 'ldap://ldap.corp.example:389', DSH_LDAP_STARTTLS: 'true', DSH_LDAP_SCHEMA: 'openldap', DSH_LDAP_CA_FILE: pki.caFile, DSH_LDAP_GROUP_MODE: 'search' }), 'production').sso)
        .toMatchObject({ startTls: true, ca: pki.ca, usernameAttribute: 'uid', idAttribute: 'entryUUID', groupObjectClass: 'groupOfNames', activeDirectory: false, serverId: 'ldap.corp.example:389' })
      expect(parseSsoEnv(ldap({ DSH_LDAP_URL: 'ldap://127.0.0.1:3389' }), 'local').sso).toMatchObject({ url: 'ldap://127.0.0.1:3389', startTls: false })
      const cases: Array<[Record<string, string | undefined>, string]> = [
        [ldap({ DSH_LDAP_URL: 'ldap://dc1.corp.example' }), 'DSH_LDAP_URL'],
        [ldap({ DSH_LDAP_URL: 'ldap://127.0.0.1:3389' }), 'DSH_LDAP_URL'],
        [ldap({ DSH_LDAP_URL: 'ldaps://dc1.corp.example', DSH_LDAP_STARTTLS: 'true' }), 'DSH_LDAP_URL'],
        [ldap({ DSH_LDAP_URL: 'ldaps://dc1.corp.example/dc=corp?x' }), 'DSH_LDAP_URL'],
        [ldap({ DSH_LDAP_BIND_PASSWORD: '' }), 'DSH_LDAP_BIND_PASSWORD'],
        [ldap({ DSH_LDAP_BIND_DN: undefined }), 'DSH_LDAP_BIND_DN'],
        [ldap({ DSH_LDAP_CA_FILE: `${pki.dir}/missing.crt` }), 'DSH_LDAP_CA_FILE'],
        [ldap({ DSH_LDAP_CA_FILE: `${pki.dir}/ca.key` }), 'DSH_LDAP_CA_FILE'],
        [ldap({ DSH_LDAP_USER_FILTER: '(objectClass=user' }), 'DSH_LDAP_USER_FILTER'],
        [ldap({ DSH_LDAP_USER_FILTER: 'objectClass=user' }), 'DSH_LDAP_USER_FILTER'],
        [ldap({ DSH_LDAP_GROUP_MODE: 'nested', DSH_LDAP_SCHEMA: 'openldap' }), 'DSH_LDAP_GROUP_MODE'],
        [ldap({ DSH_SSO_ALLOWED_GROUPS: 'engineering' }), 'DSH_SSO_ALLOWED_GROUPS'],
        [ldap({ DSH_LDAP_ID_ATTRIBUTE: 'object guid' }), 'DSH_LDAP_ID_ATTRIBUTE'],
        [ldap({ DSH_LDAP_TIMEOUT_MS: '100' }), 'DSH_LDAP_TIMEOUT_MS'],
      ]
      for (const [env, name] of cases) expect(() => parseSsoEnv(env, 'production'), name).toThrow(name)
    } finally { pki.cleanup() }
  })
})
