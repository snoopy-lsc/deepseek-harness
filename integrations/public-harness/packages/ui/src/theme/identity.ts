/** Stylesheet for the identity account pages: one centred glass card on the D4 desktop, built from the `team-enterprise` palette
 * and Harness control metrics (Button md 36px / 12px corners / 14px·22px text; Input 0.5px stroke, 12px corners). */
import { BLUR, COLORS, MATERIALS, desktop } from './palette.ts'

const c = (token: string, scheme: 'light' | 'dark'): string => COLORS[token]![scheme]
const font = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif"

function palette(s: 'light' | 'dark'): string {
  const card = MATERIALS['--dsw-alias-settings-card-fill']!.glass[s]
  return `html{background:${desktop(s)} fixed}body{color:${c('--dsw-alias-label-primary', s)}}`
    + `.card{background:${card};box-shadow:0 0 0 .5px ${s === 'light' ? '#2a3a5229' : '#ffffff24'},inset 0 1px 0 ${s === 'light' ? '#ffffffb3' : '#ffffff1f'},0 24px 64px ${s === 'light' ? '#1b243326' : '#00000066'}}`
    + `a{color:${c('--dsw-alias-link', s)}}.sub,label,.divider,[data-session] p,small{color:${c('--dsw-alias-label-secondary', s)}}`
    + `input{background:${s === 'light' ? '#ffffffcc' : '#1f2226cc'};color:${c('--dsw-alias-label-primary', s)};border:.5px solid ${s === 'light' ? '#2a3a5247' : '#ffffff38'}}`
    + `input:focus{border-color:${c('--dsw-alias-state-business-primary', s)};box-shadow:0 0 0 2px ${s === 'light' ? '#2563d933' : '#6b9cf54d'}}`
    + `.divider::before,.divider::after{background:${s === 'light' ? '#2a3a5233' : '#ffffff29'}}`
    + `.btn.primary{background:${c('--dsw-alias-button-primary-fill', s)};color:${c('--dsw-alias-label-primary-foreground', s)}}`
    + `.btn.primary:hover{background:${c('--dsw-alias-button-primary-hover', s)}}`
    + `.btn.outline{color:${c('--dsw-alias-label-primary', s)};box-shadow:inset 0 0 0 .5px ${s === 'light' ? '#2a3a5247' : '#ffffff38'}}`
    + `.btn.outline:hover,.top a:hover{background:${c('--dsw-alias-interactive-bg-hover', s)}}`
    + `.top a{color:${c('--dsw-alias-label-secondary', s)}}`
    + `[role=alert]:not(:empty){color:${c('--dsw-alias-state-error-primary', s)};background:${s === 'light' ? '#c4372f0d' : '#f27a7214'}}`
    + `[role=status]{color:${c('--dsw-alias-state-success-primary', s)}}`
}

/** CSS for `/account/*`; local and inline so the page nonce covers it, with no remote references.
 * @returns CSS text.
 */
export function identityStylesheet(): string {
  return ':root{color-scheme:light dark}*{box-sizing:border-box}html{min-height:100%}'
    + `body{margin:0;min-height:100vh;display:grid;place-items:center;padding:56px 16px;font-family:${font};font-size:14px;line-height:22px}`
    + '.top{position:fixed;top:16px;right:20px}.top a{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:8px;font-size:12px;line-height:18px;text-decoration:none}'
    + `.card{width:min(400px,100%);padding:36px 32px 28px;border-radius:20px;-webkit-backdrop-filter:${BLUR};backdrop-filter:${BLUR}}`
    + '.brand{display:flex;align-items:center;justify-content:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:-.02em}'
    + '.mark{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:28%;background:linear-gradient(135deg,#1757a8,#359cd8);color:#fff;font-weight:800;font-size:18px}'
    + 'h1{margin:20px 0 4px;text-align:center;font-size:20px;line-height:28px;font-weight:600}.sub{margin:0 0 20px;text-align:center}'
    + 'form{display:grid;gap:12px;margin:0}label{display:grid;gap:6px;font-size:13px;line-height:20px}.row{display:flex;justify-content:space-between;align-items:baseline}.row a{font-size:13px;text-decoration:none}'
    + 'input{height:36px;width:100%;padding:0 12px;border-radius:12px;font:inherit;font-size:14px;line-height:22px;outline:none}'
    + '.btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:12px;font-size:14px;line-height:22px;font-family:inherit;border:0;cursor:pointer;text-decoration:none;background:transparent}'
    + '.btn:disabled{opacity:.4;cursor:not-allowed}.block{display:flex;width:100%}form .btn{margin-top:4px}'
    + '.divider{display:flex;align-items:center;gap:12px;margin:20px 0 16px;font-size:12px;line-height:18px}.divider::before,.divider::after{content:"";flex:1;height:.5px}'
    + '.foot{margin:20px 0 0;text-align:center;font-size:13px}.foot a{text-decoration:none}.stack{display:grid;gap:10px}'
    + '[role=alert]{margin:16px 0 0;font-size:13px;line-height:20px;border-radius:8px}[role=alert]:not(:empty){padding:8px 12px}[role=status]{text-align:center}'
    + '[data-session] p{margin:0 0 12px;text-align:center}[hidden]{display:none!important}'
    + `${palette('light')}@media (prefers-color-scheme:dark){${palette('dark')}}`
    + `@media (prefers-reduced-transparency:reduce){.card{-webkit-backdrop-filter:none;backdrop-filter:none;background:${MATERIALS['--dsw-alias-settings-card-fill']!.solid.light}}`
    + `@media (prefers-color-scheme:dark){.card{background:${MATERIALS['--dsw-alias-settings-card-fill']!.solid.dark}}}}`
}
