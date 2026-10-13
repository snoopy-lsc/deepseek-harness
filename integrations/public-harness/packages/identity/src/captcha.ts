/** Human verification providers behind one port. Each provider verifies server-side and describes the browser widget
 * (SDK script, public parameters, CSP sources) that the account pages render. Failures to reach a provider surface as
 * unavailable (503), never as success. */
import { createHash, randomBytes } from 'node:crypto'
import type { CaptchaConfig } from './config.ts'
import { signAcs3, signTc3 } from './signing.ts'
import { IdentityUnavailableError } from './transports.ts'

/** CAPTCHA port: true for a valid response, false for an invalid one; rejects with IdentityUnavailableError when the provider cannot answer. */
export type CaptchaVerifier = (response: string, ip: string) => Promise<boolean>

/** Content-Security-Policy sources a widget needs, per directive. */
export interface WidgetCsp {
  readonly script: readonly string[]
  readonly frame: readonly string[]
  readonly connect: readonly string[]
  readonly img: readonly string[]
  readonly style: readonly string[]
  /** The SDK injects inline styles, so `style-src` must allow them (the page then drops its style nonce). */
  readonly inlineStyle: boolean
}

/** What the account pages render for a widget provider; every value here is public. */
export interface CaptchaWidget {
  readonly provider: 'turnstile' | 'aliyun' | 'tencent'
  /** SDK URL, loaded dynamically by the page script. */
  readonly script: string
  /** Public parameters embedded as JSON (site key, scene ID, app ID). */
  readonly params: Readonly<Record<string, string | number>>
  readonly csp: WidgetCsp
}

/** One configured human verification mode. */
export interface CaptchaProvider {
  readonly kind: CaptchaConfig['kind']
  /** Browser widget; absent for `none` (invite code instead) and `test`. */
  readonly widget?: CaptchaWidget
  /** Registration requires a single-use invite code instead of a CAPTCHA. */
  readonly invites: boolean
  readonly verify: CaptchaVerifier
}

const MAX_RESPONSE = 4096

async function post(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let result: Response
  try { result = await fetchImpl(url, { ...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }) } catch { throw new IdentityUnavailableError('captcha') }
  let body: unknown
  try { body = await result.json() } catch { throw new IdentityUnavailableError('captcha') }
  if (!result.ok) throw new IdentityUnavailableError('captcha')
  return body
}
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Cloudflare Turnstile siteverify (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
function turnstile(config: Extract<CaptchaConfig, { kind: 'turnstile' }>, fetchImpl: typeof fetch): CaptchaProvider {
  return {
    kind: 'turnstile', invites: false,
    widget: { provider: 'turnstile', script: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', params: { siteKey: config.siteKey },
      csp: { script: ['https://challenges.cloudflare.com'], frame: ['https://challenges.cloudflare.com'], connect: [], img: [], style: [], inlineStyle: false } },
    async verify(response, ip) {
      if (!response || response.length > 2048) return false
      const body = record(await post(fetchImpl, 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { body: new URLSearchParams({ secret: config.secretKey, response, remoteip: ip }) }, config.timeoutMs))
      return body?.success === true
    },
  }
}

/** Browser API hosts for one Alibaba Cloud Captcha instance, from the documented allowlist (Q11 of the client FAQ); `prefix` is the instance identity.
 * @param prefix Instance identity (身份标).
 * @param region Client region.
 * @returns `connect-src` sources.
 */
export function aliyunConnectSources(prefix: string, region: 'cn' | 'sgp'): string[] {
  const families = region === 'cn' ? ['captcha-open', 'captcha-open-dual'] : ['captcha-open-southeast', 'captcha-open-southeast-dual', 'captcha-open-ga-web']
  const device = region === 'cn' ? ['cloudauth-device.aliyuncs.com', 'cn-shanghai.device.saf.aliyuncs.com', 'cloudauth-device-dualstack.cn-shanghai.aliyuncs.com']
    : ['cloudauth-device.ap-southeast-1.aliyuncs.com', 'ap-southeast-1.device.saf.aliyuncs.com', 'ap-southeast-1-ga.device.saf.aliyuncs.com', 'cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com']
  const hosts = families.flatMap(family => [family, `${family}-b`]).flatMap(family => [`${prefix}.${family}.aliyuncs.com`, `${prefix}-verify.${family}.aliyuncs.com`, `upload.${family}.aliyuncs.com`])
  return [...new Set([...hosts, ...device])].map(host => `https://${host}`)
}

/** Alibaba Cloud Captcha 2.0 `VerifyIntelligentCaptcha` (API version 2023-03-05), signed with ACS3-HMAC-SHA256.
 * Server API: https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access
 * Web client (V3 architecture): https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/new-architecture-for-web-and-h5-client-access
 * CSP sources: https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/captcha-2-0-client-access-faq */
function aliyun(config: Extract<CaptchaConfig, { kind: 'aliyun' }>, fetchImpl: typeof fetch, clock: () => number): CaptchaProvider {
  return {
    kind: 'aliyun', invites: false,
    widget: { provider: 'aliyun', script: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
      params: { sceneId: config.sceneId, prefix: config.prefix, region: config.region },
      csp: { script: ['https://o.alicdn.com', 'https://g.alicdn.com', 'https://x.alicdn.com'], frame: [],
        connect: aliyunConnectSources(config.prefix, config.region),
        img: ['https://o.alicdn.com', 'https://g.alicdn.com', 'https://static-captcha.aliyuncs.com', 'https://static-captcha-sgp.aliyuncs.com', 'data:'],
        style: ['https://o.alicdn.com', 'https://g.alicdn.com'], inlineStyle: true } },
    async verify(response) {
      if (!response || response.length > MAX_RESPONSE) return false
      // The client value is passed through unmodified, as the API requires; SceneId pins the server-side scene.
      const body = new URLSearchParams({ CaptchaVerifyParam: response, SceneId: config.sceneId }).toString()
      const headers: Record<string, string> = {
        host: config.endpoint, 'content-type': 'application/x-www-form-urlencoded', 'x-acs-action': 'VerifyIntelligentCaptcha', 'x-acs-version': '2023-03-05',
        'x-acs-date': new Date(clock()).toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': randomBytes(16).toString('hex'),
        'x-acs-content-sha256': createHash('sha256').update(body).digest('hex'),
      }
      const { authorization } = signAcs3({ method: 'POST', canonicalUri: '/', query: {}, headers, body, accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret })
      const { host: _host, ...sent } = headers
      const reply = record(await post(fetchImpl, `https://${config.endpoint}/`, { headers: { ...sent, authorization }, body }, config.timeoutMs))
      // An API-level error (bad signature, unpaid instance) is an outage, not a failed human check.
      if (reply?.Success !== true) throw new IdentityUnavailableError('captcha')
      return record(reply.Result)?.VerifyResult === true
    },
  }
}

/** Tencent Cloud TianYu Captcha `DescribeCaptchaResult` (API version 2019-07-22), signed with TC3-HMAC-SHA256.
 * Server API: https://cloud.tencent.com/document/product/1110/36926
 * Web client and CSP: https://cloud.tencent.com/document/product/1110/36841, https://cloud.tencent.com/document/product/1110/36828
 * The browser sends `{"ticket":…,"randstr":…}` from the SDK callback as the CAPTCHA response. */
function tencent(config: Extract<CaptchaConfig, { kind: 'tencent' }>, fetchImpl: typeof fetch, clock: () => number): CaptchaProvider {
  const host = 'captcha.tencentcloudapi.com'
  return {
    kind: 'tencent', invites: false,
    widget: { provider: 'tencent', script: 'https://turing.captcha.qcloud.com/TJCaptcha.js', params: { appId: String(config.captchaAppId) },
      csp: { script: ['https://turing.captcha.qcloud.com', 'https://turing.captcha.gtimg.com'], frame: ['https://turing.captcha.qcloud.com'],
        connect: ['https://turing.captcha.qcloud.com'], img: ['https://turing.captcha.qcloud.com', 'https://turing.captcha.gtimg.com', 'data:'],
        style: ['https://turing.captcha.qcloud.com', 'https://turing.captcha.gtimg.com'], inlineStyle: true } },
    async verify(response, ip) {
      if (!response || response.length > MAX_RESPONSE) return false
      let ticket: unknown, randstr: unknown
      try { ({ ticket, randstr } = JSON.parse(response) as { ticket?: unknown; randstr?: unknown }) } catch { return false }
      if (typeof ticket !== 'string' || typeof randstr !== 'string' || !ticket || !randstr || ticket.length > 2048 || randstr.length > 128) return false
      const payload = JSON.stringify({ CaptchaType: 9, Ticket: ticket, UserIp: ip, Randstr: randstr, CaptchaAppId: config.captchaAppId, AppSecretKey: config.appSecretKey })
      const timestamp = Math.floor(clock() / 1000)
      const signed = { 'content-type': 'application/json; charset=utf-8', host, 'x-tc-action': 'describecaptcharesult' }
      const { authorization } = signTc3({ service: 'captcha', host, timestamp, payload, signedHeaders: signed, secretId: config.secretId, secretKey: config.secretKey })
      const reply = record(await post(fetchImpl, `https://${host}/`, { headers: { 'content-type': signed['content-type'], authorization,
        'x-tc-action': 'DescribeCaptchaResult', 'x-tc-version': '2019-07-22', 'x-tc-timestamp': String(timestamp) }, body: payload }, config.timeoutMs))
      const inner = record(reply?.Response)
      if (inner === undefined || inner.Error !== undefined) throw new IdentityUnavailableError('captcha')
      // CaptchaCode 1 is the only pass; 7/8/9/… are a wrong, expired or reused ticket.
      return inner.CaptchaCode === 1
    },
  }
}

/** Build the configured provider.
 * @param config CAPTCHA settings.
 * @param deps Injected fetch and clock for tests.
 * @returns Provider.
 */
export function createCaptchaProvider(config: CaptchaConfig, deps: { fetch?: typeof fetch; clock?: () => number } = {}): CaptchaProvider {
  const fetchImpl = deps.fetch ?? fetch, clock = deps.clock ?? Date.now
  switch (config.kind) {
    case 'turnstile': return turnstile(config, fetchImpl)
    case 'aliyun': return aliyun(config, fetchImpl, clock)
    case 'tencent': return tencent(config, fetchImpl, clock)
    // Invite-only: no CAPTCHA is ever accepted; registration is gated by the invite code instead.
    case 'none': return { kind: 'none', invites: true, verify: async () => false }
    case 'test': { const token = config.acceptToken; return { kind: 'test', invites: false, verify: async response => response === token } }
  }
}
