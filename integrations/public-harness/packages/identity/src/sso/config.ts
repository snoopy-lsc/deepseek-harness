/** Enterprise SSO settings, read only from the service environment and refused at startup when incomplete. */
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { IdentityConfigError } from '../config.ts'
import { validIpEntry } from './ip.ts'

/** Configured enterprise sign-in; `off` keeps public registration behavior unchanged. */
export type SsoConfig =
  | { readonly kind: 'off' }
  | { readonly kind: 'oidc'; readonly issuer: string; readonly clientId: string; readonly clientSecret: string; readonly scopes: readonly string[]
    readonly groupClaims: readonly string[]; readonly allowedGroups: readonly string[]; readonly timeoutMs: number }
  | { readonly kind: 'wecom'; readonly corpId: string; readonly agentId: string; readonly secret: string; readonly apiBase: string; readonly loginUrl: string
    /** Department IDs (as decimal strings); with `recursiveDepartments`, members of their sub-departments are admitted too. */
    readonly allowedGroups: readonly string[]; readonly recursiveDepartments: boolean; readonly timeoutMs: number }
  | { readonly kind: 'dingtalk'; readonly clientId: string; readonly clientSecret: string; readonly corpId: string; readonly apiBase: string; readonly oapiBase: string
    readonly loginUrl: string; readonly exclusiveLogin: boolean
    /** Department IDs (as decimal strings); with `recursiveDepartments`, members of their sub-departments are admitted too. */
    readonly allowedGroups: readonly string[]; readonly recursiveDepartments: boolean; readonly timeoutMs: number }
  | { readonly kind: 'saml'; readonly spEntityId: string; readonly idpEntityId: string; readonly idpSsoUrl: string
    /** Pinned IdP signing certificates (PEM), read once at start from `DSH_SAML_IDP_CERT_FILE`; several allow a rollover. */
    readonly idpCerts: readonly string[]; readonly nameIdFormat: string
    readonly groupAttribute: string; readonly emailAttribute: string; readonly nameAttribute: string
    /** Require the Assertion itself to be signed; otherwise a signed Response or a signed Assertion is enough. */
    readonly wantAssertionsSigned: boolean; readonly clockSkewMs: number; readonly allowedGroups: readonly string[]
    /** Present when the IdP requires signed AuthnRequests: the SP signing key and its certificate (PEM), published in SP metadata. */
    readonly signing?: SpKeyPair
    /** Present when the IdP encrypts assertions: the SP decryption key and certificate (PEM); plain assertions are then refused. */
    readonly decryption?: SpKeyPair }
  | { readonly kind: 'ldap'; readonly url: string; readonly startTls: boolean
    /** PEM CA bundle pinned from `DSH_LDAP_CA_FILE`; absent means the system store. */
    readonly ca?: string; readonly bindDn: string; readonly bindPassword: string; readonly baseDn: string; readonly userFilter: string
    readonly usernameAttribute: string; readonly idAttribute: string; readonly emailAttribute: string; readonly nameAttribute: string
    readonly groupMode: 'memberOf' | 'nested' | 'search'; readonly groupBaseDn: string; readonly groupObjectClass: string
    /** Active Directory: objectGUID handling and userAccountControl disabled-account checks. */
    readonly activeDirectory: boolean
    /** Scopes subjects to one directory, default `host:port` of the URL. */
    readonly serverId: string
    /** Normalized group DNs (see `normalizeDn`), separated by `;` in `DSH_SSO_ALLOWED_GROUPS` because DNs contain commas. */
    readonly allowedGroups: readonly string[]; readonly timeoutMs: number }
/** An SP private key (PEM) with the certificate that carries its public key. */
export interface SpKeyPair { readonly key: string; readonly cert: string }

/** Administrator emergency password path; enabled only by a source-address allow-list. */
export type EmergencyConfig = { readonly enabled: false } | { readonly enabled: true; readonly allowedIps: readonly string[] }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Compare-friendly DN: lower case, no spaces around separators. Directories return the same group with varying case and spacing.
 * @param dn Distinguished name.
 * @returns Normalized DN.
 */
export function normalizeDn(dn: string): string {
  return dn.trim().toLowerCase().replace(/\s*([,=+])\s*/g, '$1')
}

/** Parse `DSH_SSO_*`, `DSH_OIDC_*`, `DSH_WECOM_*`, `DSH_DINGTALK_*`, `DSH_SAML_*` and `DSH_LDAP_*`. Errors name the variable, never its value.
 * @param env Process environment.
 * @param mode Service mode; production requires HTTPS IdP URLs, local mode allows loopback HTTP for the mock IdPs.
 * @returns SSO and emergency settings.
 */
export function parseSsoEnv(env: Readonly<Record<string, string | undefined>>, mode: 'production' | 'local'): { sso: SsoConfig; emergency: EmergencyConfig } {
  const need = (name: string, pattern: RegExp = /^\S(?:.*\S)?$/): string => {
    const value = env[name]
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value) || !pattern.test(value)) throw new IdentityConfigError(name)
    return value
  }
  const optional = (name: string, fallback: string, pattern?: RegExp) => env[name] === undefined || env[name] === '' ? fallback : need(name, pattern)
  const list = (name: string, value: string, item: RegExp) => {
    const items = value.split(',').map(entry => entry.trim())
    if (!items.length || items.some(entry => !item.test(entry))) throw new IdentityConfigError(name)
    return items
  }
  // Public endpoints by default; a private (私有化) or exclusive deployment points the URLs at its own HTTPS server.
  const base = (name: string, fallback: string, allowPath: boolean) => {
    const raw = fallback === '' ? need(name) : optional(name, fallback)
    let url: URL
    try { url = new URL(raw) } catch { throw new IdentityConfigError(name) }
    const loopbackHttp = mode === 'local' && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.search || url.hash || url.username || url.password || raw.includes('?') || raw.includes('#')
      || (!allowPath && url.pathname !== '/')) throw new IdentityConfigError(name)
    return allowPath ? url.href : url.origin
  }
  const certificates = (name: string, text: string) => {
    const pems = text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g) ?? []
    if (!pems.length || /PRIVATE KEY/.test(text)) throw new IdentityConfigError(name)
    for (const pem of pems) { try { new X509Certificate(pem) } catch { throw new IdentityConfigError(name) } }
    return pems
  }
  /** A private key file must be a regular file (no symlink) owned by the service user and closed to group and others. */
  const privateFile = (name: string) => {
    const file = need(name)
    let text: string
    try {
      const info = lstatSync(file)
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) throw new Error('mode')
      text = readFileSync(file, 'utf8')
    } catch { throw new IdentityConfigError(name) }
    return text
  }
  /** Load an RSA key and the certificate that matches it; either may come from `<NAME>_FILE`, or (signing only) from `<NAME>` itself. */
  const keyPair = (keyName: string, certName: string, envAllowed: boolean): SpKeyPair => {
    const has = (name: string) => env[name] !== undefined && env[name] !== ''
    if (!envAllowed && has(keyName)) throw new IdentityConfigError(keyName)
    if (has(keyName) && has(`${keyName}_FILE`)) throw new IdentityConfigError(keyName)
    if (has(certName) && has(`${certName}_FILE`)) throw new IdentityConfigError(certName)
    const keyText = has(`${keyName}_FILE`) ? privateFile(`${keyName}_FILE`) : envAllowed && has(keyName) ? env[keyName]! : undefined
    if (keyText === undefined) throw new IdentityConfigError(envAllowed ? keyName : `${keyName}_FILE`)
    const keyVar = has(`${keyName}_FILE`) ? `${keyName}_FILE` : keyName
    let key
    try {
      const pem = /-----BEGIN (?:RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s]+?-----END (?:RSA )?PRIVATE KEY-----/.exec(keyText)?.[0]
      if (pem === undefined || /CERTIFICATE/.test(keyText)) throw new Error('pem')
      key = createPrivateKey(pem)
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('rsa')
    } catch { throw new IdentityConfigError(keyVar) }
    let certText: string | undefined
    const certVar = has(`${certName}_FILE`) ? `${certName}_FILE` : certName
    if (has(`${certName}_FILE`)) { try { certText = readFileSync(need(`${certName}_FILE`), 'utf8') } catch { throw new IdentityConfigError(certVar) } }
    else if (envAllowed && has(certName)) certText = env[certName]!
    if (certText === undefined) throw new IdentityConfigError(envAllowed ? certName : `${certName}_FILE`)
    const pems = certificates(certVar, certText)
    // The certificate must carry this key's public half; a mismatch would publish metadata the IdP cannot use.
    if (pems.length !== 1 || !new X509Certificate(pems[0]!).publicKey.equals(createPublicKey(key))) throw new IdentityConfigError(certVar)
    return { key: key.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: pems[0]! }
  }
  const kind = env.DSH_SSO_PROVIDER ?? 'off'
  let sso: SsoConfig
  if (kind === 'off' || kind === '') sso = { kind: 'off' }
  else if (kind === 'oidc') {
    let issuer: URL
    try { issuer = new URL(need('DSH_OIDC_ISSUER')) } catch { throw new IdentityConfigError('DSH_OIDC_ISSUER') }
    const loopbackHttp = mode === 'local' && issuer.protocol === 'http:' && LOOPBACK.has(issuer.hostname)
    if ((issuer.protocol !== 'https:' && !loopbackHttp) || issuer.search || issuer.hash || issuer.username || issuer.password
      || env.DSH_OIDC_ISSUER!.includes('?') || env.DSH_OIDC_ISSUER!.includes('#')) throw new IdentityConfigError('DSH_OIDC_ISSUER')
    const scopes = optional('DSH_OIDC_SCOPES', 'openid email profile', /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/).split(' ')
    if (!scopes.includes('openid')) throw new IdentityConfigError('DSH_OIDC_SCOPES')
    const timeoutMs = Number(optional('DSH_OIDC_TIMEOUT_MS', '5000', /^[0-9]{3,6}$/))
    if (timeoutMs < 500 || timeoutMs > 60_000) throw new IdentityConfigError('DSH_OIDC_TIMEOUT_MS')
    sso = { kind: 'oidc', issuer: env.DSH_OIDC_ISSUER!, clientId: need('DSH_OIDC_CLIENT_ID', /^[\x21-\x7e]{1,256}$/), clientSecret: need('DSH_OIDC_CLIENT_SECRET', /^.+$/), scopes,
      groupClaims: list('DSH_OIDC_GROUP_CLAIMS', optional('DSH_OIDC_GROUP_CLAIMS', 'groups'), /^[A-Za-z0-9_:./-]{1,256}$/),
      // D7: just-in-time accounts only for configured departments or groups; an empty list would admit nobody, so it refuses start.
      allowedGroups: list('DSH_SSO_ALLOWED_GROUPS', need('DSH_SSO_ALLOWED_GROUPS'), /^[^,\s](?:[^,]{0,254}[^,\s])?$/), timeoutMs }
  } else if (kind === 'wecom') {
    const timeoutMs = Number(optional('DSH_WECOM_TIMEOUT_MS', '5000', /^[0-9]{3,6}$/))
    if (timeoutMs < 500 || timeoutMs > 60_000) throw new IdentityConfigError('DSH_WECOM_TIMEOUT_MS')
    sso = { kind: 'wecom', corpId: need('DSH_WECOM_CORP_ID', /^[A-Za-z0-9_-]{1,64}$/), agentId: need('DSH_WECOM_AGENT_ID', /^[0-9]{1,20}$/), secret: need('DSH_WECOM_SECRET', /^.+$/),
      apiBase: base('DSH_WECOM_API_BASE', 'https://qyapi.weixin.qq.com', false), loginUrl: base('DSH_WECOM_LOGIN_URL', 'https://login.work.weixin.qq.com/wwlogin/sso/login', true),
      // D7 for WeCom: department IDs, never names, because names are not returned to most apps and are not unique.
      allowedGroups: list('DSH_SSO_ALLOWED_GROUPS', need('DSH_SSO_ALLOWED_GROUPS'), /^[1-9][0-9]{0,11}$/),
      recursiveDepartments: optional('DSH_WECOM_DEPARTMENT_RECURSIVE', 'true', /^(true|false)$/) === 'true', timeoutMs }
  } else if (kind === 'dingtalk') {
    const timeoutMs = Number(optional('DSH_DINGTALK_TIMEOUT_MS', '5000', /^[0-9]{3,6}$/))
    if (timeoutMs < 500 || timeoutMs > 60_000) throw new IdentityConfigError('DSH_DINGTALK_TIMEOUT_MS')
    sso = { kind: 'dingtalk', clientId: need('DSH_DINGTALK_CLIENT_ID', /^[A-Za-z0-9_-]{1,128}$/), clientSecret: need('DSH_DINGTALK_CLIENT_SECRET', /^.+$/),
      // The login must be in this organization: the user token's corpId is compared with it, and it scopes the subject.
      corpId: need('DSH_DINGTALK_CORP_ID', /^[A-Za-z0-9_-]{1,128}$/),
      apiBase: base('DSH_DINGTALK_API_BASE', 'https://api.dingtalk.com', false), oapiBase: base('DSH_DINGTALK_OAPI_BASE', 'https://oapi.dingtalk.com', false),
      loginUrl: base('DSH_DINGTALK_LOGIN_URL', 'https://login.dingtalk.com/oauth2/auth', true),
      exclusiveLogin: optional('DSH_DINGTALK_EXCLUSIVE_LOGIN', 'false', /^(true|false)$/) === 'true',
      allowedGroups: list('DSH_SSO_ALLOWED_GROUPS', need('DSH_SSO_ALLOWED_GROUPS'), /^[1-9][0-9]{0,18}$/),
      recursiveDepartments: optional('DSH_DINGTALK_DEPARTMENT_RECURSIVE', 'true', /^(true|false)$/) === 'true', timeoutMs }
  } else if (kind === 'saml') {
    const certs = (() => {
      const file = need('DSH_SAML_IDP_CERT_FILE')
      let text: string
      try { text = readFileSync(file, 'utf8') } catch { throw new IdentityConfigError('DSH_SAML_IDP_CERT_FILE') }
      // Only certificates: a private key or an empty file in this path is a configuration error, never silently ignored.
      return certificates('DSH_SAML_IDP_CERT_FILE', text)
    })()
    // Keys are loaded only when the IdP is declared to need them; a key without the declaration is an inconsistent deployment and refuses start.
    const signRequests = optional('DSH_SAML_SIGN_REQUESTS', 'false', /^(true|false)$/) === 'true'
    const encrypted = optional('DSH_SAML_ENCRYPTED_ASSERTIONS', 'false', /^(true|false)$/) === 'true'
    const present = (...names: string[]) => names.some(name => env[name] !== undefined && env[name] !== '')
    if (!signRequests && present('DSH_SAML_SP_SIGNING_KEY', 'DSH_SAML_SP_SIGNING_KEY_FILE', 'DSH_SAML_SP_SIGNING_CERT', 'DSH_SAML_SP_SIGNING_CERT_FILE')) throw new IdentityConfigError('DSH_SAML_SIGN_REQUESTS')
    if (present('DSH_SAML_SP_DECRYPTION_KEY')) throw new IdentityConfigError('DSH_SAML_SP_DECRYPTION_KEY')
    if (!encrypted && present('DSH_SAML_SP_DECRYPTION_KEY_FILE', 'DSH_SAML_SP_DECRYPTION_CERT_FILE')) throw new IdentityConfigError('DSH_SAML_ENCRYPTED_ASSERTIONS')
    const signing = signRequests ? keyPair('DSH_SAML_SP_SIGNING_KEY', 'DSH_SAML_SP_SIGNING_CERT', true) : undefined
    const decryption = encrypted ? keyPair('DSH_SAML_SP_DECRYPTION_KEY', 'DSH_SAML_SP_DECRYPTION_CERT', false) : undefined
    const format = optional('DSH_SAML_NAMEID_FORMAT', 'persistent', /^(persistent|emailAddress|unspecified)$/)
    const skew = Number(optional('DSH_SAML_CLOCK_SKEW_MS', '60000', /^[0-9]{1,6}$/))
    if (skew > 300_000) throw new IdentityConfigError('DSH_SAML_CLOCK_SKEW_MS')
    const attribute = (name: string, fallback: string) => optional(name, fallback, /^[\x21-\x7e]{1,256}$/)
    sso = { kind: 'saml', spEntityId: need('DSH_SAML_SP_ENTITY_ID', /^[\x21-\x7e]{1,1024}$/), idpEntityId: need('DSH_SAML_IDP_ENTITY_ID', /^[\x21-\x7e]{1,1024}$/),
      idpSsoUrl: base('DSH_SAML_IDP_SSO_URL', '', true), idpCerts: certs,
      nameIdFormat: format === 'unspecified' ? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified' : format === 'emailAddress' ? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' : 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      groupAttribute: attribute('DSH_SAML_GROUP_ATTRIBUTE', 'groups'), emailAttribute: attribute('DSH_SAML_EMAIL_ATTRIBUTE', 'email'), nameAttribute: attribute('DSH_SAML_NAME_ATTRIBUTE', 'displayName'),
      wantAssertionsSigned: optional('DSH_SAML_WANT_ASSERTIONS_SIGNED', 'false', /^(true|false)$/) === 'true', clockSkewMs: skew,
      allowedGroups: list('DSH_SSO_ALLOWED_GROUPS', need('DSH_SSO_ALLOWED_GROUPS'), /^[^,\s](?:[^,]{0,254}[^,\s])?$/),
      ...signing === undefined ? {} : { signing }, ...decryption === undefined ? {} : { decryption } }
  } else if (kind === 'ldap') {
    let url: URL
    try { url = new URL(need('DSH_LDAP_URL')) } catch { throw new IdentityConfigError('DSH_LDAP_URL') }
    const startTls = optional('DSH_LDAP_STARTTLS', 'false', /^(true|false)$/) === 'true'
    // Credentials never cross the network in clear: LDAPS, or ldap:// with StartTLS; plain ldap:// only to loopback in local mode.
    const plainOk = mode === 'local' && LOOPBACK.has(url.hostname)
    if (!['ldaps:', 'ldap:'].includes(url.protocol) || (url.protocol === 'ldaps:' && startTls) || (url.protocol === 'ldap:' && !startTls && !plainOk)
      || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) throw new IdentityConfigError('DSH_LDAP_URL')
    let ca: string | undefined
    if (env.DSH_LDAP_CA_FILE) {
      try { ca = readFileSync(need('DSH_LDAP_CA_FILE'), 'utf8') } catch { throw new IdentityConfigError('DSH_LDAP_CA_FILE') }
      const pems = ca.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g) ?? []
      if (!pems.length || /PRIVATE KEY/.test(ca)) throw new IdentityConfigError('DSH_LDAP_CA_FILE')
      for (const pem of pems) { try { new X509Certificate(pem) } catch { throw new IdentityConfigError('DSH_LDAP_CA_FILE') } }
    }
    const schema = optional('DSH_LDAP_SCHEMA', 'ad', /^(ad|openldap)$/)
    const ad = schema === 'ad'
    const attribute = (name: string, fallback: string) => optional(name, fallback, /^[A-Za-z][A-Za-z0-9-]{0,63}$|^[0-9]+(?:\.[0-9]+)+$/)
    const dn = (name: string, fallback?: string) => fallback === undefined ? need(name, /^[^\r\n\0]{1,1024}$/) : optional(name, fallback, /^[^\r\n\0]{1,1024}$/)
    const filter = optional('DSH_LDAP_USER_FILTER', ad ? '(&(objectCategory=person)(objectClass=user))' : '(objectClass=inetOrgPerson)', /^\([^\r\n\0]{1,1022}\)$/)
    let depth = 0
    for (const ch of filter) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; if (depth < 0) break }
    if (depth !== 0) throw new IdentityConfigError('DSH_LDAP_USER_FILTER')
    const timeoutMs = Number(optional('DSH_LDAP_TIMEOUT_MS', '5000', /^[0-9]{3,6}$/))
    if (timeoutMs < 500 || timeoutMs > 60_000) throw new IdentityConfigError('DSH_LDAP_TIMEOUT_MS')
    const baseDn = dn('DSH_LDAP_BASE_DN')
    const groups = need('DSH_SSO_ALLOWED_GROUPS').split(';').map(entry => entry.trim())
    if (groups.some(entry => !/^[^=;\s][^;]*=[^;]+$/.test(entry) || entry.length > 1024)) throw new IdentityConfigError('DSH_SSO_ALLOWED_GROUPS')
    sso = { kind: 'ldap', url: `${url.protocol}//${url.host}`, startTls, ...ca === undefined ? {} : { ca }, bindDn: dn('DSH_LDAP_BIND_DN'), bindPassword: need('DSH_LDAP_BIND_PASSWORD', /^.+$/),
      baseDn, userFilter: filter,
      usernameAttribute: attribute('DSH_LDAP_USERNAME_ATTRIBUTE', ad ? 'sAMAccountName' : 'uid'), idAttribute: attribute('DSH_LDAP_ID_ATTRIBUTE', ad ? 'objectGUID' : 'entryUUID'),
      emailAttribute: attribute('DSH_LDAP_EMAIL_ATTRIBUTE', 'mail'), nameAttribute: attribute('DSH_LDAP_NAME_ATTRIBUTE', ad ? 'displayName' : 'cn'),
      groupMode: optional('DSH_LDAP_GROUP_MODE', 'memberOf', /^(memberOf|nested|search)$/) as 'memberOf' | 'nested' | 'search',
      groupBaseDn: dn('DSH_LDAP_GROUP_BASE_DN', baseDn), groupObjectClass: attribute('DSH_LDAP_GROUP_OBJECT_CLASS', ad ? 'group' : 'groupOfNames'), activeDirectory: ad,
      serverId: optional('DSH_LDAP_SERVER_ID', url.host, /^[\x21-\x7b\x7d\x7e]{1,256}$/), allowedGroups: groups.map(normalizeDn), timeoutMs }
    if (sso.groupMode === 'nested' && !ad) throw new IdentityConfigError('DSH_LDAP_GROUP_MODE')
  } else throw new IdentityConfigError('DSH_SSO_PROVIDER')

  let emergency: EmergencyConfig = { enabled: false }
  if (env.DSH_SSO_EMERGENCY_ALLOWED_IPS !== undefined && env.DSH_SSO_EMERGENCY_ALLOWED_IPS !== '') {
    // The emergency path exists to recover when the IdP is down; without SSO it would be a second password login, so it refuses start.
    if (sso.kind === 'off') throw new IdentityConfigError('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    const value = need('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    const allowedIps = value.split(',').map(entry => entry.trim())
    if (allowedIps.some(entry => !validIpEntry(entry))) throw new IdentityConfigError('DSH_SSO_EMERGENCY_ALLOWED_IPS')
    emergency = { enabled: true, allowedIps }
  }
  return { sso, emergency }
}
