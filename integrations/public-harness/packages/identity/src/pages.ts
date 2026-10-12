/** Account pages: server-rendered, escaped, English/Chinese, one nonce-bound script that calls `/api/auth/*`. */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserId } from '@public-harness/contracts'
import type { IdentityConfig } from './config.ts'
import type { PagesHandler } from './server.ts'

/** Supported page locales. */
export type Locale = 'en' | 'zh'
const copy = {
  en: { title: 'DeepSeek Harness account', register: 'Create account', login: 'Sign in', logout: 'Sign out', reset: 'Reset password',
    email: 'Email', password: 'Password', name: 'Name', newPassword: 'New password', submit: 'Continue', loading: 'Working…',
    checkMail: 'Check your email for a verification link.', verified: 'Email verified. You can sign in now.', resetSent: 'If the address exists, a reset link was sent.',
    resetDone: 'Password changed. Sign in again.', closed: 'Registration is closed.', failed: 'The request failed: ', unavailable: 'The service is unavailable. Try again later.',
    signedOut: 'You are signed out.', revokeOthers: 'Sign out other sessions', openHarness: 'Open my Harness' },
  zh: { title: 'DeepSeek Harness 账户', register: '创建账户', login: '登录', logout: '退出登录', reset: '重置密码',
    email: '邮箱', password: '密码', name: '名称', newPassword: '新密码', submit: '继续', loading: '处理中…',
    checkMail: '请查收邮件中的验证链接。', verified: '邮箱已验证，现在可以登录。', resetSent: '如果该地址存在，重置链接已发送。',
    resetDone: '密码已修改，请重新登录。', closed: '注册已关闭。', failed: '请求失败：', unavailable: '服务暂不可用，请稍后重试。',
    signedOut: '你已退出登录。', revokeOthers: '退出其他会话', openHarness: '打开我的 Harness' },
} satisfies Record<Locale, Record<string, string>>
/** Page copy keys, identical in every locale. */
export type CopyKey = keyof typeof copy.en

/** Escape text for HTML element and attribute content.
 * @param value Untrusted text.
 * @returns Escaped text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

/** Pick the locale from `?lang=` or Accept-Language.
 * @param url Request URL.
 * @param acceptLanguage Header value.
 * @returns Locale.
 */
export function pickLocale(url: URL, acceptLanguage: string | undefined): Locale {
  const asked = url.searchParams.get('lang')
  if (asked === 'en' || asked === 'zh') return asked
  return /^\s*zh\b/i.test(acceptLanguage ?? '') ? 'zh' : 'en'
}

/** The only post-login destinations: the signed-in user's own Harness route or the account page.
 * @param value Requested return path.
 * @param userId Signed-in user.
 * @returns A same-origin path; anything else falls back to the user's route.
 */
export function safeReturnPath(value: string, userId: UserId): string {
  const own = `/u/${userId}/`
  if (value === '/account/' || value === own) return value
  return own
}

/** Look up a localized string.
 * @param locale Locale.
 * @param key Copy key.
 * @returns Text.
 */
export function text(locale: Locale, key: CopyKey): string { return copy[locale][key] }

type View = 'home' | 'register' | 'login' | 'reset' | 'verified'
function form(locale: Locale, view: View, captchaSiteKey: boolean): string {
  const t = (key: CopyKey) => escapeHtml(text(locale, key))
  const field = (name: string, label: CopyKey, type: string) => `<label>${t(label)}<input name="${name}" type="${type}" required autocomplete="${type === 'password' ? 'current-password' : name}"></label>`
  const captcha = captchaSiteKey ? '<div class="captcha" data-captcha></div>' : '<input name="captcha" type="hidden" data-test-captcha>'
  if (view === 'register') return `<form data-action="register">${field('name', 'name', 'text')}${field('email', 'email', 'email')}${field('password', 'password', 'password')}${captcha}<button>${t('submit')}</button></form>`
  if (view === 'login') return `<form data-action="login">${field('email', 'email', 'email')}${field('password', 'password', 'password')}<button>${t('submit')}</button></form>`
  if (view === 'reset') return `<form data-action="reset-request">${field('email', 'email', 'email')}${captcha}<button>${t('submit')}</button></form><form data-action="reset" hidden>${field('newPassword', 'newPassword', 'password')}<button>${t('submit')}</button></form>`
  if (view === 'verified') return `<p role="status">${t('verified')}</p><a href="/account/login">${t('login')}</a>`
  return `<div data-session></div><button data-action="logout" hidden>${t('logout')}</button><button data-action="revoke-others" hidden>${t('revokeOthers')}</button>`
}

const SCRIPT = `
const L=JSON.parse(document.getElementById('copy').textContent),out=document.querySelector('[role=alert]');
const say=(m)=>{out.textContent=m};
async function call(path,body,extra){const r=await fetch('/api/auth'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
 let j=null;try{j=await r.json()}catch{} if(r.status===503)throw new Error(L.unavailable); if(!r.ok)throw new Error(L.failed+((j&&(j.code||j.message))||r.status)); return j}
const captcha=(f)=>{const t=f.querySelector('[data-test-captcha]');return {'x-captcha-response':t?(new URLSearchParams(location.search).get('captcha')||''):(window.dshCaptcha||'')}};
for(const f of document.querySelectorAll('form'))f.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));const b=f.querySelector('button');b.disabled=true;say(L.loading);
 try{const a=f.dataset.action;
  if(a==='register'){await call('/sign-up/email',{name:d.name,email:d.email,password:d.password,callbackURL:'/account/verified'},captcha(f));say(L.checkMail)}
  else if(a==='login'){const r=await call('/sign-in/email',{email:d.email,password:d.password});location.assign('/account/?return='+encodeURIComponent(new URLSearchParams(location.search).get('return')||''))}
  else if(a==='reset-request'){await call('/request-password-reset',{email:d.email,redirectTo:'/account/reset'},captcha(f));say(L.resetSent)}
  else if(a==='reset'){await call('/reset-password',{newPassword:d.newPassword,token:new URLSearchParams(location.search).get('token')});say(L.resetDone)}
 }catch(err){say(err.message)}finally{b.disabled=false}});
const token=new URLSearchParams(location.search).get('token');if(token&&document.querySelector('[data-action=reset]')){document.querySelector('[data-action=reset]').hidden=false;document.querySelector('[data-action=reset-request]').hidden=true}
const s=document.querySelector('[data-session]');
if(s){call('/get-session').then(j=>{if(!j){s.innerHTML='';const a=document.createElement('a');a.href='/account/login';a.textContent=L.login;s.append(a);return}
 const p=document.createElement('p');p.textContent=j.user.email;const h=document.createElement('a');h.textContent=L.openHarness;h.href=document.body.dataset.harness.replace('{id}',j.user.id);s.append(p,h);
 for(const b of document.querySelectorAll('[data-action=logout],[data-action=revoke-others]'))b.hidden=false}).catch(e=>say(e.message))}
document.querySelector('[data-action=logout]')?.addEventListener('click',()=>call('/sign-out',{}).then(()=>say(L.signedOut)).catch(e=>say(e.message)));
document.querySelector('[data-action=revoke-others]')?.addEventListener('click',()=>call('/revoke-other-sessions',{}).catch(e=>say(e.message)));
`

/** Render one account page.
 * @param locale Locale.
 * @param view Page.
 * @param nonce CSP nonce.
 * @param notice Optional server notice, escaped.
 * @returns HTML document.
 */
export function renderPage(locale: Locale, view: View, nonce: string, notice = ''): string {
  const t = (key: CopyKey) => escapeHtml(text(locale, key))
  const nav = `<nav><a href="/account/register">${t('register')}</a> <a href="/account/login">${t('login')}</a> <a href="/account/reset">${t('reset')}</a> <a href="?lang=${locale === 'en' ? 'zh' : 'en'}">${locale === 'en' ? '中文' : 'English'}</a></nav>`
  // The copy is embedded as JSON inside a non-executing script element; `<` is escaped so no text can close it.
  const json = JSON.stringify(copy[locale]).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('title')}</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1f2329}label{display:block;margin:.75rem 0}input{display:block;width:100%;padding:.5rem;margin-top:.25rem}button{margin-top:1rem;padding:.5rem 1rem;background:#4d6bfe;color:#fff;border:0;border-radius:6px}nav a{margin-right:.75rem}[role=alert]{min-height:1.5rem;color:#b42318}</style></head>
<body data-harness="/u/{id}/"><h1>${t('title')}</h1>${nav}<main>${form(locale, view, false)}</main><p role="alert">${escapeHtml(notice)}</p>
<script type="application/json" id="copy">${json}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`
}

/** Serve `/account/*`; everything else falls through.
 * @param config Settings.
 * @returns Pages handler.
 */
export function createAccountPages(config: IdentityConfig): PagesHandler {
  const views: Record<string, View> = { '/account/': 'home', '/account/register': 'register', '/account/login': 'login', '/account/reset': 'reset', '/account/verified': 'verified' }
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const view = views[url.pathname]
    if (view === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const locale = pickLocale(url, req.headers['accept-language'])
    const nonce = randomBytes(16).toString('base64')
    const notice = view === 'register' && !config.enrollmentOpen ? text(locale, 'closed') : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` })
    res.end(req.method === 'HEAD' ? undefined : renderPage(locale, view, nonce, notice))
    return true
  }
}
