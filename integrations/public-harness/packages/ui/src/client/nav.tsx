/** Personal and administration entries in the Harness sidebar, registered through published slots. */
import { IconDatabaseOutlineRegular, IconShieldOutlineRegular, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Sidebar and main-panel ids owned by this package. */
export const PROFILE_PANEL = 'team.profile' as MainPanelId
/** Standalone personal and team knowledge library. */
export const LIBRARY_PANEL = 'team.library' as MainPanelId
/** Administration panel id; registered only for the `admin` role. */
export const ADMIN_PANEL = 'team.admin' as MainPanelId

/** Locale-owned navigation copy. */
export const navDictionaries = {
  en: { profile: 'Personal', library: 'Library', admin: 'Administration', account: 'Account and sign-in sessions', role_admin: 'Administrator', role_member: 'Member', email: 'Email' },
  zh: { profile: '个人中心', library: '资料库', admin: '系统管理', account: '账户与登录会话', role_admin: '管理员', role_member: '成员', email: '邮箱' },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    publicHarnessNav: keyof typeof navDictionaries.en
  }
}

/** Sidebar glyph for the personal entry.
 * @param props - icon edge requested by the sidebar row.
 * @returns the Harness user icon.
 */
export function ProfileIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconUserOutlineRegular size={size} />
}

/** Library glyph in the global navigation.
 * @param props - Icon size requested by the sidebar.
 * @returns The shared database icon.
 */
export function LibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDatabaseOutlineRegular size={size} />
}

/** Sidebar glyph for the administration entry.
 * @param props - icon edge requested by the sidebar row.
 * @returns the Harness shield icon.
 */
export function AdminIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconShieldOutlineRegular size={size} />
}
