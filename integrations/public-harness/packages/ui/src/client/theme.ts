/** The `team-enterprise` theme layer: `--dsw-*` token overrides plus one plugin-owned glass stylesheet. */
import type {} from '@deepseek-ai/cordis'
import { BLUR, COLORS, MATERIALS, desktop, materialProperty, type Pair } from '../theme/palette.ts'

/** Layer identity passed to `ctx.theme.overrideTokens`. */
export const THEME_SOURCE = 'team-enterprise'

/** Minimal view of ui-theme's `ctx.theme` service used here. */
export interface ThemeOverrides {
  overrideTokens(source: string, tokens: Record<string, Pair>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** ui-theme's token registry (published by `@deepseek-ai/dsh-client-ui-theme`). */
    theme: ThemeOverrides
  }
}

/** Token overrides: opaque values directly, translucent ones through their `--team-*` material property.
 * @returns Token name to `{ light, dark }` pairs.
 */
export function themeTokens(): Record<string, Pair> {
  const tokens: Record<string, Pair> = { ...COLORS }
  for (const token of Object.keys(MATERIALS)) {
    const value = `var(${materialProperty(token)})`
    tokens[token] = { light: value, dark: value }
  }
  return tokens
}

const materials = (scheme: 'light' | 'dark', kind: 'glass' | 'solid'): string =>
  Object.entries(MATERIALS).map(([token, value]) => `${materialProperty(token)}:${value[kind][scheme]};`).join('')

/** The glass stylesheet. Selectors use only slot names, data attributes and roles, never build-generated class names.
 * @returns CSS text.
 */
export function glassStylesheet(): string {
  const sidebar = 'div:has(> [data-slot="sidebar"])'
  const glass = `-webkit-backdrop-filter:var(--team-blur);backdrop-filter:var(--team-blur)`
  return [
    `body{--team-blur:${BLUR};--team-hairline:inset 0 1px 0 #ffffffb3,inset 0 0 0 .5px #ffffff80;${materials('light', 'glass')}background:${desktop('light')} fixed}`,
    `body[data-ds-dark-theme]{--team-hairline:inset 0 1px 0 #ffffff1f,inset 0 0 0 .5px #ffffff14;${materials('dark', 'glass')}background:${desktop('dark')} fixed}`,
    // The window frame lets the desktop through; the reading column keeps its own near-opaque base fill.
    `div:has(> ${sidebar}){background:transparent}`,
    `${sidebar}{${glass};box-shadow:inset -1px 0 0 #ffffff59}`,
    `body[data-ds-dark-theme] ${sidebar}{box-shadow:inset -1px 0 0 #ffffff0f}`,
    `[data-composer-card]{${glass}}`,
    `[data-composer-seat]{background:transparent}`,
    `[role="dialog"][aria-modal="true"]{${glass}}`,
    `@media (prefers-reduced-transparency: reduce){body{--team-blur:none;${materials('light', 'solid')}background:${COLORS['--dsh-boot-bg']!.light}}`
      + `body[data-ds-dark-theme]{${materials('dark', 'solid')}background:${COLORS['--dsh-boot-bg']!.dark}}}`,
  ].join('\n')
}

/** Minimal document surface used to mount the stylesheet. */
export interface StyleHost {
  createElement(tag: 'style'): { dataset: Record<string, string>; textContent: string | null; remove(): void }
  head: { appendChild(node: unknown): unknown }
}

/** Register the token layer and mount the stylesheet for the plugin lifetime.
 * @param ctx - Plugin context: `effect` for lifetime-bound work and the optional `theme` service.
 * @param host - Document to mount into; omitted outside a browser.
 */
export function installTheme(ctx: { effect(fn: () => () => void, label: string): void; get(name: 'theme'): ThemeOverrides | undefined },
  host: StyleHost | undefined = (globalThis as { document?: StyleHost }).document): void {
  const theme = ctx.get('theme')
  if (theme !== undefined) ctx.effect(() => theme.overrideTokens(THEME_SOURCE, themeTokens()), 'public-harness: team-enterprise tokens')
  if (host === undefined) return
  ctx.effect(() => {
    const tag = host.createElement('style')
    tag.dataset.plugin = '@public-harness/ui'
    tag.dataset.pluginCss = '@public-harness/ui/team-enterprise.css'
    tag.textContent = glassStylesheet()
    host.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'public-harness: team-enterprise stylesheet')
}
