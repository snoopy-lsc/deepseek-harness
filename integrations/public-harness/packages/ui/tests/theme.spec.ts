import { describe, expect, it } from 'vitest'
import { glassStylesheet, installTheme, THEME_SOURCE, themeTokens, type StyleHost, type ThemeOverrides } from '../src/client/theme.ts'
import { COLORS, DESKTOP, MATERIALS } from '../src/theme/palette.ts'

const hex = (value: string) => {
  const s = value.replace('#', '')
  const n = s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1
  return { rgb: [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)), a: n }
}
const over = (top: string, bottom: string) => {
  const t = hex(top), b = hex(bottom)
  return `#${t.rgb.map((c, i) => Math.round(c * t.a + b.rgb[i]! * (1 - t.a)).toString(16).padStart(2, '0')).join('')}`
}
const luminance = (value: string) => {
  const [r, g, b] = hex(value).rgb.map(c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

describe('team-enterprise theme', () => {
  it('overrides only Harness tokens and gives every token a light and a dark value', () => {
    const tokens = themeTokens()
    for (const [name, pair] of Object.entries(tokens)) {
      expect(name).toMatch(/^--(dsw|dsh)-/)
      expect(typeof pair.light).toBe('string'); expect(typeof pair.dark).toBe('string')
    }
    expect(tokens['--dsw-specific-sidebar-fill']).toEqual({ light: 'var(--team-specific-sidebar-fill)', dark: 'var(--team-specific-sidebar-fill)' })
    expect(Object.keys(tokens).some(name => /radius|size|font|spacing/.test(name))).toBe(false)
  })

  it('selects only stable attributes and turns glass solid when transparency is reduced', () => {
    const css = glassStylesheet()
    expect(css).not.toMatch(/\.[A-Za-z0-9-]*_[A-Za-z0-9]/)
    expect(css).not.toMatch(/\.[A-Za-z][\w-]*\s*[{,]/)
    expect(css).toContain('[data-slot="sidebar"]')
    expect(css).toContain('[data-composer-card]')
    // Browsers drop a whole rule whose :has() is nested inside another :has().
    expect(css).not.toMatch(/:has\([^{}]*:has\(/)
    expect(css).toContain('div:has(> [data-shell-overlay]){background:transparent}')
    // The sidebar shell paints its own fill inside the column; only the column carries the glass, so the inner layer is cleared.
    expect(css).toContain('[data-slot="sidebar"] > *{--dsw-specific-sidebar-fill:transparent;background:transparent}')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(reduced).toContain('--team-blur:none')
    for (const [token, material] of Object.entries(MATERIALS)) expect(reduced).toContain(`${token.replace(/^--dsw-/, '--team-')}:${material.solid.light};`)
    expect(css).not.toMatch(/https?:|url\(/)
  })

  it('widens_only_dialogs_that_mark_their_body_wide_and_lets_them_scroll', () => {
    const css = glassStylesheet()
    // Same mechanism as upstream's wider dialogs (a width on the dialog box), keyed on a data attribute in the body.
    expect(css).toContain('[role="dialog"][aria-modal="true"]:has([data-team-wide="m"]){width:min(560px,100%);max-height:calc(100% - 48px);overflow-y:auto}')
    expect(css).toContain('[role="dialog"][aria-modal="true"]:has([data-team-wide="l"]){width:min(760px,100%);max-height:calc(100% - 48px);overflow-y:auto}')
  })

  it('registers the token layer and mounts the stylesheet for exactly the plugin lifetime', () => {
    const disposers: Array<() => void> = [], calls: string[] = []
    const theme: ThemeOverrides = { overrideTokens(source) { calls.push(source); return () => { calls.push('released') } } }
    const head: unknown[] = []
    const host: StyleHost = { head: { appendChild: node => head.push(node) }, createElement: () => {
      const tag = { dataset: {} as Record<string, string>, textContent: null as string | null, remove() { head.splice(head.indexOf(tag), 1) } }
      return tag
    } }
    installTheme({ effect: fn => { disposers.push(fn()) }, get: () => theme }, host)
    expect(calls).toEqual([THEME_SOURCE])
    expect(head).toHaveLength(1)
    expect(head[0]).toMatchObject({ dataset: { plugin: '@public-harness/ui' } })
    for (const dispose of disposers) dispose()
    expect(calls).toEqual([THEME_SOURCE, 'released'])
    expect(head).toHaveLength(0)
  })

  it('keeps WCAG AA text contrast on every glass surface over the worst desktop colour', () => {
    const labels = ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption'] as const
    for (const scheme of ['light', 'dark'] as const) {
      const base = (token: string) => MATERIALS[token]!.glass[scheme]
      const ink = COLORS['--dsw-alias-label-primary']![scheme]
      const surfaces: string[] = []
      for (const field of DESKTOP[scheme]) {
        const reading = over(base('--dsw-alias-bg-base'), field)
        surfaces.push(over(base('--dsw-specific-sidebar-fill'), field), reading)
        // Menus and the composer sit over blurred text: about 15% ink coverage on the reading surface.
        const blurred = over(`${ink}26`, reading)
        for (const token of ['--dsw-specific-menu', '--dsw-specific-input-major', '--dsw-alias-settings-card-fill']) surfaces.push(over(base(token), blurred))
      }
      for (const surface of surfaces) for (const label of labels) expect(contrast(COLORS[label]![scheme], surface), `${scheme} ${label} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      const fill = COLORS['--dsw-alias-button-primary-fill']![scheme]
      expect(contrast(COLORS['--dsw-alias-label-primary-foreground']![scheme], fill)).toBeGreaterThanOrEqual(4.5)
      for (const field of DESKTOP[scheme]) expect(contrast(COLORS['--dsw-alias-state-business-primary']![scheme], over(base('--dsw-alias-bg-base'), field))).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps_AA_contrast_on_the_identity_glass_card', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const field of DESKTOP[scheme]) {
        const card = over(MATERIALS['--dsw-alias-settings-card-fill']!.glass[scheme], field)
        for (const token of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-link']) {
          expect(contrast(COLORS[token]![scheme], card), `${scheme} ${token}`).toBeGreaterThanOrEqual(4.5)
        }
        const alert = over(scheme === 'light' ? '#c4372f0d' : '#f27a7214', card)
        expect(contrast(COLORS['--dsw-alias-state-error-primary']![scheme], alert), `${scheme} error`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(COLORS['--dsw-alias-state-success-primary']![scheme], card), `${scheme} status`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
