import { describe, expect, it } from 'vitest'
import { parseUserId } from '@public-harness/contracts'
import { escapeHtml, pickLocale, renderPage, safeReturnPath, ssoErrorText, text } from '../src/pages.ts'

describe('account pages', () => {
  it('return_path_cannot_leave_owner_route', () => {
    const alice = parseUserId('alice')
    expect(safeReturnPath('/u/alice/', alice)).toBe('/u/alice/')
    expect(safeReturnPath('/account/', alice)).toBe('/account/')
    for (const hostile of ['https://evil.example/', '//evil.example/', '/u/bob/', '/u/alice/../bob/', '%2F%2Fevil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect(safeReturnPath(hostile, alice)).toBe('/u/alice/')
    }
  })

  it('password_and_emergency_sign_in_land_in_the_users_own_chat', () => {
    const page = renderPage('zh', 'login', 'n0nce')
    expect(page).not.toContain("location.assign('/account/?return=")
    expect(page).not.toContain("location.assign('/account/')}")
    expect(page).toContain("location.assign(home(r))")
    // Only the account page or the user's own route are accepted from `return`; everything else falls back to the chat.
    expect(page).toContain("w==='/account/'||w===own?w:own")
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
    expect(zh).toContain('href="/account/register"')
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
