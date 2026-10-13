import { afterEach, describe, expect, it } from 'vitest'
import { IdentityConfigError } from '../src/config.ts'
import { startIdentity } from '../src/index.ts'
import { call, linkIn, mailbox, sessionCookie, setup } from './helpers.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const service of open.splice(0)) await service.close() })
const CAPTCHA = { 'x-captcha-response': 'pass-captcha', 'x-forwarded-for': '203.0.113.7' }

async function signedIn(env: Record<string, string>, email: string) {
  const { config } = await setup({}, env), box = mailbox()
  const service = await startIdentity(config, { mail: box.mail }); open.push(service)
  await call(config.publicSocket, 'POST', '/api/auth/sign-up/email', { name: 'Ann', email, password: 'correct horse battery', callbackURL: '/account/verified' }, CAPTCHA)
  const verify = linkIn(box.sent[0]!)
  await call(config.publicSocket, 'GET', verify.pathname + verify.search)
  const login = await call(config.publicSocket, 'POST', '/api/auth/sign-in/email', { email, password: 'correct horse battery' }, { 'x-forwarded-for': '203.0.113.7' })
  return { config, cookie: sessionCookie(login)!, login: JSON.parse(login.body) as { user: { id: string } } }
}
const me = (socket: string, cookie?: string) => call(socket, 'GET', '/account/api/me', undefined, cookie === undefined ? {} : { cookie })

describe('server-side role', () => {
  it('profile_endpoint_requires_a_session', async () => {
    const { config } = await signedIn({}, 'm@example.test')
    const reply = await me(config.publicSocket)
    expect(reply.status).toBe(401)
    expect((await me(config.publicSocket, 'dsh-account.session_token=forged')).status).toBe(401)
  })

  it('member_and_admin_roles_come_from_the_server', async () => {
    const member = await signedIn({ DSH_ADMIN_EMAILS: 'boss@example.test' }, 'm@example.test')
    const reply = await me(member.config.publicSocket, member.cookie)
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(reply.body)).toEqual({ id: member.login.user.id, email: 'm@example.test', name: 'Ann', role: 'member', provider: 'password', passwordChange: true })
    const admin = await signedIn({ DSH_ADMIN_EMAILS: ' Boss@Example.test , other@example.test' }, 'boss@example.test')
    expect(JSON.parse((await me(admin.config.publicSocket, admin.cookie)).body)).toMatchObject({ role: 'admin' })
  })

  it('malformed_admin_list_refuses_startup', async () => {
    await expect(setup({}, { DSH_ADMIN_EMAILS: 'not-an-address' })).rejects.toThrow(IdentityConfigError)
    await expect(setup({}, { DSH_ADMIN_EMAILS: 'a@example.test,,b@example.test' })).rejects.toThrow('DSH_ADMIN_EMAILS')
  })
})
