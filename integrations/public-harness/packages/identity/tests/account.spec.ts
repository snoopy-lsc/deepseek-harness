import { describe, expect, it } from 'vitest'
import { parseUserId } from '@public-harness/contracts'
import { escapeHtml, pickLocale, renderPage, safeReturnPath, text } from '../src/pages.ts'

describe('account pages', () => {
  it('return_path_cannot_leave_owner_route', () => {
    const alice = parseUserId('alice')
    expect(safeReturnPath('/u/alice/', alice)).toBe('/u/alice/')
    expect(safeReturnPath('/account/', alice)).toBe('/account/')
    for (const hostile of ['https://evil.example/', '//evil.example/', '/u/bob/', '/u/alice/../bob/', '%2F%2Fevil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect(safeReturnPath(hostile, alice)).toBe('/u/alice/')
    }
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
