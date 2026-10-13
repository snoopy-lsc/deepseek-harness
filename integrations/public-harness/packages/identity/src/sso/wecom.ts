/** WeCom (企业微信) web login: the official login link, `auth/getuserinfo` for the member's userid, `user/get` for departments and `department/simplelist` for sub-departments.
 * References: web login link https://developer.work.weixin.qq.com/document/path/98152, login identity https://developer.work.weixin.qq.com/document/path/98176,
 * access_token https://developer.work.weixin.qq.com/document/path/91039, read member https://developer.work.weixin.qq.com/document/path/90196,
 * sub-department IDs https://developer.work.weixin.qq.com/document/path/95350. */
import { createHash, randomBytes } from 'node:crypto'
import { IdentityUnavailableError } from '../transports.ts'
import type { SsoConfig } from './config.ts'
import { SsoRejectedError, type SsoIdentity, type SsoProvider } from './provider.ts'

type WecomConfig = Extract<SsoConfig, { kind: 'wecom' }>

/** access_token errors after which WeCom expects a fresh token (expired, invalid, not latest). */
const TOKEN_ERRORS = new Set([40001, 40014, 42001])
const TOKEN_MARGIN_MS = 300_000
const DEPARTMENT_TTL_MS = 600_000
const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,255}$/
const random = () => randomBytes(32).toString('base64url')

/** Stand-in address for a member whose email the app may not read. It is unique per subject and uses the reserved `.invalid` TLD,
 * so it can never receive mail or equal a real address; the service refuses `.invalid` addresses at registration.
 * @param subject Corp-scoped subject.
 * @returns Placeholder address.
 */
export function wecomPlaceholderEmail(subject: string): string {
  return `wecom-${createHash('sha256').update(`wecom\0${subject}`).digest('hex').slice(0, 32)}@sso.invalid`
}

/** Create the WeCom provider.
 * @param config WeCom settings from `DSH_WECOM_*`.
 * @param deps Injected fetch and clock for tests.
 * @returns Provider; WeCom outages and unexpected errors raise `IdentityUnavailableError`, refused members `SsoRejectedError`.
 */
export function createWecomProvider(config: WecomConfig, deps: { fetch?: typeof fetch; clock?: () => number } = {}): SsoProvider {
  const fetcher = deps.fetch ?? fetch, clock = deps.clock ?? Date.now
  let token: { value: string; expiresAt: number } | undefined
  let pending: Promise<string> | undefined
  const subtrees = new Map<string, { ids: Set<string>; at: number }>()

  async function get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(path, config.apiBase)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    let response: Response
    try { response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) }) } catch { throw new IdentityUnavailableError('sso') }
    if (!response.ok) throw new IdentityUnavailableError('sso')
    let body: unknown
    try { body = await response.json() } catch { throw new IdentityUnavailableError('sso') }
    if (typeof body !== 'object' || body === null || typeof (body as { errcode?: unknown }).errcode !== 'number') throw new IdentityUnavailableError('sso')
    return body as Record<string, unknown>
  }
  async function accessToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > clock()) return token.value
    // One request at a time: WeCom rate-limits gettoken, and concurrent logins share the cached token.
    pending ??= (async () => {
      try {
        const body = await get('/cgi-bin/gettoken', { corpid: config.corpId, corpsecret: config.secret })
        if (body.errcode !== 0 || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new IdentityUnavailableError('sso')
        token = { value: body.access_token, expiresAt: clock() + Math.max(60_000, body.expires_in * 1000 - TOKEN_MARGIN_MS) }
        return token.value
      } finally { pending = undefined }
    })()
    return pending
  }
  /** Call an API with the cached token, refetching it once when WeCom says it is no longer valid. */
  async function api(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    let body = await get(path, { access_token: await accessToken(), ...params })
    if (typeof body.errcode === 'number' && TOKEN_ERRORS.has(body.errcode)) {
      token = undefined
      body = await get(path, { access_token: await accessToken(), ...params })
    }
    return body
  }
  async function subtree(root: string): Promise<Set<string>> {
    const cached = subtrees.get(root)
    if (cached !== undefined && clock() - cached.at < DEPARTMENT_TTL_MS) return cached.ids
    const body = await api('/cgi-bin/department/simplelist', { id: root })
    if (body.errcode !== 0 || !Array.isArray(body.department_id)) throw new IdentityUnavailableError('sso')
    const ids = new Set([root, ...body.department_id.flatMap(entry => typeof entry?.id === 'number' ? [String(entry.id)] : [])])
    subtrees.set(root, { ids, at: clock() })
    return ids
  }

  return {
    kind: 'wecom',
    async begin({ redirectUri }) {
      // WeCom has no PKCE or nonce; the stored state (single use, browser-bound) is the CSRF defense the docs ask for.
      const secrets = { state: random(), nonce: random(), verifier: random() }
      const url = new URL(config.loginUrl)
      for (const [name, value] of Object.entries({ login_type: 'CorpApp', appid: config.corpId, agentid: config.agentId, redirect_uri: redirectUri, state: secrets.state })) url.searchParams.set(name, value)
      return { url: url.href, secrets }
    },
    async finish({ code }): Promise<SsoIdentity> {
      if (!code || code.length > 512) throw new SsoRejectedError('token-exchange')
      const who = await api('/cgi-bin/auth/getuserinfo', { code })
      if (who.errcode === 40029) throw new SsoRejectedError('token-exchange')
      if (who.errcode !== 0) throw new IdentityUnavailableError('sso')
      // Non-members get only an openid; interconnected-corp IDs (`CorpId/userid`) belong to another corp. Neither may sign in.
      const userid = who.userid
      if (typeof userid !== 'string' || userid === '' || userid.length > 64 || userid.includes('/')) throw new SsoRejectedError('not-member')
      const member = await api('/cgi-bin/user/get', { userid })
      if (member.errcode === 60111 || member.errcode === 60011) throw new SsoRejectedError('directory')
      if (member.errcode !== 0) throw new IdentityUnavailableError('sso')
      if (member.status !== 1) throw new SsoRejectedError('inactive')
      const departments = Array.isArray(member.department) ? member.department.flatMap(id => typeof id === 'number' && Number.isSafeInteger(id) ? [String(id)] : []) : []
      const groups = new Set(departments)
      if (config.recursiveDepartments) {
        // A member of a sub-department counts as a member of each allowed ancestor department.
        for (const allowed of config.allowedGroups) {
          const ids = await subtree(allowed)
          if (departments.some(id => ids.has(id))) groups.add(allowed)
        }
      }
      // userid is unique within one corp and case-insensitive; prefixing the corp ID keeps (provider, subject) unique if the corp ever changes.
      const subject = `${config.corpId}:${userid.toLowerCase()}`
      const directory = [member.biz_mail, member.email].find((value): value is string => typeof value === 'string' && EMAIL.test(value.trim()))
      const email = directory?.trim().toLowerCase() ?? wecomPlaceholderEmail(subject)
      const name = (typeof member.name === 'string' && member.name.trim() ? member.name.trim() : userid).slice(0, 128)
      return { subject, email, name, groups: [...groups] }
    },
  }
}
