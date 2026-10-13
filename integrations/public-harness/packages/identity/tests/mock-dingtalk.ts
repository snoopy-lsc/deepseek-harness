/** A local DingTalk (钉钉) server for tests: 127.0.0.1 only, test-only app key and secret. One listener stands in for login.dingtalk.com, api.dingtalk.com and oapi.dingtalk.com. */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export const MOCK_DT_CORP_ID = 'dingmockcorp0001'
export const MOCK_DT_CLIENT_ID = 'dingmockappkey01'
/** Test-only value; only the mock knows it. */
export const MOCK_DT_SECRET = 'mock-dingtalk-test-only-value'
export interface MockDtMember { userid: string; name?: string; dept_id_list: number[]; active?: boolean; email?: string; org_email?: string; contact_type?: number }
export interface MockDingtalk {
  base: string
  loginUrl: string
  /** Members by unionId. */
  members: Map<string, MockDtMember>
  /** Department tree as (id, parent); root is 1. */
  departments: Array<{ id: number; parent: number }>
  /** unionId of whoever scans next, and the organization they pick. */
  scanner: string
  scannerCorp: string
  /** errcode answered once by the next matching oapi path, then cleared. */
  failOnce: Map<string, number>
  httpStatus?: number
  delayMs: number
  appTokensIssued: number
  calls: string[]
  /** Last authorize query the login page saw. */
  lastAuthorize?: URLSearchParams
  expireTokens(): void
  scan(loginUrl: string): Promise<URL>
  close(): Promise<void>
}

export async function startMockDingtalk(): Promise<MockDingtalk> {
  const appTokens = new Set<string>(), userTokens = new Map<string, string>()
  const codes = new Map<string, { unionId: string; corpId: string }>()
  let server!: Server
  const mock: MockDingtalk = {
    base: '', loginUrl: '', members: new Map([['UnionZhang01', { userid: 'manager4220', name: '张三', dept_id_list: [3] }]]),
    departments: [{ id: 2, parent: 1 }, { id: 3, parent: 2 }, { id: 4, parent: 1 }, { id: 5, parent: 3 }],
    scanner: 'UnionZhang01', scannerCorp: MOCK_DT_CORP_ID, failOnce: new Map(), delayMs: 0, appTokensIssued: 0, calls: [],
    expireTokens: () => appTokens.clear(),
    async scan(url) { const reply = await fetch(url, { redirect: 'manual' }); return new URL(reply.headers.get('location')!) },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
  const read = async (req: import('node:http').IncomingMessage) => { let text = ''; for await (const chunk of req) text += chunk; try { return JSON.parse(text || '{}') as Record<string, unknown> } catch { return {} } }
  server = createServer((req, res) => {
    void (async () => {
      if (mock.delayMs) await new Promise(resolve => setTimeout(resolve, mock.delayMs))
      const url = new URL(req.url ?? '/', mock.base), q = url.searchParams
      const send = (status: number, body: Record<string, unknown>) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      const oapi = (body: Record<string, unknown>) => send(200, { errcode: 0, errmsg: 'ok', request_id: 'r', ...body })
      if (url.pathname === '/oauth2/auth') {
        mock.lastAuthorize = q
        if (q.get('response_type') !== 'code' || q.get('client_id') !== MOCK_DT_CLIENT_ID || !q.get('redirect_uri') || !q.get('state')) { res.writeHead(400); res.end('bad request'); return }
        const code = randomBytes(12).toString('hex')
        codes.set(code, { unionId: mock.scanner, corpId: mock.scannerCorp })
        const target = new URL(q.get('redirect_uri')!)
        target.searchParams.set('authCode', target.searchParams.get('authCode') ?? code); target.searchParams.set('state', q.get('state')!)
        res.writeHead(302, { location: target.href }); res.end(); return
      }
      mock.calls.push(url.pathname)
      if (mock.httpStatus !== undefined) { res.writeHead(mock.httpStatus); res.end(); return }
      const body = req.method === 'POST' ? await read(req) : {}
      if (url.pathname === '/v1.0/oauth2/accessToken') {
        if (body.appKey !== MOCK_DT_CLIENT_ID || body.appSecret !== MOCK_DT_SECRET) return send(400, { code: 'invalidClientSecret', message: 'bad secret' })
        const token = randomBytes(16).toString('hex'); appTokens.add(token); mock.appTokensIssued++
        return send(200, { accessToken: token, expireIn: 7200 })
      }
      if (url.pathname === '/v1.0/oauth2/userAccessToken') {
        const who = codes.get(String(body.code)); codes.delete(String(body.code))
        if (body.clientId !== MOCK_DT_CLIENT_ID || body.clientSecret !== MOCK_DT_SECRET || body.grantType !== 'authorization_code') return send(400, { code: 'invalidClient', message: 'bad client' })
        if (who === undefined) return send(400, { code: 'invalidAuthCode', message: 'bad code' })
        const token = randomBytes(16).toString('hex'); userTokens.set(token, who.unionId)
        return send(200, { accessToken: token, refreshToken: 'r', expireIn: 7200, corpId: who.corpId })
      }
      if (url.pathname === '/v1.0/contact/users/me') {
        const unionId = userTokens.get(String(req.headers['x-acs-dingtalk-access-token'] ?? ''))
        if (unionId === undefined) return send(401, { code: 'InvalidAuthentication', message: 'no' })
        return send(200, { nick: 'nick', unionId, openId: `open-${unionId}` })
      }
      const forced = mock.failOnce.get(url.pathname)
      if (forced !== undefined) { mock.failOnce.delete(url.pathname); return oapi({ errcode: forced, errmsg: 'forced' }) }
      if (!appTokens.has(q.get('access_token') ?? '')) return oapi({ errcode: 40014, errmsg: 'invalid access_token' })
      if (url.pathname === '/topapi/user/getbyunionid') {
        const member = mock.members.get(String(body.unionid))
        if (member === undefined) return oapi({ errcode: 60121, errmsg: 'not found' })
        return oapi({ result: { userid: member.userid, contact_type: member.contact_type ?? 0 } })
      }
      if (url.pathname === '/topapi/v2/user/get') {
        const member = [...mock.members.values()].find(entry => entry.userid === body.userid)
        if (member === undefined) return oapi({ errcode: 33012, errmsg: 'invalid userid' })
        const { contact_type: _, ...rest } = member
        return oapi({ result: { ...rest, active: member.active ?? true } })
      }
      if (url.pathname === '/topapi/v2/department/listsubid') {
        const id = Number(body.dept_id)
        if (id !== 1 && !mock.departments.some(entry => entry.id === id)) return oapi({ errcode: 60003, errmsg: 'no department' })
        return oapi({ result: { dept_id_list: mock.departments.filter(entry => entry.parent === id).map(entry => entry.id) } })
      }
      res.writeHead(404); res.end()
    })().catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.loginUrl = `${mock.base}/oauth2/auth`
  return mock
}
