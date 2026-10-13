/** Colour layer for the identity account pages, built from the same `team-enterprise` palette as Harness Web. */
import { COLORS, desktop } from './palette.ts'

const c = (token: string, scheme: 'light' | 'dark'): string => COLORS[token]![scheme]

/** CSS for `/account/*`: colours and the desktop backdrop only, local and inline so the page nonce covers it.
 * @returns CSS text without remote references.
 */
export function identityStylesheet(): string {
  const scheme = (s: 'light' | 'dark') => `html{background:${desktop(s)} fixed}body{color:${c('--dsw-alias-label-primary', s)}}`
    + `a{color:${c('--dsw-alias-link', s)}}p,small,label{color:${c('--dsw-alias-label-secondary', s)}}`
    + `input{background:${s === 'light' ? '#ffffffd9' : '#1f2226d9'};color:${c('--dsw-alias-label-primary', s)};border:1px solid ${s === 'light' ? '#2a3a5240' : '#ffffff33'};border-radius:6px}`
    + `button{background:${c('--dsw-alias-button-primary-fill', s)};color:${c('--dsw-alias-label-primary-foreground', s)}}`
    + `[role=alert]{color:${c('--dsw-alias-state-error-primary', s)}}`
  return `:root{color-scheme:light dark}html{min-height:100%}${scheme('light')}@media (prefers-color-scheme:dark){${scheme('dark')}}`
    + `@media (prefers-reduced-transparency:reduce){input{background:#fff}@media (prefers-color-scheme:dark){input{background:#1f2226}}}`
}
