/** Register the personal entry for everyone and the administration entry for administrators. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createAccountApi, loadProfile, type AccountApi, type AccountProfile } from './me.ts'
import { PersonalCenter, personalDictionaries } from './personal.tsx'
import { ADMIN_PANEL, AdminIcon, PROFILE_PANEL, ProfileIcon, navDictionaries } from './nav.tsx'
import { AdminMenu, AdminPage, adminDictionaries, createSectionState } from './admin.tsx'
import { createAdminApi, type AdminApi } from './admin-api.ts'
import { OverLimitNotice } from './quota.tsx'

const NS = 'publicHarnessNav'
const ADMIN_NS = 'publicHarnessAdmin'
/** The part of `ctx.layout` the administration submenu follows. */
interface AdminLayout { readonly panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(fn: () => void): () => void }; selectPanel(id: null): void }
/** Harness's own settings trigger: the dialog button inside the published `sidebar.settings` slot. */
export const SETTINGS_TRIGGER = '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]'

/** Register one profile's entries; the administration entry exists only for the server-decided `admin` role.
 * @param ctx - browser root carrying slots and locale.
 * @param profile - the signed-in profile.
 * @returns disposers for every registration.
 */
export function registerEntries(ctx: Context, profile: AccountProfile, api: AccountApi = createAccountApi(), admin: AdminApi = createAdminApi()): Array<() => void> {
  const t = ctx.locale.bind(NS)
  // Appearance and language live in the Harness settings dialog; pressing its own trigger opens it, so no settings UI is duplicated here.
  const openSettings = () => { globalThis.document?.querySelector<HTMLElement>(SETTINGS_TRIGGER)?.click() }
  const off = [
    ctx.slots.register({ name: 'main', key: PROFILE_PANEL, locale: 'publicHarnessPersonal', inject: () => ({ profile, api, openSettings }) }, PersonalCenter),
    ctx.slots.register({ name: 'sidebar.panellist', id: PROFILE_PANEL, order: 80, locale: NS, label: () => t('profile') }, ProfileIcon),
    ctx.slots.register({ name: 'shell.overlay', id: 'team.over-limit', locale: 'publicHarness', inject: () => ({ api }) }, OverLimitNotice),
  ]
  if (profile.role === 'admin') {
    const section = createSectionState()
    off.push(
      ctx.slots.register({ name: 'main', key: ADMIN_PANEL, locale: ADMIN_NS, inject: () => ({ api: admin, section }) }, AdminPage),
      ctx.slots.register({ name: 'sidebar.panellist', id: ADMIN_PANEL, order: 90, locale: NS, label: () => t('admin') }, AdminIcon))
    // While administration is open, its submenu shadows the session browser in the same sidebar (a lower priority renders first);
    // the back row returns to the conversation, which removes the shadow again.
    const layout = (ctx as Context & { layout?: AdminLayout }).layout
    if (layout !== undefined) {
      let menu: (() => void) | undefined
      const sync = () => {
        const open = layout.panelInfo.getSnapshot().activePanelId === ADMIN_PANEL
        if (open && menu === undefined) menu = ctx.slots.register({ name: 'sidebar.workspaces', priority: -1, locale: ADMIN_NS, inject: () => ({ section, back: () => layout.selectPanel(null) }) }, AdminMenu)
        else if (!open && menu !== undefined) { menu(); menu = undefined }
      }
      const unsubscribe = layout.panelInfo.subscribe(sync)
      sync()
      off.push(() => { unsubscribe(); menu?.(); menu = undefined })
    }
  }
  return off
}

/** Load the profile once and register the entries for the plugin lifetime.
 * @param ctx - browser root carrying slots and locale.
 * @param load - profile loader, injectable for tests.
 * @returns settles after the entries are registered (or skipped).
 */
export function installShell(ctx: Context, load: () => Promise<AccountProfile | undefined> = loadProfile): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, navDictionaries), 'public-harness: navigation copy')
  ctx.effect(() => ctx.locale.register('publicHarnessPersonal', personalDictionaries), 'public-harness: personal center copy')
  ctx.effect(() => ctx.locale.register(ADMIN_NS, adminDictionaries), 'public-harness: administration copy')
  let off: Array<() => void> = [], live = true
  ctx.effect(() => () => { live = false; for (const dispose of off) dispose(); off = [] }, 'public-harness: navigation entries')
  return load().then(profile => { if (live && profile !== undefined) off = registerEntries(ctx, profile) })
}
