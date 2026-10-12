/** Strict identity service configuration; production rejects test transports and non-HTTPS origins. */
import { isAbsolute, normalize } from 'node:path'

/** Mail delivery: a local sendmail-compatible command in production, a file mailbox only in local mode. */
export type MailConfig = { kind: 'sendmail'; command: string; from: string } | { kind: 'mailbox'; dir: string; from: string }
/** CAPTCHA verification: Cloudflare Turnstile in production, a fixed token only in local mode. */
export type CaptchaConfig = { kind: 'turnstile'; secretFile: string } | { kind: 'test'; acceptToken: string }

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
  readonly mail: MailConfig
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

/** Parse identity configuration.
 * @param value Untrusted configuration value.
 * @returns Validated configuration.
 */
export function parseIdentityConfig(value: unknown): IdentityConfig {
  const r = object(value, ['mode', 'publicOrigin', 'publicSocket', 'sessionSocket', 'sessionSocketGid', 'databaseFile', 'secretFile', 'mail', 'captcha',
    'limits', 'sessionTtlSeconds', 'verificationTtlSeconds', 'clientIpHeader'], ['enrollmentOpen'], 'fields')
  if (r.mode !== 'production' && r.mode !== 'local') throw new IdentityConfigError('mode')
  const mode = r.mode
  let origin: URL
  try { origin = new URL(text(r.publicOrigin, 'publicOrigin', /^https?:\/\/[^/]+$/)) } catch { throw new IdentityConfigError('publicOrigin') }
  if (origin.origin !== r.publicOrigin) throw new IdentityConfigError('publicOrigin')
  const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost'
  if (mode === 'production' ? origin.protocol !== 'https:' : !loopback) throw new IdentityConfigError('publicOrigin')
  const m = r.mail as Record<string, unknown> | null
  const mail: MailConfig = m?.kind === 'sendmail'
    ? (() => { const v = object(m, ['kind', 'command', 'from'], [], 'mail'); return { kind: 'sendmail' as const, command: path(v.command, 'mail.command'), from: text(v.from, 'mail.from', /^[^\s<>@]+@[^\s<>@]+$/) } })()
    : m?.kind === 'mailbox' ? (() => { const v = object(m, ['kind', 'dir', 'from'], [], 'mail'); return { kind: 'mailbox' as const, dir: path(v.dir, 'mail.dir'), from: text(v.from, 'mail.from', /^[^\s<>@]+@[^\s<>@]+$/) } })()
      : (() => { throw new IdentityConfigError('mail') })()
  const c = r.captcha as Record<string, unknown> | null
  const captcha: CaptchaConfig = c?.kind === 'turnstile'
    ? { kind: 'turnstile', secretFile: path(object(c, ['kind', 'secretFile'], [], 'captcha').secretFile, 'captcha.secretFile') }
    : c?.kind === 'test' ? { kind: 'test', acceptToken: text(object(c, ['kind', 'acceptToken'], [], 'captcha').acceptToken, 'captcha.acceptToken', /^\S{8,}$/) }
      : (() => { throw new IdentityConfigError('captcha') })()
  // Test transports deliver no real mail and accept a fixed CAPTCHA; production must never accept them.
  if (mode === 'production' && (mail.kind === 'mailbox' || captcha.kind === 'test')) throw new IdentityConfigError('test-transport-in-production')
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
