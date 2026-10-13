/** Personal and administration entries in the Harness sidebar, registered through published slots. */
import { IconShieldOutlineRegular, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CSSProperties } from 'react'

/** Sidebar and main-panel ids owned by this package. */
export const PROFILE_PANEL = 'team.profile' as MainPanelId
/** Administration panel id; registered only for the `admin` role. */
export const ADMIN_PANEL = 'team.admin' as MainPanelId

/** Locale-owned navigation copy. */
export const navDictionaries = {
  en: { profile: 'Personal', admin: 'Administration', account: 'Account and sign-in sessions', role_admin: 'Administrator', role_member: 'Member',
    adminSoon: 'User, audit and quota management arrive in the next release. Access is checked on the server.', email: 'Email' },
  zh: { profile: '个人中心', admin: '系统管理', account: '账户与登录会话', role_admin: '管理员', role_member: '成员',
    adminSoon: '用户、审计与额度管理将在下一版本提供；访问权限由服务端校验。', email: '邮箱' },
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

/** Sidebar glyph for the administration entry.
 * @param props - icon edge requested by the sidebar row.
 * @returns the Harness shield icon.
 */
export function AdminIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconShieldOutlineRegular size={size} />
}

const page: CSSProperties = { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '48px 56px', color: 'var(--dsw-alias-label-primary)' }
const title: CSSProperties = { margin: '0 0 24px', fontSize: 20, fontWeight: 600 }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }

/** Administration placeholder until the administration pages land; the server still decides access.
 * @param props - locale translator.
 * @returns the administration panel.
 */
export function AdminPage({ t }: PropsLocale<'publicHarnessNav'>) {
  return <section style={page} aria-labelledby="team-admin-title">
    <h1 id="team-admin-title" style={title}>{t('admin')}</h1>
    <p style={muted}>{t('adminSoon')}</p>
  </section>
}
