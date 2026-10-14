import { describe, expect, it } from 'vitest'
import { parseUserId } from '@public-harness/contracts'
import { identityStylesheet } from '@public-harness/ui'
import { escapeHtml, pickLocale, renderPage, returnTarget, safeReturnPath, ssoErrorText, text } from '../src/pages.ts'

describe('account pages', () => {
  it('return_path_cannot_leave_owner_route', () => {
    const alice = parseUserId('alice')
    expect(safeReturnPath('/u/alice/', alice)).toBe('/u/alice/')
    expect(safeReturnPath('/account/', alice)).toBe('/account/')
    // Any page under the user's own route keeps its query and fragment.
    expect(safeReturnPath('/u/alice/settings?tab=quota#usage', alice)).toBe('/u/alice/settings?tab=quota#usage')
    expect(safeReturnPath('/u/alice/s/%E4%B8%AD', alice)).toBe('/u/alice/s/%E4%B8%AD')
    for (const hostile of ['https://evil.example/', '//evil.example/', '/u/bob/', '/u/alice/../bob/', '%2F%2Fevil.example', '/\\evil.example', 'javascript:alert(1)',
      '/u/alice/..%2F..%2Fbob/', '/%2F%2Fevil.example', '/%5Cevil.example', '/u/alice/%2e%2e/bob/', '/u/alice/%252e%252e/bob/', '/u/alice//evil', '/u/alice/\\..',
      '/u/alice/\t', '/u/alice/%0d%0aSet-Cookie:x', ' /u/alice/', '/u/alicex/', '/account/login', 'http:/u/alice/', '/u/alice/./x', '/u/alice/%E4%B8', '']) {
      expect(safeReturnPath(hostile, alice), hostile).toBe('/u/alice/')
    }
  })

  it('password_and_emergency_sign_in_land_in_the_users_own_chat', () => {
    const page = renderPage('zh', 'login', 'n0nce')
    expect(page).not.toContain("location.assign('/account/?return=")
    expect(page).not.toContain("location.assign('/account/')}")
    expect(page).toContain("location.assign(home(r))")
    // Only the account page or the user's own route are accepted from `return`; everything else falls back to the chat.
    expect(page).toContain("location.assign(home(r))")
    expect(page).toContain(returnTarget.toString())
  })

  it('pages_share_the_team_theme_inside_the_nonce_bound_style', () => {
    const page = renderPage('en', 'login', 'n0nce')
    const styles = page.match(/<style[^>]*>[^<]*<\/style>/g) ?? []
    expect(styles).toHaveLength(1)
    expect(styles[0]).toContain('<style nonce="n0nce">')
    expect(styles[0]).toContain(identityStylesheet())
    expect(identityStylesheet()).toContain('#2563d9')
    expect(identityStylesheet()).toContain('prefers-color-scheme:dark')
    expect(styles[0]).not.toMatch(/url\(|@import|https?:/)
  })

  it('account_copy_is_localized', () => {
    const zh = renderPage('zh', 'login', 'n0nce'), en = renderPage('en', 'login', 'n0nce')
    expect(zh).toContain('lang="zh-CN"')
    expect(zh).toContain(text('zh', 'login'))
    expect(en).toContain(text('en', 'login'))
    expect(pickLocale(new URL('http://x/?lang=zh'), 'en')).toBe('zh')
    expect(pickLocale(new URL('http://x/'), 'zh-CN,zh;q=0.9')).toBe('zh')
    expect(pickLocale(new URL('http://x/?lang=fr'), undefined)).toBe('en')
    // Server notices are escaped, and the embedded copy cannot close its script element.
    const page = renderPage('en', 'register', 'n0nce', '<img src=x onerror=alert(1)>')
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(page).not.toContain('<img src=x')
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;')
    expect(page.match(/<script nonce="n0nce">/g)).toHaveLength(1)
  })
})

describe('enterprise sign-in card', () => {
  const oidc = { sso: true, emergency: false, registration: false }
  it('company_button_first_then_divider_and_email_form_with_forgot_link', () => {
    const page = renderPage('zh', 'login', 'n0nce', '', { provider: 'none' }, oidc)
    const button = page.indexOf('data-sso-start'), divider = page.indexOf(text('zh', 'orEmail')), email = page.indexOf('name="email"')
    expect(button).toBeGreaterThan(0); expect(divider).toBeGreaterThan(button); expect(email).toBeGreaterThan(divider)
    expect(page).toMatch(/<a [^>]*class="btn primary block"[^>]*data-sso-start/)
    expect(page).toMatch(/<a href="\/account\/reset"[^>]*>忘记密码<\/a>/)
    expect(page).not.toContain('受邀承包商')
    expect(page).toContain('class="brand"')
    expect(page).toMatch(/<header class="top">.*English<\/a><\/header>/s)
  })

  it('create_account_link_only_when_public_registration_is_open', () => {
    expect(renderPage('en', 'login', 'n0nce', '', { provider: 'test' }, { sso: false, emergency: false, registration: false })).not.toContain('href="/account/register"')
    expect(renderPage('en', 'login', 'n0nce', '', { provider: 'test' }, { sso: false, emergency: false, registration: true })).toContain('href="/account/register"')
  })

  it('ldap_form_is_the_primary_action_and_the_layout_uses_harness_control_metrics', () => {
    const page = renderPage('en', 'login', 'n0nce', '', { provider: 'none' }, { sso: true, ldap: true, emergency: false, registration: false })
    expect(page.indexOf('data-action="ldap"')).toBeLessThan(page.indexOf(text('en', 'orEmail')))
    expect(page).toMatch(/data-action="ldap".*?<button type="submit" class="btn primary block">/s)
    const css = page.slice(page.indexOf('<style'), page.indexOf('</style>'))
    // Harness Button md: 36px tall, 12px corners, 14px/22px text; Input: 0.5px stroke and 12px corners.
    expect(css).toContain('.btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:12px;font-size:14px;line-height:22px')
    expect(css).toContain('border:.5px solid')
    expect(css).not.toMatch(/url\(|@import|https?:/)
  })

  it('new_password_step_has_its_own_subtitle', () => {
    for (const locale of ['en', 'zh'] as const) {
      const page = renderPage(locale, 'reset', 'n0nce', '', { provider: 'test' }, { sso: false, emergency: false })
      expect(page).toContain(`<p class="sub" data-step="request">${text(locale, 'resetSub')}</p>`)
      expect(page).toContain(`<p class="sub" data-step="new" hidden>${text(locale, 'newPasswordSub')}</p>`)
    }
  })

  it('every_view_renders_one_card_with_its_own_title', () => {
    for (const view of ['login', 'register', 'reset', 'verified', 'emergency', 'home'] as const) {
      const page = renderPage('zh', view, 'n0nce', '', { provider: 'test' }, { sso: false, emergency: true, registration: true })
      expect(page.match(/<main class="card">/g)).toHaveLength(1)
      expect(page).toMatch(/<h1>[^<]+<\/h1>/)
      expect(page.match(/<script nonce="n0nce">/g)).toHaveLength(1)
    }
  })
})

describe('enterprise SSO pages', () => {
  const sso = { sso: true, emergency: false }
  it('sso_login_offers_the_company_button_and_hides_public_paths', () => {
    const page = renderPage('en', 'login', 'n0nce', '', { provider: 'turnstile', script: 'https://x', params: {}, csp: { script: [], style: [], connect: [], frame: [], img: [] } } as never, sso)
    expect(page).toContain('data-sso-start')
    expect(page).toContain(text('en', 'ssoLogin'))
    expect(page).not.toContain('data-action="login"')
    expect(page).not.toContain('href="/account/register"')
    expect(page).not.toContain('href="/account/reset"')
    expect(page).not.toContain('/account/emergency')
    const zh = renderPage('zh', 'login', 'n0nce', '', { provider: 'none' }, sso)
    expect(zh).toContain(text('zh', 'ssoLogin'))
    // Invited contractors keep the password form and registration.
    expect(zh).toContain('data-action="login"')
    expect(zh).not.toContain('href="/account/register"')
    expect(page.match(/<script nonce="n0nce">/g)).toHaveLength(1)
  })

  it('sso_errors_and_register_notice_are_localized', () => {
    expect(ssoErrorText('zh', 'group')).toBe(text('zh', 'ssoGroup'))
    expect(ssoErrorText('en', 'email-in-use')).toBe(text('en', 'ssoEmailInUse'))
    expect(ssoErrorText('en', 'state')).toBe(text('en', 'ssoRetry'))
    expect(ssoErrorText('en', '<script>')).toBe(text('en', 'ssoFailed'))
    const register = renderPage('en', 'register', 'n0nce', text('en', 'ssoOnly'), { provider: 'test' }, sso)
    expect(register).not.toContain('data-action="register"')
    expect(register).toContain(text('en', 'ssoOnly'))
  })

  it('emergency_page_is_a_separate_unlinked_form', () => {
    const page = renderPage('en', 'emergency', 'n0nce', '', { provider: 'none' }, { sso: true, emergency: true })
    expect(page).toContain('data-action="emergency"')
    expect(page).toContain('name="code"')
    expect(page).toContain('autocomplete="one-time-code"')
    expect(renderPage('en', 'login', 'n0nce', '', { provider: 'none' }, { sso: true, emergency: true })).not.toContain('/account/emergency')
  })
})
