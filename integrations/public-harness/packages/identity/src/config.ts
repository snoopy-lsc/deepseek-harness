/** Strict identity service configuration; production rejects test transports and non-HTTPS origins. */
import { isAbsolute, normalize } from 'node:path'

/** Mail delivery, chosen by `DSH_MAIL_PROVIDER`: a local sendmail command, an authenticated TLS SMTP relay, or a file mailbox (local mode only). */
export type MailConfig =
  | { kind: 'sendmail'; command: string; from: string }
  | { kind: 'smtp'; host: string; port: number; security: 'tls' | 'starttls'; user: string; password: string; from: string; timeoutMs: number }
  | { kind: 'mailbox'; dir: string; from: string }
/** Human verification, chosen by `DSH_CAPTCHA_PROVIDER`. `none` replaces the CAPTCHA with operator-minted invite codes; `test` accepts a fixed token in local mode only. */
export type CaptchaConfig =
  | { kind: 'turnstile'; siteKey: string; secretKey: string; timeoutMs: number }
  | { kind: 'aliyun'; accessKeyId: string; accessKeySecret: string; sceneId: string; prefix: string; region: 'cn' | 'sgp'; endpoint: string; timeoutMs: number }
  | { kind: 'tencent'; secretId: string; secretKey: string; captchaAppId: number; appSecretKey: string; timeoutMs: number }
  | { kind: 'none' }
  | { kind: 'test'; acceptToken: string }

/** Environment variables read for providers; secrets live only in the service environment, never in the configuration file. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>

/** Validated identity settings. */
export interface IdentityConfig {
  readonly mode: 'production' | 'local'
  /** Exact browser origin; cookies are host-only and every state change must carry this Origin. */
  readonly publicOrigin: string
  /** Unix socket the HTTPS proxy forwards `/api/auth/*` and `/account/*` to. */
  readonly publicSocket: string
  /** Private Unix socket for router session lookups; never proxied. */
  readonly sessionSocket: string
  /** Group allowed to connect to `sessionSocket` (the router's group). */
  readonly sessionSocketGid: number
  readonly databaseFile: string
  /** Root-owned file holding the Better Auth secret (at least 32 characters); never logged. */
  readonly secretFile: string
  /** From the environment (`DSH_MAIL_*`); never from the configuration file. */
  readonly mail: MailConfig
  /** From the environment (`DSH_CAPTCHA_*`); never from the configuration file. */
  readonly captcha: CaptchaConfig
  /** Persistent admission limits; counters live in the database and survive restarts. */
  readonly limits: { readonly signupPerIpPerHour: number; readonly signupPerDay: number; readonly resetPerEmailPerHour: number; readonly loginPerIpPerMinute: number }
  readonly sessionTtlSeconds: number
  readonly verificationTtlSeconds: number
  /** Header the trusted proxy sets to the client address; its last value is used. */
  readonly clientIpHeader: string
  /** Public enrollment switch; closed unless an operator opens it. */
  readonly enrollmentOpen: boolean
}

/** Configuration rejected before any effect; the message names the field, never a value. */
export class IdentityConfigError extends Error {
  override readonly name = 'IdentityConfigError'
  constructor(readonly field: string) { super(`invalid identity configuration: ${field}`) }
}

function object(value: unknown, keys: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IdentityConfigError(field)
  const record = value as Record<string, unknown>
  if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) throw new IdentityConfigError(field)
  return record
}
function path(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0') || value === '/') throw new IdentityConfigError(field)
  return value
}
function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new IdentityConfigError(field)
  return value
}
function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new IdentityConfigError(field)
  return value
}

const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** Alibaba Cloud Captcha 2.0 verification endpoints per client region (https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access). */
export const ALIYUN_CAPTCHA_ENDPOINTS = {
  cn: ['captcha.cn-shanghai.aliyuncs.com', 'captcha-dualstack.cn-shanghai.aliyuncs.com', 'captcha-vpc.cn-shanghai.aliyuncs.com'],
  sgp: ['captcha.ap-southeast-1.aliyuncs.com', 'captcha-dualstack.ap-southeast-1.aliyuncs.com', 'captcha-vpc.ap-southeast-1.aliyuncs.com'],
} as const

/** Parse provider settings from the environment; an unknown provider or a missing secret refuses startup.
 * Errors name the variable, never its value.
 * @param env Process environment.
 * @param mode Service mode; production refuses the local-only `mailbox` and `test` providers.
 * @returns Mail and CAPTCHA settings.
 */
export function parseProviderEnv(env: ProviderEnv, mode: 'production' | 'local'): { mail: MailConfig; captcha: CaptchaConfig } {
  const need = (name: string, pattern: RegExp = /^\S(?:.*\S)?$/): string => {
    const value = env[name]
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value) || !pattern.test(value)) throw new IdentityConfigError(name)
    return value
  }
  const optional = (name: string, fallback: string, pattern?: RegExp) => env[name] === undefined || env[name] === '' ? fallback : need(name, pattern)
  const timeout = (name: string, fallback: number) => {
    const value = Number(optional(name, String(fallback), /^[0-9]{3,6}$/))
    if (value < 500 || value > 60_000) throw new IdentityConfigError(name)
    return value
  }
  const mailKind = env.DSH_MAIL_PROVIDER
  let mail: MailConfig
  if (mailKind === 'sendmail') mail = { kind: 'sendmail', command: path(need('DSH_SENDMAIL_COMMAND'), 'DSH_SENDMAIL_COMMAND'), from: need('DSH_MAIL_FROM', EMAIL) }
  else if (mailKind === 'smtp') {
    const port = Number(need('DSH_SMTP_PORT', /^[0-9]{1,5}$/))
    if (port < 1 || port > 65535) throw new IdentityConfigError('DSH_SMTP_PORT')
    const security = need('DSH_SMTP_SECURITY', /^(tls|starttls)$/) as 'tls' | 'starttls'
    mail = { kind: 'smtp', host: need('DSH_SMTP_HOST', HOSTNAME), port, security, user: need('DSH_SMTP_USER'), password: need('DSH_SMTP_PASSWORD', /^.+$/),
      from: need('DSH_MAIL_FROM', EMAIL), timeoutMs: timeout('DSH_SMTP_TIMEOUT_MS', 15_000) }
  } else if (mailKind === 'mailbox') mail = { kind: 'mailbox', dir: path(need('DSH_MAILBOX_DIR'), 'DSH_MAILBOX_DIR'), from: need('DSH_MAIL_FROM', EMAIL) }
  else throw new IdentityConfigError('DSH_MAIL_PROVIDER')

  const captchaKind = env.DSH_CAPTCHA_PROVIDER
  const captchaTimeout = () => timeout('DSH_CAPTCHA_TIMEOUT_MS', 5000)
  let captcha: CaptchaConfig
  if (captchaKind === 'turnstile') captcha = { kind: 'turnstile', siteKey: need('DSH_TURNSTILE_SITE_KEY', /^[A-Za-z0-9_-]{1,128}$/), secretKey: need('DSH_TURNSTILE_SECRET_KEY'), timeoutMs: captchaTimeout() }
  else if (captchaKind === 'aliyun') {
    const region = optional('DSH_ALIYUN_CAPTCHA_REGION', 'cn', /^(cn|sgp)$/) as 'cn' | 'sgp'
    const endpoint = optional('DSH_ALIYUN_CAPTCHA_ENDPOINT', ALIYUN_CAPTCHA_ENDPOINTS[region][0])
    if (!(ALIYUN_CAPTCHA_ENDPOINTS[region] as readonly string[]).includes(endpoint)) throw new IdentityConfigError('DSH_ALIYUN_CAPTCHA_ENDPOINT')
    captcha = { kind: 'aliyun', accessKeyId: need('DSH_ALIYUN_CAPTCHA_ACCESS_KEY_ID', /^[A-Za-z0-9]{8,128}$/), accessKeySecret: need('DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET'),
      sceneId: need('DSH_ALIYUN_CAPTCHA_SCENE_ID', /^[A-Za-z0-9]{1,64}$/), prefix: need('DSH_ALIYUN_CAPTCHA_PREFIX', /^[A-Za-z0-9]{1,64}$/), region, endpoint, timeoutMs: captchaTimeout() }
  } else if (captchaKind === 'tencent') {
    captcha = { kind: 'tencent', secretId: need('DSH_TENCENT_CAPTCHA_SECRET_ID', /^[A-Za-z0-9]{8,128}$/), secretKey: need('DSH_TENCENT_CAPTCHA_SECRET_KEY'),
      captchaAppId: Number(need('DSH_TENCENT_CAPTCHA_APP_ID', /^[1-9][0-9]{0,11}$/)), appSecretKey: need('DSH_TENCENT_CAPTCHA_APP_SECRET_KEY'), timeoutMs: captchaTimeout() }
  } else if (captchaKind === 'none') captcha = { kind: 'none' }
  else if (captchaKind === 'test') captcha = { kind: 'test', acceptToken: need('DSH_CAPTCHA_TEST_TOKEN', /^\S{8,}$/) }
  else throw new IdentityConfigError('DSH_CAPTCHA_PROVIDER')
  // Test transports deliver no real mail and accept a fixed CAPTCHA; production must never accept them.
  if (mode === 'production' && (mail.kind === 'mailbox' || captcha.kind === 'test')) throw new IdentityConfigError('test-transport-in-production')
  return { mail, captcha }
}

/** Parse identity configuration: topology and limits from the file, providers and their secrets from the environment.
 * @param value Untrusted configuration value (the JSON file); `mail` and `captcha` keys are refused there.
 * @param env Process environment holding `DSH_MAIL_*` and `DSH_CAPTCHA_*`.
 * @returns Validated configuration.
 */
export function parseIdentityConfig(value: unknown, env: ProviderEnv = process.env): IdentityConfig {
  const r = object(value, ['mode', 'publicOrigin', 'publicSocket', 'sessionSocket', 'sessionSocketGid', 'databaseFile', 'secretFile',
    'limits', 'sessionTtlSeconds', 'verificationTtlSeconds', 'clientIpHeader'], ['enrollmentOpen'], 'fields')
  if (r.mode !== 'production' && r.mode !== 'local') throw new IdentityConfigError('mode')
  const mode = r.mode
  let origin: URL
  try { origin = new URL(text(r.publicOrigin, 'publicOrigin', /^https?:\/\/[^/]+$/)) } catch { throw new IdentityConfigError('publicOrigin') }
  if (origin.origin !== r.publicOrigin) throw new IdentityConfigError('publicOrigin')
  const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost'
  if (mode === 'production' ? origin.protocol !== 'https:' : !loopback) throw new IdentityConfigError('publicOrigin')
  const { mail, captcha } = parseProviderEnv(env, mode)
  const l = object(r.limits, ['signupPerIpPerHour', 'signupPerDay', 'resetPerEmailPerHour', 'loginPerIpPerMinute'], [], 'limits')
  if (r.enrollmentOpen !== undefined && typeof r.enrollmentOpen !== 'boolean') throw new IdentityConfigError('enrollmentOpen')
  const sessionSocketGid = r.sessionSocketGid
  if (typeof sessionSocketGid !== 'number' || !Number.isSafeInteger(sessionSocketGid) || sessionSocketGid < 0) throw new IdentityConfigError('sessionSocketGid')
  return {
    mode, publicOrigin: origin.origin, publicSocket: path(r.publicSocket, 'publicSocket'), sessionSocket: path(r.sessionSocket, 'sessionSocket'), sessionSocketGid,
    databaseFile: path(r.databaseFile, 'databaseFile'), secretFile: path(r.secretFile, 'secretFile'), mail, captcha,
    limits: { signupPerIpPerHour: count(l.signupPerIpPerHour, 'limits'), signupPerDay: count(l.signupPerDay, 'limits'),
      resetPerEmailPerHour: count(l.resetPerEmailPerHour, 'limits'), loginPerIpPerMinute: count(l.loginPerIpPerMinute, 'limits') },
    sessionTtlSeconds: count(r.sessionTtlSeconds, 'sessionTtlSeconds'), verificationTtlSeconds: count(r.verificationTtlSeconds, 'verificationTtlSeconds'),
    clientIpHeader: text(r.clientIpHeader, 'clientIpHeader', /^[a-z][a-z0-9-]{0,63}$/), enrollmentOpen: r.enrollmentOpen === true,
  }
}
