/** Localized browser pages shared by the team entry and branded Web plugin. */

/** Supported browser languages for the team entry. */
export type TeamLocale = 'en' | 'zh'
/** User-visible readiness and refusal categories. */
export type TeamStatus = 'starting' | 'capacity-full' | 'service-unavailable' | 'quota-exhausted'

const copy = {
  en: { brand: 'Team Harness', choose: 'Choose a test user', local: 'Local development only',
    starting: 'Your workspace is starting', startingDetail: 'This page will retry shortly.',
    capacity: 'All workspaces are busy', capacityDetail: 'Please try again later.',
    unavailable: 'The service is unavailable', unavailableDetail: 'Please try again later.',
    quota: 'Your model allowance is exhausted', quotaDetail: 'Please try again after your daily allowance resets.' },
  zh: { brand: 'Team Harness', choose: '选择测试用户', local: '仅用于本机开发',
    starting: '正在启动工作空间', startingDetail: '此页面稍后会自动重试。',
    capacity: '工作空间已满', capacityDetail: '请稍后再试。',
    unavailable: '服务暂时不可用', unavailableDetail: '请稍后再试。',
    quota: '模型额度已用完', quotaDetail: '请在每日额度恢复后重试。' },
} as const

const css = 'body{font:16px system-ui,sans-serif;background:#f7f8fb;color:#1c2330;margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(28rem,calc(100vw - 2rem));padding:2rem;border:1px solid #d7dce5;border-radius:1rem;background:#fff;box-shadow:0 12px 32px #17294a12}.brand{display:flex;align-items:center;gap:.75rem;font-weight:700;margin-bottom:2rem}.mark{width:2rem;height:2rem;border-radius:28%;display:grid;place-items:center;background:linear-gradient(135deg,#1757a8,#359cd8);color:#fff}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#526174;margin:0 0 1.5rem}ul{list-style:none;padding:0;margin:0;display:grid;gap:.75rem}a{display:block;padding:.8rem 1rem;border:1px solid #b8c5d8;border-radius:.6rem;color:#174c91;text-decoration:none}a:hover,a:focus-visible{background:#eaf2ff;outline:2px solid #2d6ac4;outline-offset:2px}@media(prefers-color-scheme:dark){body{background:#101722;color:#f3f6fb}main{background:#1a2534;border-color:#3b4b60}p{color:#b4c1d1}a{border-color:#60748f;color:#a8c9ff}a:hover,a:focus-visible{background:#233b59}}'

function page(locale: TeamLocale, title: string, body: string, retryAfterSeconds?: number): string {
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${retryAfterSeconds === undefined ? '' : `<meta http-equiv="refresh" content="${retryAfterSeconds}">`}<title>${title}</title><style>${css}</style><main><div class="brand"><span class="mark" aria-hidden="true">T</span>${copy[locale].brand}</div>${body}</main></html>`
}

/** Render the local user selector.
 * @param users - canonical fixed development user IDs.
 * @param locale - browser page language.
 * @returns an escaped, branded HTML document.
 */
export function renderSelectorPage(users: readonly string[], locale: TeamLocale): string {
  const labels = copy[locale]
  const links = users.map(userId => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('invalid selector user')
    return `<li><a href="/dev/select/${userId}">${userId}</a></li>`
  }).join('')
  return page(locale, labels.choose, `<h1>${labels.choose}</h1><p>${labels.local}</p><ul>${links}</ul>`)
}

/** Render a branded waiting or refusal page.
 * @param status - public readiness or refusal category.
 * @param locale - browser page language.
 * @param retryAfterSeconds - positive refresh interval, used only while starting.
 * @returns an HTML document without internal IDs or credentials.
 */
export function renderStatusPage(status: TeamStatus, locale: TeamLocale, retryAfterSeconds: number): string {
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) throw new Error('invalid retry interval')
  const labels = copy[locale]
  let title: string
  let detail: string
  switch (status) {
    case 'starting': title = labels.starting; detail = labels.startingDetail; break
    case 'capacity-full': title = labels.capacity; detail = labels.capacityDetail; break
    case 'quota-exhausted': title = labels.quota; detail = labels.quotaDetail; break
    case 'service-unavailable': title = labels.unavailable; detail = labels.unavailableDetail; break
    default: return assertNever(status)
  }
  return page(locale, title, `<h1>${title}</h1><p>${detail}</p>`, status === 'starting' ? retryAfterSeconds : undefined)
}

function assertNever(value: never): never { throw new Error(`unexpected status: ${value}`) }
