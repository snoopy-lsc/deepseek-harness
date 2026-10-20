import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { startTeamDevQuota } from '../src/quota.ts'

const settings = JSON.parse(await readFile(new URL('../../../deploy/team-dev.config.json', import.meta.url), 'utf8'))

describe('enterprise development', () => {
  it('creates quota channels for concurrent first requests from a newly registered user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edq-'))
    await writeFile(join(root, 'web.json'), '[]')
    const quota = await startTeamDevQuota({ storageRoot: root, baseWebPatch: join(root, 'web.json'),
      users: [parseUserId('admin')], config: settings.quota, storageLock: settings.storageLock })
    try {
      const blocker = join(root, 'users', 'blocked', 'home', 'team-dev-web.patch.yml')
      await mkdir(blocker, { recursive: true })
      await expect(quota.ensureUser(parseUserId('blocked'))).rejects.toThrow()
      expect(quota.patches.has(parseUserId('blocked'))).toBe(false)
      expect(quota.channels.has(parseUserId('blocked'))).toBe(false)
      await rm(blocker, { recursive: true })
      expect(await quota.ensureUser(parseUserId('blocked'))).toContain('team-dev-web.patch.yml')
      const paths = await Promise.all([quota.ensureUser(parseUserId('new-user')), quota.ensureUser(parseUserId('new-user'))])
      expect(paths[0]).toBe(paths[1])
      const rows = JSON.parse(await readFile(paths[0]!, 'utf8'))
      const provider = rows.at(-1).insert[0].config
      const credential = JSON.parse(await readFile(provider.credentialFile, 'utf8'))
      const response = await fetch(`${provider.proxyBaseUrl}/messages`, { method: 'POST',
        headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: settings.quota.modelId, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('Local mock model response.')
      expect((await quota.usage(parseUserId('new-user'))).usedTokens).toBeGreaterThan(0)
    } finally { await quota.close(); await rm(root, { recursive: true, force: true }) }
    await expect(quota.ensureUser(parseUserId('after-close'))).rejects.toThrow(/closed/)
  })

  it('connects real account roles, quota and knowledge bases and preserves accounts across restarts', async () => {
    const { startEnterprise, parseEnterpriseConfig } = await import('../src/enterprise.ts')
    const root = await mkdtemp(join(tmpdir(), 'ede-'))
    await writeFile(join(root, 'web.json'), '[]')
    const config = parseEnterpriseConfig({ ...JSON.parse(await readFile(new URL('../../../deploy/enterprise-dev.config.json', import.meta.url), 'utf8')), port: 0, accounts: [
      { name: 'Admin', email: 'Admin@Example.test', role: 'admin' as const },
      { name: 'Member', email: 'member@example.test', role: 'member' as const },
    ], team: { ...settings, host: '127.0.0.1', storageRoot: join(root, 'runtime'),
      webPatch: join(root, 'web.json'), command: process.execPath,
      args: [resolve('../../apps/cli/lib/bin.js')] }, stateRoot: root })
    let service = await startEnterprise(config)
    const call = async (path: string, cookie?: string, body?: object) => fetch(`${service.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { origin: service.origin, ...cookie ? { cookie } : {}, ...body ? { 'content-type': 'application/json' } : {} },
      ...body ? { body: JSON.stringify(body) } : {},
    })
    const login = async (email: string, password: string) => {
      const reply = await call('/api/auth/sign-in/email', undefined, { email, password })
      expect(reply.status).toBe(200)
      return reply.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    try {
      await expect(startEnterprise(config)).rejects.toMatchObject({ code: 'ELOCKED' })
      const forgedHost = await new Promise<number>((resolve, reject) => {
        const req = request(`${service.origin}/account/login`, { headers: { host: 'untrusted.example' } }, res => {
          res.resume(); res.once('end', () => resolve(res.statusCode!))
        })
        req.once('error', reject); req.end()
      })
      expect(forgedHost).toBe(421)
      expect((await call('/account/login')).status).toBe(200)
      expect((await call('/api/admin/users')).status).toBe(401)
      expect((await call('/dev/select/alice')).status).not.toBe(200)
      const [admin, member] = service.accounts
      const adminCookie = await login(admin!.email, admin!.password)
      const memberCookie = await login(member!.email, member!.password)
      expect((await (await call('/account/api/me', adminCookie)).json()).role).toBe('admin')
      expect((await call('/api/admin/users', adminCookie)).status).toBe(200)
      expect((await call('/api/admin/users', memberCookie)).status).toBe(403)
      expect((await call('/api/admin/quota', adminCookie)).status).toBe(200)
      expect((await call('/api/admin/quota/default', adminCookie, { dailyTokens: 2000, password: admin!.password })).status).toBe(200)
      const created = await call('/account/api/me/kb', memberCookie, { title: 'Local notes' })
      expect(created.status).toBe(200)
      const kbId = (await created.json()).kb.id
      const upload = await fetch(`${service.origin}/account/api/me/kb/sources?kb=${kbId}&name=notes.md`, {
        method: 'POST', headers: { origin: service.origin, cookie: memberCookie, 'content-type': 'application/octet-stream' },
        body: '# Local project\n\nThe project keeps its notes in a knowledge base.\n',
      })
      expect(upload.status).toBe(200)
      expect((await call('/account/api/me/kb/compile', memberCookie, { kb: kbId, op: 'ingest' })).status).toBe(200)
      await expect.poll(async () => (await (await call(`/account/api/me/kb/jobs?kb=${kbId}`, memberCookie)).json()).jobs[0].state,
        { timeout: 30_000 }).toBe('succeeded')
      const usage = await (await call('/account/api/me/usage', memberCookie)).json()
      expect(usage.usedTokens).toBeGreaterThan(0)
      expect((await call('/api/admin/quota/default', adminCookie, { dailyTokens: 1, password: admin!.password })).status).toBe(200)
      expect((await call('/account/api/me/kb/compile', memberCookie, { kb: kbId, op: 'lint' })).status).toBe(200)
      await expect.poll(async () => (await (await call(`/account/api/me/kb/jobs?kb=${kbId}`, memberCookie)).json()).jobs[0].error,
        { timeout: 30_000 }).toBe('allowance')
      expect((await call('/api/admin/kb', adminCookie)).status).toBe(200)
      expect((await (await call('/account/api/me/kb', memberCookie)).json()).kbs).toHaveLength(1)
      expect((await call('/account/api/me', memberCookie.replace(/.$/, 'x'))).status).toBe(401)
      const before = service.accounts
      await service.close()
      service = await startEnterprise(config)
      expect(service.accounts).toEqual(before)
      const resumed = await login(member!.email, member!.password)
      expect((await (await call('/account/api/me/kb', resumed)).json()).kbs).toHaveLength(1)
      expect((await call('/api/auth/sign-out', resumed, {})).status).toBe(200)
      expect((await call('/account/api/me', resumed)).status).toBe(401)
    } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
  }, 90_000)
})
