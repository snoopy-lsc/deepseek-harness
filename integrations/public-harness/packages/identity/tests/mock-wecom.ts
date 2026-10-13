/** A local WeCom (企业微信) server for tests: 127.0.0.1 only, test-only corp ID and secret. Implements the web login redirect and the server APIs the provider calls. */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export const MOCK_CORP_ID = 'wwmockcorp0001'
export const MOCK_AGENT_ID = '1000002'
/** Test-only value; only the mock knows it. */
export const MOCK_WECOM_SECRET = 'mock-wecom-test-only-value'
export interface MockMember { name?: string; department: number[]; status?: number; email?: string; biz_mail?: string }
export interface MockWecom {
  base: string
  loginUrl: string
  members: Map<string, MockMember>
  /** Department tree as (id, parentid); root is 1. */
  departments: Array<{ id: number; parentid: number }>
  /** Who scans the next QR code: a member userid, or `{ openid }` for a non-member. */
  scanner: string | { openid: string }
  /** errcode answered once by the next matching API path, then cleared. */
  failOnce: Map<string, number>
  /** HTTP status every API answers with instead of JSON, when set. */
  httpStatus?: number
  delayMs: number
  tokensIssued: number
  calls: string[]
  /** Invalidate every issued access_token, as WeCom may do early. */
  expireTokens(): void
  /** Follow the login page redirect as a scan would; returns the callback URL. */
  scan(loginUrl: string): Promise<URL>
  close(): Promise<void>
}

export async function startMockWecom(): Promise<MockWecom> {
  const tokens = new Set<string>()
  const codes = new Map<string, string | { openid: string }>()
  let server!: Server
  const mock: MockWecom = {
    base: '', loginUrl: '', members: new Map([['ZhangSan', { name: '张三', department: [3], status: 1 }]]),
    departments: [{ id: 2, parentid: 1 }, { id: 3, parentid: 2 }, { id: 4, parentid: 1 }, { id: 5, parentid: 3 }],
    scanner: 'ZhangSan', failOnce: new Map(), delayMs: 0, tokensIssued: 0, calls: [],
    expireTokens: () => tokens.clear(),
    async scan(url) { const reply = await fetch(url, { redirect: 'manual' }); return new URL(reply.headers.get('location')!) },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
  server = createServer((req, res) => {
    void (async () => {
      if (mock.delayMs) await new Promise(resolve => setTimeout(resolve, mock.delayMs))
      const url = new URL(req.url ?? '/', mock.base), q = url.searchParams
      const json = (body: Record<string, unknown>) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: 0, errmsg: 'ok', ...body })) }
      if (url.pathname === '/wwlogin/sso/login') {
        if (q.get('login_type') !== 'CorpApp' || q.get('appid') !== MOCK_CORP_ID || q.get('agentid') !== MOCK_AGENT_ID || !q.get('redirect_uri') || !q.get('state')) {
          res.writeHead(400); res.end('bad login request'); return
        }
        const code = randomBytes(12).toString('hex')
        codes.set(code, mock.scanner)
        const target = new URL(q.get('redirect_uri')!)
        target.searchParams.set('code', code); target.searchParams.set('state', q.get('state')!)
        res.writeHead(302, { location: target.href }); res.end(); return
      }
      mock.calls.push(url.pathname)
      if (mock.httpStatus !== undefined) { res.writeHead(mock.httpStatus); res.end(); return }
      const forced = mock.failOnce.get(url.pathname)
      if (forced !== undefined) { mock.failOnce.delete(url.pathname); return json({ errcode: forced, errmsg: 'forced' }) }
      if (url.pathname === '/cgi-bin/gettoken') {
        if (q.get('corpid') !== MOCK_CORP_ID || q.get('corpsecret') !== MOCK_WECOM_SECRET) return json({ errcode: 40001, errmsg: 'invalid credential' })
        const token = randomBytes(16).toString('hex'); tokens.add(token); mock.tokensIssued++
        return json({ access_token: token, expires_in: 7200 })
      }
      if (!tokens.has(q.get('access_token') ?? '')) return json({ errcode: 42001, errmsg: 'access_token expired' })
      if (url.pathname === '/cgi-bin/auth/getuserinfo') {
        const who = codes.get(q.get('code') ?? '')
        codes.delete(q.get('code') ?? '')
        if (who === undefined) return json({ errcode: 40029, errmsg: 'invalid code' })
        return json(typeof who === 'string' ? { userid: who } : { openid: who.openid })
      }
      if (url.pathname === '/cgi-bin/user/get') {
        const id = q.get('userid') ?? ''
        const member = [...mock.members].find(([key]) => key.toLowerCase() === id.toLowerCase())
        if (member === undefined) return json({ errcode: 60111, errmsg: 'userid not found' })
        return json({ userid: member[0], ...member[1], status: member[1].status ?? 1 })
      }
      if (url.pathname === '/cgi-bin/department/simplelist') {
        const root = Number(q.get('id') ?? 1)
        const out: Array<{ id: number; parentid: number; order: number }> = []
        const walk = (id: number) => { for (const d of mock.departments.filter(entry => entry.parentid === id)) { out.push({ ...d, order: 0 }); walk(d.id) } }
        const self = mock.departments.find(entry => entry.id === root)
        if (self === undefined && root !== 1) return json({ errcode: 60123, errmsg: 'invalid party id' })
        if (self) out.push({ ...self, order: 0 })
        walk(root)
        return json({ department_id: out })
      }
      res.writeHead(404); res.end()
    })().catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.loginUrl = `${mock.base}/wwlogin/sso/login`
  return mock
}
