/** The `team-enterprise` palette: one source for the Harness Web theme layer and the identity pages. */

/** One value per Harness base palette. */
export interface Pair { readonly light: string; readonly dark: string }

/** Opaque `--dsw-*` overrides (colours, elevation and the menu filter); the names are Harness theme tokens. */
export const COLORS: Readonly<Record<string, Pair>> = {
  '--dsw-alias-label-primary': { light: '#1d2025', dark: '#eceef1' },
  '--dsw-alias-label-primary-dimmed': { light: '#23272d', dark: '#e2e5e9' },
  '--dsw-alias-label-primary-bluish': { light: '#1b2f57', dark: '#eceef1' },
  '--dsw-alias-brand-primary': { light: '#1d2025', dark: '#eceef1' },
  '--dsw-alias-brand-text': { light: '#1d2025', dark: '#eceef1' },
  '--dsw-alias-label-secondary': { light: '#454a52', dark: '#b9bec6' },
  '--dsw-alias-label-document-preview': { light: '#454a52', dark: '#b9bec6' },
  '--dsw-alias-label-tertiary': { light: '#5f656e', dark: '#9aa0a9' },
  // Caption equals tertiary: the lighter original grey falls below 4.5:1 on glass.
  '--dsw-alias-label-caption': { light: '#5f656e', dark: '#9aa0a9' },
  '--dsw-alias-menu-icon': { light: '#3a3f46', dark: '#d5d9de' },
  '--dsw-alias-link': { light: '#1b4fb5', dark: '#8db3f7' },
  '--dsw-alias-state-business-primary': { light: '#2563d9', dark: '#6b9cf5' },
  '--dsw-alias-state-business-tertiary': { light: '#e3ebfa', dark: '#263552' },
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#2563d9', dark: '#6b9cf5' },
  '--dsw-alias-button-info-fill': { light: '#2563d9', dark: '#6b9cf5' },
  '--dsw-alias-button-info-hover': { light: '#1b4fb5', dark: '#8db3f7' },
  '--dsw-alias-button-primary-fill': { light: '#2563d9', dark: '#6b9cf5' },
  '--dsw-alias-button-primary-hover': { light: '#1b4fb5', dark: '#8db3f7' },
  '--dsw-alias-label-primary-foreground': { light: '#ffffff', dark: '#0f1520' },
  '--dsw-alias-button-primary-dimmed': { light: '#e3ebfa', dark: '#2f3b52' },
  '--dsw-alias-button-contrast-fill': { light: '#454a52', dark: '#d5d9de' },
  '--dsw-alias-label-deep-diving': { light: '#1b4fb5', dark: '#8db3f7' },
  '--dsw-focus-ring-color': { light: '#2563d9', dark: '#6b9cf5' },
  '--dsh-boot-bg': { light: '#fbfcfd', dark: '#17191c' },
  '--dsw-alias-bg-layer-1': { light: '#fbfcfd', dark: '#1d1f23' },
  '--dsw-alias-bg-module-platform': { light: '#eef1f5', dark: '#2a2d32' },
  '--dsw-alias-markdown-code-block': { light: '#f4f6f9', dark: '#1f2226' },
  '--dsw-alias-markdown-code-block-banner': { light: '#f4f6f9', dark: '#26292e' },
  '--dsw-alias-markdown-inline-code': { light: '#f1f3f7', dark: '#262a30' },
  '--dsw-alias-markdown-tag': { light: '#edf0f4', dark: '#2a2d33' },
  '--dsw-alias-turn-trigger-bg': { light: '#f4f6f9', dark: '#ffffff14' },
  '--dsw-alias-interactive-bg-hover': { light: '#1d3a6a12', dark: '#ffffff12' },
  '--dsw-alias-interactive-bg-active': { light: '#1d3a6a1c', dark: '#ffffff1f' },
  '--dsw-alias-border-l3': { light: '#2a3a5226', dark: '#ffffff21' },
  '--dsw-alias-state-success-primary': { light: '#1a7a43', dark: '#4cc985' },
  '--dsw-alias-state-warn-label': { light: '#94570a', dark: '#e3a54b' },
  '--dsw-alias-state-error-primary': { light: '#c4372f', dark: '#f27a72' },
  '--dsw-specific-bubble': { light: '#e3ebfa', dark: '#263552' },
  '--dsw-specific-bubble-highlight': { light: '#cddcf6', dark: '#31446a' },
  '--dsw-specific-sidebar-nav-item-hover': { light: '#1d3a6a12', dark: '#ffffff12' },
  '--dsw-specific-sidebar-nav-item-active': { light: '#1d3a6a1f', dark: '#ffffff1c' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#2563d924', dark: '#6b9cf52e' },
  '--dsw-specific-selector': { light: '#eef1f5', dark: '#2a2d32' },
  '--dsw-specific-tip': { light: '#eef1f5', dark: '#2a2d32' },
  '--dsw-specific-login-input': { light: '#f4f6f9', dark: '#1f2226' },
  '--dsw-elevation-stroke-color': { light: '#ffffff99', dark: '#ffffff24' },
  '--dsw-elevation-soft': { light: '0 0 0 .5px #2a3a5229, var(--team-hairline), 0 8px 28px 0 #1b24331a', dark: '0 0 0 .5px #ffffff1f, var(--team-hairline), 0 8px 28px 0 #00000052' },
  '--dsw-elevation-prominent': { light: '0 0 0 .5px #2a3a5229, var(--team-hairline), 0 12px 36px 0 #1b243326', dark: '0 0 0 .5px #ffffff24, var(--team-hairline), 0 12px 36px 0 #00000066' },
  '--dsw-menu-backdrop-filter': { light: 'var(--team-blur)', dark: 'var(--team-blur)' },
}

/** A translucent material: its glass value and the solid value used when transparency is reduced. */
export interface Material { readonly glass: Pair; readonly solid: Pair }

/** Translucent `--dsw-*` surfaces, keyed by token; each is routed through a `--team-*` property so the
 * reduced-transparency media query can swap it. */
export const MATERIALS: Readonly<Record<string, Material>> = {
  '--dsw-alias-bg-base': { glass: { light: '#fbfcfdee', dark: '#17191ceb' }, solid: { light: '#fbfcfd', dark: '#17191c' } },
  '--dsw-specific-sidebar-fill': { glass: { light: '#f4f6f99e', dark: '#26282d94' }, solid: { light: '#eef1f5', dark: '#212327' } },
  '--dsw-specific-menu': { glass: { light: '#f6f8fba3', dark: '#2e3136a3' }, solid: { light: '#f6f8fb', dark: '#2e3136' } },
  '--dsw-menu-surface-fill': { glass: { light: '#f6f8fba3', dark: '#2e3136a3' }, solid: { light: '#f6f8fb', dark: '#2e3136' } },
  '--dsw-alias-menu-group-header-fill': { glass: { light: '#f6f8fbd9', dark: '#2e3136d9' }, solid: { light: '#f6f8fb', dark: '#2e3136' } },
  '--dsw-specific-input-major': { glass: { light: '#ffffffb8', dark: '#2a2d32c2' }, solid: { light: '#ffffff', dark: '#2a2d32' } },
  '--dsw-alias-settings-card-fill': { glass: { light: '#ffffffd9', dark: '#26282dd9' }, solid: { light: '#ffffff', dark: '#26282d' } },
}

/** Neutral desktop colour fields shown through the glass; contrast is checked against each. */
export const DESKTOP: Readonly<{ light: readonly string[]; dark: readonly string[] }> = {
  light: ['#c3ccd8', '#ddd3c8', '#d0d6dd'],
  dark: ['#2a313b', '#352f2a', '#24272b'],
}

/** Backdrop filter for glass surfaces. */
export const BLUR = 'blur(36px) saturate(175%)'

/** Custom property carrying one material.
 * @param token - The `--dsw-*` token name.
 * @returns The `--team-*` property name.
 */
export function materialProperty(token: string): string {
  return `--team-${token.replace(/^--(dsw|dsh)-/, '')}`
}

/** Desktop backdrop image for one palette.
 * @param scheme - Base palette.
 * @returns A CSS `background` value of large soft colour fields.
 */
export function desktop(scheme: 'light' | 'dark'): string {
  const [a, b, c] = DESKTOP[scheme]
  const d = scheme === 'light' ? '#d6d9dc' : '#1e2227'
  return `radial-gradient(1200px 900px at 8% 10%,${a} 0%,transparent 70%),radial-gradient(1000px 800px at 92% 90%,${b} 0%,transparent 70%),linear-gradient(135deg,${c},${d})`
}
