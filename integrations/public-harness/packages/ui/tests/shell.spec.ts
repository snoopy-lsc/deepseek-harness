import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'Button', Tag: 'Tag', IconUserOutlineRegular: 'IconUser', IconShieldOutlineRegular: 'IconShield' }))
import { loadProfile } from '../src/client/me.ts'
import { installShell } from '../src/client/shell.ts'

function fakeContext() {
  const live = new Map<string, unknown>(), disposers: Array<() => void> = []
  const ctx = {
    effect(fn: () => () => void) { disposers.push(fn()) },
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    slots: { register(options: { name: string; key?: string; id?: string }) {
      const cell = `${options.name}:${options.key ?? options.id}`
      live.set(cell, options); return () => { live.delete(cell) }
    } },
  }
  return { ctx: ctx as unknown as Context, live, dispose: () => { for (const fn of disposers) fn() } }
}
const profile = (role: 'admin' | 'member') => ({ id: 'u1', email: 'a@example.test', name: 'A', role })

describe('unified shell entries', () => {
  it('everyone_gets_the_personal_entry_but_only_admins_get_administration', async () => {
    const member = fakeContext()
    await installShell(member.ctx, async () => profile('member'))
    expect([...member.live.keys()].sort()).toEqual(['main:team.profile', 'sidebar.panellist:team.profile'])
    const admin = fakeContext()
    await installShell(admin.ctx, async () => profile('admin'))
    expect([...admin.live.keys()].sort()).toEqual(['main:team.admin', 'main:team.profile', 'sidebar.panellist:team.admin', 'sidebar.panellist:team.profile'])
    admin.dispose()
    expect(admin.live.size).toBe(0)
  })

  it('no_profile_or_a_late_answer_registers_nothing', async () => {
    const anonymous = fakeContext()
    await installShell(anonymous.ctx, async () => undefined)
    expect(anonymous.live.size).toBe(0)
    const late = fakeContext()
    let answer!: (value: ReturnType<typeof profile>) => void
    const pending = installShell(late.ctx, () => new Promise(resolve => { answer = resolve }))
    late.dispose(); answer(profile('admin')); await pending
    expect(late.live.size).toBe(0)
  })

  it('profile_loader_accepts_only_a_well_formed_server_answer', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect(await loadProfile(reply(200, profile('admin')))).toEqual(profile('admin'))
    expect(await loadProfile(reply(401, { code: 'unauthenticated' }))).toBeUndefined()
    expect(await loadProfile(reply(200, { ...profile('member'), role: 'root' }))).toBeUndefined()
    expect(await loadProfile((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeUndefined()
  })
})
