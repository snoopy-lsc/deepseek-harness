import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'Button', Tag: 'Tag', Input: 'Input', IconUserOutlineRegular: 'IconUser', IconShieldOutlineRegular: 'IconShield',
  IconBrowseOutlineRegular: 'I', IconGaugeOutlineRegular: 'I', IconLinkOutlineRegular: 'I', IconSlidersTwoOutlineRegular: 'I',
  IconChecklistOutlineRegular: 'I', IconChevronLeftOutlineRegular: 'I', IconPlusOutlineRegular: 'I', IconSearchOutlineRegular: 'I', IconUsersOutlineRegular: 'I',
  Modal: 'Modal', SegmentedControl: 'SegmentedControl', writeClipboard: async () => true }))
import { loadProfile } from '../src/client/me.ts'
import { installShell } from '../src/client/shell.ts'

function fakeContext() {
  const live = new Map<string, unknown>(), disposers: Array<() => void> = []
  const invoked: string[] = []
  let active: string | null = null
  const listeners = new Set<() => void>()
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: active }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } },
    selectPanel: (id: string | null) => { active = id; for (const fn of listeners) fn() } }
  const ctx = {
    layout,
    effect(fn: () => () => void) { disposers.push(fn()) },
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    slots: { register(options: { name: string; key?: string; id?: string }) {
      const cell = `${options.name}:${options.key ?? options.id ?? ''}`
      live.set(cell, options); return () => { live.delete(cell) }
    } },
  }
  return { ctx: ctx as unknown as Context, live, invoked, layout, listeners, dispose: () => { for (const fn of disposers) fn() } }
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

  it('administration_submenu_replaces_the_session_browser_in_the_same_sidebar_while_open', async () => {
    const admin = fakeContext()
    await installShell(admin.ctx, async () => profile('admin'))
    expect(admin.live.has('sidebar.workspaces:')).toBe(false)
    admin.layout.selectPanel('team.admin')
    const menu = admin.live.get('sidebar.workspaces:') as { priority: number; inject: () => { back: () => void; section: { get(): string; set(v: string): void } } }
    expect(menu.priority).toBeLessThan(0)
    const injected = menu.inject()
    injected.section.set('audit')
    const page = (admin.live.get('main:team.admin') as { inject: () => { section: { get(): string } } }).inject()
    expect(page.section.get()).toBe('audit')
    injected.back()
    expect(admin.layout.panelInfo.getSnapshot().activePanelId).toBeNull()
    expect(admin.live.has('sidebar.workspaces:')).toBe(false)
    admin.layout.selectPanel('team.admin'); admin.dispose()
    expect(admin.live.size).toBe(0)
    expect(admin.listeners.size).toBe(0)
  })

  it('members_never_get_the_submenu', async () => {
    const member = fakeContext()
    await installShell(member.ctx, async () => profile('member'))
    member.layout.selectPanel('team.admin')
    expect(member.live.has('sidebar.workspaces:')).toBe(false)
    expect(member.listeners.size).toBe(0)
  })

  it('personal_center_gets_the_account_client_and_opens_the_harness_settings_dialog', async () => {
    const shell = fakeContext()
    await installShell(shell.ctx, async () => profile('member'))
    const injected = (shell.live.get('main:team.profile') as { inject: () => { api: object; openSettings: () => void } }).inject()
    expect(Object.keys(injected.api).sort()).toEqual(['changePassword', 'revoke', 'revokeOthers', 'security', 'sessions', 'usage'])
    vi.stubGlobal('document', { querySelector: (selector: string) => ({ click: () => { shell.invoked.push(selector) } }) })
    injected.openSettings()
    vi.unstubAllGlobals()
    expect(shell.invoked).toEqual(['[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]'])
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
