/** Account pages: server-rendered, escaped, English/Chinese, one nonce-bound script that calls `/api/auth/*`. */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserId } from '@public-harness/contracts'
import type { CaptchaProvider, CaptchaWidget } from './captcha.ts'
import type { IdentityConfig } from './config.ts'
import type { PagesHandler } from './server.ts'

/** Supported page locales. */
export type Locale = 'en' | 'zh'
const copy = {
  en: { title: 'DeepSeek Harness account', register: 'Create account', login: 'Sign in', logout: 'Sign out', reset: 'Reset password',
    email: 'Email', password: 'Password', name: 'Name', newPassword: 'New password', submit: 'Continue', loading: 'Working…',
    checkMail: 'Check your email for a verification link.', verified: 'Email verified. You can sign in now.', resetSent: 'If the address exists, a reset link was sent.',
    resetDone: 'Password changed. Sign in again.', closed: 'Registration is closed.', failed: 'The request failed: ', unavailable: 'The service is unavailable. Try again later.',
    signedOut: 'You are signed out.', revokeOthers: 'Sign out other sessions', openHarness: 'Open my Harness',
    verifyHuman: 'Verify you are human', captchaDone: 'Verification complete.', captchaMissing: 'Complete the human verification first.',
    invite: 'Invite code', inviteOnly: 'Registration is by invitation. Enter your invite code.',
    ssoLogin: 'Sign in with your company account', contractor: 'Invited contractors sign in with email and password:', ssoOnly: 'Employees sign in with the company account; registration is not public.',
    ssoGroup: 'Your company account is not in a group allowed to use Harness. Ask your administrator.', ssoEmailInUse: 'This email already belongs to another Harness account. Ask your administrator.',
    ssoRetry: 'The sign-in expired or was interrupted. Try again.', ssoFailed: 'Company sign-in failed. Try again or ask your administrator.',
    emergency: 'Administrator emergency sign-in', code: 'Authenticator code',
    username: 'Company username', ldapFailed: 'Sign-in failed. Check your username and password, or ask your administrator.', ldapLocked: 'Too many failed attempts. Try again later.' },
  zh: { title: 'DeepSeek Harness 账户', register: '创建账户', login: '登录', logout: '退出登录', reset: '重置密码',
    email: '邮箱', password: '密码', name: '名称', newPassword: '新密码', submit: '继续', loading: '处理中…',
    checkMail: '请查收邮件中的验证链接。', verified: '邮箱已验证，现在可以登录。', resetSent: '如果该地址存在，重置链接已发送。',
    resetDone: '密码已修改，请重新登录。', closed: '注册已关闭。', failed: '请求失败：', unavailable: '服务暂不可用，请稍后重试。',
    signedOut: '你已退出登录。', revokeOthers: '退出其他会话', openHarness: '打开我的 Harness',
    verifyHuman: '人机验证', captchaDone: '验证完成。', captchaMissing: '请先完成人机验证。',
    invite: '邀请码', inviteOnly: '注册需要邀请，请输入邀请码。',
    ssoLogin: '使用企业账号登录', contractor: '受邀承包商使用邮箱和密码登录：', ssoOnly: '员工请使用企业账号登录；不开放公开注册。',
    ssoGroup: '你的企业账号不在允许使用 Harness 的群组中，请联系管理员。', ssoEmailInUse: '该邮箱已属于另一个 Harness 账户，请联系管理员。',
    ssoRetry: '登录已过期或被中断，请重试。', ssoFailed: '企业登录失败，请重试或联系管理员。',
    emergency: '管理员紧急登录', code: '验证器动态码',
    username: '企业用户名', ldapFailed: '登录失败。请检查用户名和密码，或联系管理员。', ldapLocked: '失败次数过多，请稍后再试。' },
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

type View = 'home' | 'register' | 'login' | 'reset' | 'verified' | 'emergency'
/** Which sign-in paths a deployment offers: enterprise SSO (LDAP uses a username/password form instead of a redirect) and the administrator emergency page. */
export interface PageMode { readonly sso: boolean; readonly emergency: boolean; readonly ldap?: boolean }

/** Map an `sso_error` code from the callback to localized copy; unknown codes get the generic message.
 * @param locale Locale.
 * @param code Error code from the query string.
 * @returns Text.
 */
export function ssoErrorText(locale: Locale, code: string): string {
  const key: CopyKey = code === 'group' ? 'ssoGroup' : code === 'email-in-use' ? 'ssoEmailInUse' : code === 'state' || code === 'idp' ? 'ssoRetry' : 'ssoFailed'
  return text(locale, key)
}
/** What a page renders for human verification: a provider widget, invite codes, or the local fixed test token. */
export type PageCaptcha = { readonly provider: 'test' } | { readonly provider: 'none' } | CaptchaWidget

function captchaBlock(locale: Locale, captcha: PageCaptcha): string {
  const t = (key: CopyKey) => escapeHtml(text(locale, key))
  const button = `<button type="button" id="captcha-button" data-captcha-button>${t('verifyHuman')}</button> <span data-captcha-state role="status"></span>`
  switch (captcha.provider) {
    case 'test': return '<input name="captcha" type="hidden" data-test-captcha>'
    case 'none': return ''
    case 'turnstile': return '<div data-captcha></div>'
    case 'aliyun': return `<div id="captcha-element" data-captcha></div>${button}`
    case 'tencent': return `<div data-captcha></div>${button}`
  }
}

function form(locale: Locale, view: View, captcha: PageCaptcha, mode: PageMode): string {
  const t = (key: CopyKey) => escapeHtml(text(locale, key))
  const field = (name: string, label: CopyKey, type: string) => `<label>${t(label)}<input name="${name}" type="${type}" required autocomplete="${type === 'password' ? 'current-password' : name}"></label>`
  const human = captchaBlock(locale, captcha)
  const invite = captcha.provider === 'none' ? `<label>${t('invite')}<input name="invite" type="text" required autocomplete="off" spellcheck="false" pattern="dshinv-[a-z2-7]{26}"></label>` : ''
  // In SSO mode only invited contractors keep password registration and sign-in (decision D3).
  const passwords = !mode.sso || captcha.provider === 'none'
  const company = mode.ldap
    ? `<h2>${t('ssoLogin')}</h2><form data-action="ldap"><label>${t('username')}<input name="username" type="text" required autocomplete="username" spellcheck="false" autocapitalize="off"></label>${field('password', 'password', 'password')}<button type="submit">${t('submit')}</button></form>`
    : `<p><a href="/api/auth/sso/start" data-sso-start>${t('ssoLogin')}</a></p>`
  const login = `<form data-action="login">${field('email', 'email', 'email')}${field('password', 'password', 'password')}<button type="submit">${t('submit')}</button></form>`
  if (view === 'emergency') return `<h2>${t('emergency')}</h2><form data-action="emergency">${field('email', 'email', 'email')}${field('password', 'password', 'password')}<label>${t('code')}<input name="code" type="text" required inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"></label><button type="submit">${t('submit')}</button></form>`
  if (view === 'login' && mode.sso) return `${company}${passwords ? `<p>${t('contractor')}</p>${login}` : ''}`
  if (view === 'register' && !passwords) return ''
  if (view === 'register') return `<form data-action="register">${field('name', 'name', 'text')}${field('email', 'email', 'email')}${field('password', 'password', 'password')}${invite}${human}<button type="submit">${t('submit')}</button></form>`
  if (view === 'login') return login
  if (view === 'reset') return `<form data-action="reset-request">${field('email', 'email', 'email')}${human}<button type="submit">${t('submit')}</button></form><form data-action="reset" hidden>${field('newPassword', 'newPassword', 'password')}<button type="submit">${t('submit')}</button></form>`
  if (view === 'verified') return `<p role="status">${t('verified')}</p><a href="/account/login">${t('login')}</a>`
  return `<div data-session></div><button data-action="logout" hidden>${t('logout')}</button><button data-action="revoke-others" hidden>${t('revokeOthers')}</button>`
}

/** Content-Security-Policy for an account page: nonce-bound first-party script and style, plus exactly the sources the configured widget needs.
 * @param nonce Per-response nonce.
 * @param captcha Page CAPTCHA mode.
 * @returns Header value.
 */
export function contentSecurityPolicy(nonce: string, captcha: PageCaptcha): string {
  const csp = 'csp' in captcha ? captcha.csp : undefined
  const list = (base: string[], extra: readonly string[] = []) => [...base, ...extra].join(' ')
  const directives = [
    "default-src 'none'",
    `script-src ${list([`'nonce-${nonce}'`], csp?.script)}`,
    // Widget SDKs that inject inline styles need 'unsafe-inline'; a nonce would disable it, so those pages drop the style nonce.
    `style-src ${csp?.inlineStyle === true ? list(["'self'", "'unsafe-inline'"], csp.style) : list([`'nonce-${nonce}'`], csp?.style)}`,
    `connect-src ${list(["'self'"], csp?.connect)}`,
    ...csp !== undefined && csp.frame.length ? [`frame-src ${list([], csp.frame)}`] : [],
    ...csp !== undefined && csp.img.length ? [`img-src ${list([], csp.img)}`] : [],
    "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
  ]
  return directives.join('; ')
}

const SCRIPT = `
const L=JSON.parse(document.getElementById('copy').textContent),C=JSON.parse(document.getElementById('captcha').textContent),out=document.querySelector('[role=alert]');
const say=(m)=>{out.textContent=m};
// After sign-in everyone goes straight to their own chat; the return parameter may only name the account page or that same route.
const home=(r)=>{const id=r&&r.user&&r.user.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]+$/.test(id))return '/account/';const own='/u/'+id+'/',w=new URLSearchParams(location.search).get('return')||'';return w==='/account/'||w===own?w:own}
async function call(path,body,extra){const r=await fetch('/api/auth'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
 let j=null;try{j=await r.json()}catch{} if(r.status===503)throw new Error(L.unavailable); if(!r.ok)throw new Error(L.failed+((j&&(j.code||j.message))||r.status)); return j}
let tok='';const mark=(ok)=>{for(const s of document.querySelectorAll('[data-captcha-state]'))s.textContent=ok?L.captchaDone:''};
const load=(cb)=>{const s=document.createElement('script');s.src=C.script;s.async=true;s.onload=cb;s.onerror=()=>say(L.unavailable);document.head.append(s)};
const human=document.querySelector('[data-captcha]');
const aliInit=()=>window.initAliyunCaptcha({SceneId:C.params.sceneId,mode:'popup',element:'#captcha-element',button:'#captcha-button',success:(p)=>{tok=p;mark(true)},fail:()=>{tok='';mark(false)},getInstance:()=>{}});
if(human&&C.provider==='turnstile')load(()=>window.turnstile.render(human,{sitekey:C.params.siteKey,callback:(t)=>{tok=t},'expired-callback':()=>{tok=''}}));
if(human&&C.provider==='aliyun'){window.AliyunCaptchaConfig={region:C.params.region,prefix:C.params.prefix};load(aliInit)}
if(human&&C.provider==='tencent')document.querySelector('[data-captcha-button]').addEventListener('click',()=>{const go=()=>new window.TencentCaptcha(C.params.appId,(r)=>{
 if(r&&r.ret===0&&r.ticket&&!/^trerror/.test(r.ticket)){tok=JSON.stringify({ticket:r.ticket,randstr:r.randstr});mark(true)}else{tok='';mark(false)}}).show();window.TencentCaptcha?go():load(go)});
const resetHuman=()=>{tok='';mark(false);if(C.provider==='turnstile'&&window.turnstile)window.turnstile.reset(human);if(C.provider==='aliyun'&&window.initAliyunCaptcha)aliInit()};
function gate(f,d){if(f.querySelector('[data-test-captcha]'))return {'x-captcha-response':new URLSearchParams(location.search).get('captcha')||''};
 if(C.provider==='none')return d.invite===undefined?{}:{'x-invite-code':String(d.invite).trim()};
 if(!tok)throw new Error(L.captchaMissing);return {'x-captcha-response':tok}}
for(const f of document.querySelectorAll('form'))f.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));const b=f.querySelector('button[type=submit]');b.disabled=true;say(L.loading);
 const a=f.dataset.action;let used=false;
 try{
  if(a==='register'){const h=gate(f,d);used=true;await call('/sign-up/email',{name:d.name,email:d.email,password:d.password,callbackURL:'/account/verified'},h);say(L.checkMail)}
  else if(a==='ldap'){const r=await fetch('/api/auth/sso/ldap/sign-in',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:d.username,password:d.password,return:new URLSearchParams(location.search).get('return')||''})});
   let j=null;try{j=await r.json()}catch{} if(r.ok&&j&&j.redirect){location.assign(j.redirect);return}
   const c=j&&j.code;say(r.status===503?L.unavailable:r.status===429||c==='locked'?L.ldapLocked:c==='group'?L.ssoGroup:c==='email-in-use'?L.ssoEmailInUse:L.ldapFailed)}
  else if(a==='login'){const r=await call('/sign-in/email',{email:d.email,password:d.password});location.assign(home(r))}
  else if(a==='reset-request'){const h=gate(f,d);used=true;await call('/request-password-reset',{email:d.email,redirectTo:'/account/reset'},h);say(L.resetSent)}
  else if(a==='emergency'){const r=await call('/emergency/sign-in',{email:d.email,password:d.password,code:String(d.code).trim()});location.assign(home(r))}
  else if(a==='reset'){await call('/reset-password',{newPassword:d.newPassword,token:new URLSearchParams(location.search).get('token')});say(L.resetDone)}
 }catch(err){say(err.message)}finally{b.disabled=false;if(used)resetHuman()}});
const sso=document.querySelector('[data-sso-start]');if(sso){const r=new URLSearchParams(location.search).get('return');if(r)sso.href='/api/auth/sso/start?return='+encodeURIComponent(r)}
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
 * @param captcha Human verification mode; defaults to the local test token.
 * @param mode Enterprise SSO and emergency availability; defaults to neither.
 * @returns HTML document.
 */
export function renderPage(locale: Locale, view: View, nonce: string, notice = '', captcha: PageCaptcha = { provider: 'test' }, mode: PageMode = { sso: false, emergency: false }): string {
  const t = (key: CopyKey) => escapeHtml(text(locale, key))
  // Registration and reset links are for password accounts; in SSO mode only invite deployments show them. The emergency page is never linked.
  const passwords = !mode.sso || captcha.provider === 'none'
  const nav = `<nav>${passwords ? `<a href="/account/register">${t('register')}</a> ` : ''}<a href="/account/login">${t('login')}</a> ${passwords ? `<a href="/account/reset">${t('reset')}</a> ` : ''}<a href="?lang=${locale === 'en' ? 'zh' : 'en'}">${locale === 'en' ? '中文' : 'English'}</a></nav>`
  // The copy is embedded as JSON inside a non-executing script element; `<` is escaped so no text can close it.
  const json = JSON.stringify(copy[locale]).replace(/</g, '\\u003c')
  // Only public widget parameters are embedded; secrets never reach the page.
  const widget = JSON.stringify('csp' in captcha ? { provider: captcha.provider, script: captcha.script, params: captcha.params } : { provider: captcha.provider }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('title')}</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1f2329}label{display:block;margin:.75rem 0}input{display:block;width:100%;padding:.5rem;margin-top:.25rem}button{margin-top:1rem;padding:.5rem 1rem;background:#4d6bfe;color:#fff;border:0;border-radius:6px}nav a{margin-right:.75rem}[role=alert]{min-height:1.5rem;color:#b42318}</style></head>
<body data-harness="/u/{id}/"><h1>${t('title')}</h1>${nav}<main>${form(locale, view, captcha, mode)}</main><p role="alert">${escapeHtml(notice)}</p>
<script type="application/json" id="copy">${json}</script><script type="application/json" id="captcha">${widget}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`
}

/** Map a provider to what its pages render.
 * @param provider Configured provider.
 * @returns Page CAPTCHA mode.
 */
export function pageCaptcha(provider: Pick<CaptchaProvider, 'kind' | 'widget'>): PageCaptcha {
  if (provider.widget !== undefined) return provider.widget
  return provider.kind === 'none' ? { provider: 'none' } : { provider: 'test' }
}

/** Serve `/account/*`; everything else falls through.
 * @param config Settings.
 * @param provider Configured human verification, which decides the widget and CSP.
 * @returns Pages handler.
 */
export function createAccountPages(config: IdentityConfig, provider: Pick<CaptchaProvider, 'kind' | 'widget'>): PagesHandler {
  const captcha = pageCaptcha(provider)
  const mode: PageMode = { sso: config.sso.kind !== 'off', emergency: config.emergency.enabled, ldap: config.sso.kind === 'ldap' }
  const views: Record<string, View> = { '/account/': 'home', '/account/register': 'register', '/account/login': 'login', '/account/reset': 'reset', '/account/verified': 'verified',
    ...mode.emergency ? { '/account/emergency': 'emergency' as const } : {} }
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const view = views[url.pathname]
    if (view === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const locale = pickLocale(url, req.headers['accept-language'])
    const nonce = randomBytes(16).toString('base64')
    const ssoError = url.searchParams.get('sso_error')
    const notice = view === 'login' ? (ssoError === null ? '' : ssoErrorText(locale, ssoError))
      : view !== 'register' ? '' : captcha.provider === 'none' ? text(locale, 'inviteOnly') : mode.sso ? text(locale, 'ssoOnly') : config.enrollmentOpen ? '' : text(locale, 'closed')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': contentSecurityPolicy(nonce, captcha) })
    res.end(req.method === 'HEAD' ? undefined : renderPage(locale, view, nonce, notice, captcha, mode))
    return true
  }
}
