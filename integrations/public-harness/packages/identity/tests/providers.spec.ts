/** CAPTCHA providers and provider configuration: mocked provider HTTP, fail-closed parsing, timeouts and page CSP. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { aliyunConnectSources, createCaptchaProvider } from '../src/captcha.ts'
import { parseProviderEnv, type CaptchaConfig } from '../src/config.ts'
import { contentSecurityPolicy, pageCaptcha, renderPage } from '../src/pages.ts'
import { signAcs3, signTc3 } from '../src/signing.ts'
import { IdentityUnavailableError } from '../src/transports.ts'

type Seen = { url: string; init: RequestInit }
function mockFetch(reply: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  return { seen, fetch: (async (url: string | URL, init: RequestInit = {}) => { const item = { url: String(url), init }; seen.push(item); return reply(item) }) as typeof fetch }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** A provider that never answers until the request is aborted. */
const hanging = (() => mockFetch(({ init }) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
})))

const ALIYUN: CaptchaConfig = { kind: 'aliyun', accessKeyId: 'testAccessKeyId1', accessKeySecret: 'example-secret', sceneId: 'scene123', prefix: 'abc123',
  region: 'cn', endpoint: 'captcha.cn-shanghai.aliyuncs.com', timeoutMs: 500 }
const TENCENT: CaptchaConfig = { kind: 'tencent', secretId: 'testSecretId0001', secretKey: 'example-secret-key', captchaAppId: 199999164, appSecretKey: 'app-secret', timeoutMs: 500 }
const CLOCK = () => Date.UTC(2026, 9, 13, 1, 2, 3)

describe('aliyun captcha', () => {
  it('signs_VerifyIntelligentCaptcha_and_reads_VerifyResult', async () => {
    const mock = mockFetch(() => json({ RequestId: 'r', Success: true, Code: 'Success', Result: { VerifyResult: true, VerifyCode: 'T001' } }))
    const provider = createCaptchaProvider(ALIYUN, { fetch: mock.fetch, clock: CLOCK })
    expect(await provider.verify('eyJjZXJ0aWZ5SWQiOiJ4In0=', '203.0.113.7')).toBe(true)
    const [{ url, init }] = mock.seen as [Seen]
    expect(url).toBe('https://captcha.cn-shanghai.aliyuncs.com/')
    expect(init.method).toBe('POST')
    const body = String(init.body)
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ CaptchaVerifyParam: 'eyJjZXJ0aWZ5SWQiOiJ4In0=', SceneId: 'scene123' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-acs-action']).toBe('VerifyIntelligentCaptcha')
    expect(headers['x-acs-version']).toBe('2023-03-05')
    expect(headers['x-acs-date']).toBe('2026-10-13T01:02:03Z')
    expect(headers['x-acs-content-sha256']).toBe(createHash('sha256').update(body).digest('hex'))
    // Recompute the signature independently from what was sent.
    const { authorization, ...rest } = headers
    expect(authorization).toBe(signAcs3({ method: 'POST', canonicalUri: '/', query: {}, headers: { ...rest, host: 'captcha.cn-shanghai.aliyuncs.com' }, body,
      accessKeyId: 'testAccessKeyId1', accessKeySecret: 'example-secret' }).authorization)
    expect(authorization).toMatch(/SignedHeaders=content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,/)
  })

  it('failed_check_is_false_and_api_errors_are_unavailable', async () => {
    const no = createCaptchaProvider(ALIYUN, { fetch: mockFetch(() => json({ Success: true, Result: { VerifyResult: false, VerifyCode: 'F003' } })).fetch })
    expect(await no.verify('x', '203.0.113.7')).toBe(false)
    expect(await no.verify('', '203.0.113.7')).toBe(false)
    for (const reply of [() => json({ Success: false, Code: 'Forbidden.AccountAccessDenied' }), () => json({ Code: 'InvalidAccessKeyId' }, 403), () => new Response('not json', { status: 200 })]) {
      await expect(createCaptchaProvider(ALIYUN, { fetch: mockFetch(reply).fetch }).verify('x', '203.0.113.7')).rejects.toBeInstanceOf(IdentityUnavailableError)
    }
    await expect(createCaptchaProvider(ALIYUN, { fetch: mockFetch(() => { throw new TypeError('network') }).fetch }).verify('x', '1.1.1.1')).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('times_out_as_unavailable', async () => {
    const started = Date.now()
    await expect(createCaptchaProvider(ALIYUN, { fetch: hanging().fetch }).verify('x', '203.0.113.7')).rejects.toBeInstanceOf(IdentityUnavailableError)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('tencent captcha', () => {
  const response = JSON.stringify({ ticket: 'tr03XaCU', randstr: '@Vki' })
  it('signs_DescribeCaptchaResult_and_reads_CaptchaCode', async () => {
    const mock = mockFetch(() => json({ Response: { CaptchaCode: 1, CaptchaMsg: 'OK', EvilLevel: 0, RequestId: 'r' } }))
    expect(await createCaptchaProvider(TENCENT, { fetch: mock.fetch, clock: CLOCK }).verify(response, '203.0.113.7')).toBe(true)
    const [{ url, init }] = mock.seen as [Seen]
    expect(url).toBe('https://captcha.tencentcloudapi.com/')
    expect(JSON.parse(String(init.body))).toEqual({ CaptchaType: 9, Ticket: 'tr03XaCU', UserIp: '203.0.113.7', Randstr: '@Vki', CaptchaAppId: 199999164, AppSecretKey: 'app-secret' })
    const headers = init.headers as Record<string, string>
    expect(headers).toMatchObject({ 'x-tc-action': 'DescribeCaptchaResult', 'x-tc-version': '2019-07-22', 'x-tc-timestamp': String(Math.floor(CLOCK() / 1000)) })
    const expected = signTc3({ service: 'captcha', host: 'captcha.tencentcloudapi.com', timestamp: Math.floor(CLOCK() / 1000), payload: String(init.body),
      signedHeaders: { 'content-type': 'application/json; charset=utf-8', host: 'captcha.tencentcloudapi.com', 'x-tc-action': 'describecaptcharesult' }, secretId: 'testSecretId0001', secretKey: 'example-secret-key' })
    expect(headers.authorization).toBe(expected.authorization)
    expect(headers.authorization).toContain('Credential=testSecretId0001/2026-10-13/captcha/tc3_request, SignedHeaders=content-type;host;x-tc-action,')
  })

  it('rejected_tickets_are_false_and_errors_unavailable', async () => {
    for (const code of [7, 8, 9, 100]) {
      expect(await createCaptchaProvider(TENCENT, { fetch: mockFetch(() => json({ Response: { CaptchaCode: code, RequestId: 'r' } })).fetch }).verify(response, '1.1.1.1')).toBe(false)
    }
    const never = mockFetch(() => json({}))
    for (const bad of ['', 'not json', '{"ticket":"t"}', JSON.stringify({ ticket: 1, randstr: 'x' })]) expect(await createCaptchaProvider(TENCENT, { fetch: never.fetch }).verify(bad, '1.1.1.1')).toBe(false)
    expect(never.seen).toHaveLength(0)
    await expect(createCaptchaProvider(TENCENT, { fetch: mockFetch(() => json({ Response: { Error: { Code: 'AuthFailure.SignatureFailure' }, RequestId: 'r' } })).fetch })
      .verify(response, '1.1.1.1')).rejects.toBeInstanceOf(IdentityUnavailableError)
    await expect(createCaptchaProvider(TENCENT, { fetch: mockFetch(() => json({ error: 'x' }, 502)).fetch }).verify(response, '1.1.1.1')).rejects.toBeInstanceOf(IdentityUnavailableError)
    await expect(createCaptchaProvider(TENCENT, { fetch: hanging().fetch }).verify(response, '1.1.1.1')).rejects.toBeInstanceOf(IdentityUnavailableError)
  })
})

describe('turnstile and none', () => {
  it('turnstile_posts_siteverify', async () => {
    const mock = mockFetch(() => json({ success: true }))
    const provider = createCaptchaProvider({ kind: 'turnstile', siteKey: 'site', secretKey: 'secret', timeoutMs: 500 }, { fetch: mock.fetch })
    expect(await provider.verify('token', '203.0.113.7')).toBe(true)
    expect(mock.seen[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(Object.fromEntries(mock.seen[0]!.init.body as URLSearchParams)).toEqual({ secret: 'secret', response: 'token', remoteip: '203.0.113.7' })
    await expect(createCaptchaProvider({ kind: 'turnstile', siteKey: 'site', secretKey: 'secret', timeoutMs: 500 }, { fetch: hanging().fetch }).verify('t', '1.1.1.1')).rejects.toBeInstanceOf(IdentityUnavailableError)
  })
  it('none_never_accepts_a_captcha', async () => {
    const provider = createCaptchaProvider({ kind: 'none' })
    expect(provider.invites).toBe(true)
    expect(await provider.verify('anything', '1.1.1.1')).toBe(false)
  })
})

describe('provider environment', () => {
  const mail = { DSH_MAIL_PROVIDER: 'smtp', DSH_SMTP_HOST: 'smtpdm.aliyun.com', DSH_SMTP_PORT: '465', DSH_SMTP_SECURITY: 'tls', DSH_SMTP_USER: 'noreply@mail.example.com',
    DSH_SMTP_PASSWORD: 'hunter2-secret', DSH_MAIL_FROM: 'noreply@mail.example.com' }
  const aliyun = { DSH_CAPTCHA_PROVIDER: 'aliyun', DSH_ALIYUN_CAPTCHA_ACCESS_KEY_ID: 'testAccessKeyId1', DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET: 'very-secret-value',
    DSH_ALIYUN_CAPTCHA_SCENE_ID: 'scene123', DSH_ALIYUN_CAPTCHA_PREFIX: 'abc123' }
  const tencent = { DSH_CAPTCHA_PROVIDER: 'tencent', DSH_TENCENT_CAPTCHA_SECRET_ID: 'testSecretId0001', DSH_TENCENT_CAPTCHA_SECRET_KEY: 'k',
    DSH_TENCENT_CAPTCHA_APP_ID: '199999164', DSH_TENCENT_CAPTCHA_APP_SECRET_KEY: 'a' }

  it('parses_each_provider', () => {
    expect(parseProviderEnv({ ...mail, ...aliyun }, 'production')).toEqual({
      mail: { kind: 'smtp', host: 'smtpdm.aliyun.com', port: 465, security: 'tls', user: 'noreply@mail.example.com', password: 'hunter2-secret', from: 'noreply@mail.example.com', timeoutMs: 15000 },
      captcha: { kind: 'aliyun', accessKeyId: 'testAccessKeyId1', accessKeySecret: 'very-secret-value', sceneId: 'scene123', prefix: 'abc123', region: 'cn', endpoint: 'captcha.cn-shanghai.aliyuncs.com', timeoutMs: 5000 } })
    expect(parseProviderEnv({ ...mail, ...tencent }, 'production').captcha).toMatchObject({ kind: 'tencent', captchaAppId: 199999164 })
    expect(parseProviderEnv({ ...mail, DSH_SMTP_SECURITY: 'starttls', DSH_SMTP_PORT: '80', DSH_CAPTCHA_PROVIDER: 'none' }, 'production')).toMatchObject({ mail: { security: 'starttls', port: 80 }, captcha: { kind: 'none' } })
    expect(parseProviderEnv({ DSH_MAIL_PROVIDER: 'sendmail', DSH_SENDMAIL_COMMAND: '/usr/sbin/sendmail', DSH_MAIL_FROM: 'a@b.example', DSH_CAPTCHA_PROVIDER: 'turnstile',
      DSH_TURNSTILE_SITE_KEY: '0x4AAA', DSH_TURNSTILE_SECRET_KEY: 's' }, 'production').captcha.kind).toBe('turnstile')
    expect(parseProviderEnv({ ...mail, ...aliyun, DSH_ALIYUN_CAPTCHA_REGION: 'sgp', DSH_ALIYUN_CAPTCHA_ENDPOINT: 'captcha-dualstack.ap-southeast-1.aliyuncs.com' }, 'production').captcha)
      .toMatchObject({ region: 'sgp', endpoint: 'captcha-dualstack.ap-southeast-1.aliyuncs.com' })
  })

  it('refuses_unknown_providers_and_missing_secrets_without_echoing_values', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...aliyun }, 'DSH_MAIL_PROVIDER'],
      [{ ...mail, DSH_MAIL_PROVIDER: 'mailgun', ...aliyun }, 'DSH_MAIL_PROVIDER'],
      [{ ...mail }, 'DSH_CAPTCHA_PROVIDER'],
      [{ ...mail, DSH_CAPTCHA_PROVIDER: 'recaptcha' }, 'DSH_CAPTCHA_PROVIDER'],
      [{ ...mail, ...aliyun, DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET: '' }, 'DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET'],
      [{ ...mail, ...aliyun, DSH_ALIYUN_CAPTCHA_REGION: 'us' }, 'DSH_ALIYUN_CAPTCHA_REGION'],
      [{ ...mail, ...aliyun, DSH_ALIYUN_CAPTCHA_ENDPOINT: 'captcha.evil.example' }, 'DSH_ALIYUN_CAPTCHA_ENDPOINT'],
      [{ ...mail, ...aliyun, DSH_ALIYUN_CAPTCHA_ENDPOINT: 'captcha.ap-southeast-1.aliyuncs.com' }, 'DSH_ALIYUN_CAPTCHA_ENDPOINT'],
      [{ ...mail, ...tencent, DSH_TENCENT_CAPTCHA_APP_SECRET_KEY: '' }, 'DSH_TENCENT_CAPTCHA_APP_SECRET_KEY'],
      [{ ...mail, ...tencent, DSH_TENCENT_CAPTCHA_APP_ID: 'abc' }, 'DSH_TENCENT_CAPTCHA_APP_ID'],
      [{ ...mail, DSH_CAPTCHA_PROVIDER: 'turnstile', DSH_TURNSTILE_SITE_KEY: 'k' }, 'DSH_TURNSTILE_SECRET_KEY'],
      [{ ...mail, DSH_SMTP_PASSWORD: '', ...aliyun }, 'DSH_SMTP_PASSWORD'],
      [{ ...mail, DSH_SMTP_SECURITY: 'none', ...aliyun }, 'DSH_SMTP_SECURITY'],
      [{ ...mail, DSH_SMTP_PORT: '70000', ...aliyun }, 'DSH_SMTP_PORT'],
      [{ ...mail, DSH_SMTP_HOST: 'smtp host', ...aliyun }, 'DSH_SMTP_HOST'],
      [{ ...mail, DSH_SMTP_TIMEOUT_MS: '99', ...aliyun }, 'DSH_SMTP_TIMEOUT_MS'],
      [{ ...mail, DSH_SMTP_USER: 'line\nbreak', ...aliyun }, 'DSH_SMTP_USER'],
      [{ ...mail, DSH_CAPTCHA_PROVIDER: 'test', DSH_CAPTCHA_TEST_TOKEN: 'pass-captcha' }, 'test-transport-in-production'],
      [{ DSH_MAIL_PROVIDER: 'mailbox', DSH_MAILBOX_DIR: '/tmp/x', DSH_MAIL_FROM: 'a@b.example', ...aliyun }, 'test-transport-in-production'],
    ]
    for (const [env, field] of cases) {
      let message = ''
      try { parseProviderEnv(env, 'production'); expect.unreachable(field) } catch (error) { message = (error as Error).message }
      expect(message).toBe(`invalid identity configuration: ${field}`)
      for (const secret of ['very-secret-value', 'hunter2-secret']) expect(message).not.toContain(secret)
    }
  })
})

describe('widget pages', () => {
  const page = (config: CaptchaConfig) => {
    const captcha = pageCaptcha(createCaptchaProvider(config))
    return { html: renderPage('zh', 'register', 'n0nce', '', captcha), csp: contentSecurityPolicy('n0nce', captcha) }
  }
  it('renders_the_provider_widget_with_matching_csp_and_no_secrets', () => {
    const ali = page(ALIYUN)
    expect(ali.html).toContain('id="captcha-element"')
    expect(ali.html).toContain('"script":"https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"')
    expect(ali.html).toContain('"prefix":"abc123"')
    expect(ali.html).not.toContain('example-secret')
    expect(ali.html).not.toContain('testAccessKeyId1')
    expect(ali.csp).toContain("script-src 'nonce-n0nce' https://o.alicdn.com")
    expect(ali.csp).toContain('https://abc123.captcha-open.aliyuncs.com')
    expect(ali.csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(ali.csp).not.toContain('*')
    expect(aliyunConnectSources('abc123', 'sgp')).toContain('https://abc123-verify.captcha-open-southeast.aliyuncs.com')

    const tc = page(TENCENT)
    expect(tc.html).toContain('"appId":"199999164"')
    expect(tc.html).not.toContain('app-secret')
    expect(tc.html).not.toContain('example-secret-key')
    expect(tc.csp).toContain('frame-src https://turing.captcha.qcloud.com')
    expect(tc.csp).toContain('https://turing.captcha.qcloud.com')

    const ts = page({ kind: 'turnstile', siteKey: '0x4AAA', secretKey: 'ts-secret', timeoutMs: 500 })
    expect(ts.html).not.toContain('ts-secret')
    expect(ts.csp).toContain("style-src 'nonce-n0nce'")
    expect(ts.csp).toContain('frame-src https://challenges.cloudflare.com')

    const invite = page({ kind: 'none' })
    expect(invite.html).toContain('name="invite"')
    expect(invite.html).toContain('邀请码')
    expect(invite.csp).toBe("default-src 'none'; script-src 'nonce-n0nce'; style-src 'nonce-n0nce'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  })
})
