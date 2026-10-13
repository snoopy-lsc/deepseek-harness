/** DingTalk (钉钉) web login with the new-version OAuth 2.0 endpoints: the authorize link, `oauth2/userAccessToken` and `contact/users/me` for the
 * signed-in user's unionId, then the app's own token with `topapi/user/getbyunionid`, `topapi/v2/user/get` and `topapi/v2/department/listsubid`.
 * References: authorize link https://open.dingtalk.com/document/development/obtain-identity-credentials, user token
 * https://open.dingtalk.com/document/development/obtain-user-token, current user https://open.dingtalk.com/document/development/dingtalk-retrieve-user-information,
 * app token https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app, unionId to userid
 * https://open.dingtalk.com/document/development/query-a-user-by-the-union-id, member details https://open.dingtalk.com/document/development/query-user-details,
 * sub-departments https://open.dingtalk.com/document/development/obtain-a-sub-department-id-list-v2. */
import { createHash, randomBytes } from 'node:crypto'
import { IdentityUnavailableError } from '../transports.ts'
import type { SsoConfig } from './config.ts'
import { SsoRejectedError, type SsoIdentity, type SsoProvider } from './provider.ts'

type DingtalkConfig = Extract<SsoConfig, { kind: 'dingtalk' }>

/** oapi errcodes after which DingTalk expects a fresh app token (invalid, expired). */
const TOKEN_ERRORS = new Set([40001, 40014, 42001])
const TOKEN_MARGIN_MS = 300_000
const DEPARTMENT_TTL_MS = 600_000
/** listsubid returns direct children only, so the walk is bounded against huge or cyclic trees. */
const MAX_DEPARTMENTS = 5000
const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,255}$/
const random = () => randomBytes(32).toString('base64url')

/** Stand-in address for a member whose email the app may not read; same rule as WeCom: unique per subject, reserved `.invalid` TLD, refused at registration.
 * @param subject Corp-scoped subject.
 * @returns Placeholder address.
 */
export function dingtalkPlaceholderEmail(subject: string): string {
  return `dingtalk-${createHash('sha256').update(`dingtalk\0${subject}`).digest('hex').slice(0, 32)}@sso.invalid`
}

/** Create the DingTalk provider.
 * @param config DingTalk settings from `DSH_DINGTALK_*`.
 * @param deps Injected fetch and clock for tests.
 * @returns Provider; DingTalk outages and unexpected errors raise `IdentityUnavailableError`, refused members `SsoRejectedError`.
 */
export function createDingtalkProvider(config: DingtalkConfig, deps: { fetch?: typeof fetch; clock?: () => number } = {}): SsoProvider {
  const fetcher = deps.fetch ?? fetch, clock = deps.clock ?? Date.now
  let token: { value: string; expiresAt: number } | undefined
  let pending: Promise<string> | undefined
  const subtrees = new Map<string, { ids: Set<string>; at: number }>()

  async function send(url: URL, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response
    try {
      response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { ...body === undefined ? {} : { 'content-type': 'application/json' }, ...headers }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
    } catch { throw new IdentityUnavailableError('sso') }
    let parsed: unknown
    try { parsed = await response.json() } catch { throw new IdentityUnavailableError('sso') }
    if (typeof parsed !== 'object' || parsed === null) throw new IdentityUnavailableError('sso')
    return { status: response.status, body: parsed as Record<string, unknown> }
  }
  async function appToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > clock()) return token.value
    pending ??= (async () => {
      try {
        const reply = await send(new URL('/v1.0/oauth2/accessToken', config.apiBase), { appKey: config.clientId, appSecret: config.clientSecret })
        const { accessToken, expireIn } = reply.body
        if (reply.status !== 200 || typeof accessToken !== 'string' || typeof expireIn !== 'number') throw new IdentityUnavailableError('sso')
        token = { value: accessToken, expiresAt: clock() + Math.max(60_000, expireIn * 1000 - TOKEN_MARGIN_MS) }
        return token.value
      } finally { pending = undefined }
    })()
    return pending
  }
  /** Call an oapi endpoint with the cached app token, refetching it once when DingTalk says it is no longer valid. */
  async function oapi(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const call = async () => {
      const url = new URL(path, config.oapiBase); url.searchParams.set('access_token', await appToken())
      const reply = await send(url, body)
      if (reply.status !== 200 || typeof reply.body.errcode !== 'number') throw new IdentityUnavailableError('sso')
      return reply.body
    }
    let reply = await call()
    if (TOKEN_ERRORS.has(reply.errcode as number)) { token = undefined; reply = await call() }
    return reply
  }
  const result = (reply: Record<string, unknown>) => {
    if (typeof reply.result !== 'object' || reply.result === null) throw new IdentityUnavailableError('sso')
    return reply.result as Record<string, unknown>
  }
  async function subtree(root: string): Promise<Set<string>> {
    const cached = subtrees.get(root)
    if (cached !== undefined && clock() - cached.at < DEPARTMENT_TTL_MS) return cached.ids
    const ids = new Set([root]), queue = [root]
    while (queue.length) {
      const reply = await oapi('/topapi/v2/department/listsubid', { dept_id: Number(queue.shift()) })
      // A missing allowed department is a configuration fault, not a refusal of this member: fail closed with 503.
      if (reply.errcode !== 0) throw new IdentityUnavailableError('sso')
      const children = result(reply).dept_id_list
      if (!Array.isArray(children)) throw new IdentityUnavailableError('sso')
      for (const child of children) {
        if (typeof child !== 'number' || !Number.isSafeInteger(child) || ids.has(String(child))) continue
        if (ids.size >= MAX_DEPARTMENTS) throw new IdentityUnavailableError('sso')
        ids.add(String(child)); queue.push(String(child))
      }
    }
    subtrees.set(root, { ids, at: clock() })
    return ids
  }

  return {
    kind: 'dingtalk',
    async begin({ redirectUri }) {
      // DingTalk documents neither PKCE nor a nonce for this flow; the stored state (single use, browser-bound) is the CSRF defense.
      const secrets = { state: random(), nonce: random(), verifier: random() }
      const url = new URL(config.loginUrl)
      const params: Record<string, string> = { redirect_uri: redirectUri, response_type: 'code', client_id: config.clientId, scope: 'openid corpid', prompt: 'consent', corpId: config.corpId }
      if (config.exclusiveLogin) Object.assign(params, { exclusiveLogin: 'true', exclusiveCorpId: config.corpId })
      params.state = secrets.state
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
      return { url: url.href, secrets }
    },
    async finish({ code }): Promise<SsoIdentity> {
      if (!code || code.length > 512) throw new SsoRejectedError('token-exchange')
      const exchange = await send(new URL('/v1.0/oauth2/userAccessToken', config.apiBase), { clientId: config.clientId, clientSecret: config.clientSecret, code, grantType: 'authorization_code' })
      // 4xx: DingTalk refused this code (invalid, used or expired); anything else unexpected is an outage.
      if (exchange.status >= 400 && exchange.status < 500) throw new SsoRejectedError('token-exchange')
      const userToken = exchange.body.accessToken
      if (exchange.status !== 200 || typeof userToken !== 'string') throw new IdentityUnavailableError('sso')
      // The user may pick another organization on the consent page; only the configured one may sign in.
      if (exchange.body.corpId !== config.corpId) throw new SsoRejectedError('not-member')
      const me = await send(new URL('/v1.0/contact/users/me', config.apiBase), undefined, { 'x-acs-dingtalk-access-token': userToken })
      const unionId = me.body.unionId
      if (me.status !== 200 || typeof unionId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(unionId)) throw new IdentityUnavailableError('sso')
      const lookup = await oapi('/topapi/user/getbyunionid', { unionid: unionId })
      if (lookup.errcode === 60121) throw new SsoRejectedError('not-member')
      if (lookup.errcode !== 0) throw new IdentityUnavailableError('sso')
      const { userid, contact_type: contactType } = result(lookup)
      if (contactType !== 0 || typeof userid !== 'string' || userid === '' || userid.length > 64) throw new SsoRejectedError('not-member')
      const detail = await oapi('/topapi/v2/user/get', { userid, language: 'zh_CN' })
      if (detail.errcode === 33012 || detail.errcode === 60121) throw new SsoRejectedError('directory')
      if (detail.errcode !== 0) throw new IdentityUnavailableError('sso')
      const member = result(detail)
      if (member.active !== true) throw new SsoRejectedError('inactive')
      const departments = Array.isArray(member.dept_id_list) ? member.dept_id_list.flatMap(id => typeof id === 'number' && Number.isSafeInteger(id) ? [String(id)] : []) : []
      const groups = new Set(departments)
      if (config.recursiveDepartments) {
        for (const allowed of config.allowedGroups) {
          const ids = await subtree(allowed)
          if (departments.some(id => ids.has(id))) groups.add(allowed)
        }
      }
      // unionId is system-generated and never changes; userid is admin-assigned. The corp prefix keeps (provider, subject) unique per organization.
      const subject = `${config.corpId}:${unionId}`
      const directory = [member.org_email, member.email].find((value): value is string => typeof value === 'string' && EMAIL.test(value.trim()))
      const email = directory?.trim().toLowerCase() ?? dingtalkPlaceholderEmail(subject)
      const name = (typeof member.name === 'string' && member.name.trim() ? member.name.trim() : userid).slice(0, 128)
      return { subject, email, name, groups: [...groups] }
    },
  }
}
