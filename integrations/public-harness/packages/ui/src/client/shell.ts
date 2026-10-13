/** Register the personal entry for everyone and the administration entry for administrators. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { loadProfile, type AccountProfile } from './me.ts'
import { ADMIN_PANEL, AdminIcon, AdminPage, PROFILE_PANEL, ProfileIcon, ProfilePage, navDictionaries } from './nav.tsx'

const NS = 'publicHarnessNav'

/** Register one profile's entries; the administration entry exists only for the server-decided `admin` role.
 * @param ctx - browser root carrying slots and locale.
 * @param profile - the signed-in profile.
 * @returns disposers for every registration.
 */
export function registerEntries(ctx: Context, profile: AccountProfile): Array<() => void> {
  const t = ctx.locale.bind(NS)
  const off = [
    ctx.slots.register({ name: 'main', key: PROFILE_PANEL, locale: NS, inject: () => ({ profile }) }, ProfilePage),
    ctx.slots.register({ name: 'sidebar.panellist', id: PROFILE_PANEL, order: 80, locale: NS, label: () => t('profile') }, ProfileIcon),
  ]
  if (profile.role === 'admin') off.push(
    ctx.slots.register({ name: 'main', key: ADMIN_PANEL, locale: NS }, AdminPage),
    ctx.slots.register({ name: 'sidebar.panellist', id: ADMIN_PANEL, order: 90, locale: NS, label: () => t('admin') }, AdminIcon))
  return off
}

/** Load the profile once and register the entries for the plugin lifetime.
 * @param ctx - browser root carrying slots and locale.
 * @param load - profile loader, injectable for tests.
 * @returns settles after the entries are registered (or skipped).
 */
export function installShell(ctx: Context, load: () => Promise<AccountProfile | undefined> = loadProfile): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, navDictionaries), 'public-harness: navigation copy')
  let off: Array<() => void> = [], live = true
  ctx.effect(() => () => { live = false; for (const dispose of off) dispose(); off = [] }, 'public-harness: navigation entries')
  return load().then(profile => { if (live && profile !== undefined) off = registerEntries(ctx, profile) })
}
