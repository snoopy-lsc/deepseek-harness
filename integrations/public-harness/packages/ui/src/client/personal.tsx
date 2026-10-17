/** Personal center inside the unified shell: account, sign-in method, sessions, usage and preferences.
 * Built from Harness primitives and the settings-row geometry (16px rows, 0.5px separators); only colours come from the theme. */
import { Button, IconBrowseOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular, IconLinkOutlineRegular, IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular, IconUserOutlineRegular, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { AccountApi, AccountProfile, AccountSecurity, AccountSession, AccountUsage } from './me.ts'
import { AccountApiError } from './me.ts'
import { overLimitText } from './quota.tsx'
import type { KbApi } from './kb-api.ts'
import { KnowledgeBases } from './kb.tsx'
import { kbCopy } from './kb-copy.ts'

/** Locale-owned personal center copy. */
export const personalDictionaries = {
  en: { title: 'Personal', account: 'Account', name: 'Name', email: 'Email', role: 'Role', role_admin: 'Administrator', role_member: 'Member',
    signIn: 'Sign-in', method: 'Sign-in method', method_password: 'Email and password', method_emergency: 'Emergency administrator account', method_sso: 'Company account ({provider})',
    bindings: 'Company account bindings', bound: 'Bound {date}', lastLogin: 'last sign-in {date}', never: 'not used yet', noBindings: 'No company account is bound.',
    ssoPassword: 'Your password is managed by your company account.',
    password: 'Change password', current: 'Current password', next: 'New password', confirm: 'Confirm new password', change: 'Change password',
    reauthHint: 'Enter your current password to confirm it is you. Other sessions are signed out.', mismatch: 'The new passwords do not match.',
    short: 'Use at least 12 characters.', reauth: 'The current password is wrong.', changed: 'Password changed. Other sessions were signed out.',
    sessions: 'Sessions and devices', thisDevice: 'This device', lastActive: 'Active {date}', unknownDevice: 'Unknown device', revoke: 'Sign out',
    revokeOthers: 'Sign out other sessions', revokedOthers: 'Signed out {count} other sessions.', noOthers: 'No other sessions.',
    usage: 'Usage', today: 'Today', resets: 'Resets {date}', tokens: '{used} / {limit} tokens', history: 'Last 7 days', noHistory: 'No usage in the last 7 days.', policy_block: 'At the limit new requests stop', policy_grace: 'Past the limit a grace share still runs', policy_warn: 'The limit is advisory: requests keep running with a warning',
    overGrace: 'You have used your daily allowance ({limit} tokens). A grace of {left} tokens remains today; after that new requests stop until {reset}.',
    overWarn: 'You have used your daily allowance ({limit} tokens). Requests still run, but please slow down; it resets {reset}.',
    overBlocked: 'Your daily allowance ({limit} tokens) is used up. New requests stop until {reset}.', noUsage: 'Usage is not available on this deployment.',
    preferences: 'Preferences', appearance: 'Appearance and language', appearanceHint: 'Theme, colour mode and interface language.', open: 'Open settings',
    failed: 'Something went wrong. Try again.', loading: 'Loading…', ...kbCopy.en },
  zh: { title: '个人中心', account: '账户', name: '名称', email: '邮箱', role: '角色', role_admin: '管理员', role_member: '成员',
    signIn: '登录与安全', method: '登录方式', method_password: '邮箱和密码', method_emergency: '管理员紧急账户', method_sso: '企业账号（{provider}）',
    bindings: '企业账号绑定', bound: '绑定于 {date}', lastLogin: '最近登录 {date}', never: '尚未使用', noBindings: '尚未绑定企业账号。',
    ssoPassword: '你的密码由企业账号统一管理。',
    password: '修改密码', current: '当前密码', next: '新密码', confirm: '确认新密码', change: '修改密码',
    reauthHint: '请输入当前密码以确认是你本人。修改后其他会话将退出登录。', mismatch: '两次输入的新密码不一致。',
    short: '密码至少 12 个字符。', reauth: '当前密码不正确。', changed: '密码已修改，其他会话已退出登录。',
    sessions: '会话与设备', thisDevice: '当前设备', lastActive: '活跃于 {date}', unknownDevice: '未知设备', revoke: '退出登录',
    revokeOthers: '退出其他会话', revokedOthers: '已退出 {count} 个其他会话。', noOthers: '没有其他会话。',
    usage: '用量', today: '今日', resets: '{date} 重置', tokens: '{used} / {limit} tokens', history: '最近 7 天', noHistory: '最近 7 天没有用量。', policy_block: '达到额度后新的请求将暂停', policy_grace: '超出额度后仍有一部分宽限额度', policy_warn: '额度仅作提醒：超出后请求仍会继续',
    overGrace: '你今日的额度（{limit} tokens）已用完，还剩 {left} tokens 的宽限额度；用完后新的请求将暂停，直到 {reset}。',
    overWarn: '你今日的额度（{limit} tokens）已用完。请求仍可继续，但请控制用量；额度将于 {reset} 重置。',
    overBlocked: '你今日的额度（{limit} tokens）已用完，新的请求将暂停，直到 {reset}。', noUsage: '此部署未提供用量信息。',
    preferences: '偏好设置', appearance: '外观与语言', appearanceHint: '主题、深浅色模式与界面语言。', open: '打开设置',
    failed: '操作失败，请重试。', loading: '加载中…', ...kbCopy.zh },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    publicHarnessPersonal: keyof typeof personalDictionaries.en
  }
}

type T = PropsLocale<'publicHarnessPersonal'>['t']
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
const date = (value: number | string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const PROVIDERS: Record<string, string> = { oidc: 'OIDC', saml: 'SAML', ldap: 'LDAP', wecom: 'WeCom', dingtalk: 'DingTalk' }

const page: CSSProperties = { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '40px 56px 64px', color: 'var(--dsw-alias-label-primary)' }
const column: CSSProperties = { maxWidth: 720, margin: '0 auto', display: 'grid', gap: 28 }
const card: CSSProperties = { background: 'var(--dsw-alias-settings-card-fill)', borderRadius: 'var(--dsw-radius-lg)', padding: '0 20px',
  boxShadow: 'var(--dsw-elevation-soft)', WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter)', backdropFilter: 'var(--dsw-menu-backdrop-filter)' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }
const last: CSSProperties = { ...row, borderBottom: 'none' }
const label: CSSProperties = { fontSize: 14, lineHeight: '20px' }
const hint: CSSProperties = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }
const heading: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px', fontSize: 14, lineHeight: '22px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }
const status = (ok: boolean): CSSProperties => ({ margin: 0, padding: '0 0 14px', fontSize: 12, lineHeight: '18px', color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' })

function Section({ icon, title, children, id }: { icon: ReactNode; title: string; children: ReactNode; id: string }) {
  return <section aria-labelledby={id}><h2 id={id} style={heading}>{icon}{title}</h2><div style={card}>{children}</div></section>
}
function Row({ title, detail, children, end }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; end?: boolean }) {
  return <div style={end ? last : row}><div style={{ minWidth: 0 }}><div style={label}>{title}</div>{detail !== undefined && <div style={hint}>{detail}</div>}</div>{children}</div>
}

/** Short device label from a user agent, without fingerprinting detail. */
export function deviceLabel(agent: string | null): string | undefined {
  if (agent === null || agent === '') return undefined
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : undefined
  const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X|Macintosh/.test(agent) ? 'macOS' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Linux/.test(agent) ? 'Linux' : undefined
  return [browser, system].filter(Boolean).join(' · ') || agent.slice(0, 40)
}

function PasswordForm({ api, t, onChanged }: { api: AccountApi; t: T; onChanged: () => void }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string }>(), [busy, setBusy] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (next.length < 12) { setResult({ ok: false, text: t('short') }); return }
    if (next !== confirm) { setResult({ ok: false, text: t('mismatch') }); return }
    setBusy(true)
    api.changePassword(current, next).then(() => { setResult({ ok: true, text: t('changed') }); onChanged(); setCurrent(''); setNext(''); setConfirm('') },
      (error: unknown) => setResult({ ok: false, text: error instanceof AccountApiError && error.code === 'reauth' ? t('reauth')
        : error instanceof AccountApiError && error.code === 'password-policy' ? t('short') : t('failed') })).finally(() => setBusy(false))
  }
  const field: CSSProperties = { display: 'grid', gap: 6, minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
  return <form onSubmit={submit} data-team-password style={{ padding: '16px 0' }}>
    <div style={label}>{t('password')}</div><div style={hint}>{t('reauthHint')}</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, margin: '14px 0' }}>
      <label style={field}>{t('current')}<Input size={1} type="password" name="current-password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></label>
      <label style={field}>{t('next')}<Input size={1} type="password" name="new-password" autoComplete="new-password" required value={next} onChange={e => setNext(e.target.value)} /></label>
      <label style={field}>{t('confirm')}<Input size={1} type="password" name="confirm-password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
    </div>
    {result !== undefined && <p role={result.ok ? 'status' : 'alert'} style={status(result.ok)}>{result.text}</p>}
    <Button type="submit" variant="primary" disabled={busy}>{t('change')}</Button>
  </form>
}

function Security({ api, t, onChanged }: { api: AccountApi; t: T; onChanged: () => void }) {
  const [security, setSecurity] = useState<AccountSecurity | null>()
  useEffect(() => { api.security().then(setSecurity, () => setSecurity(null)) }, [api])
  if (security === undefined) return <Row title={t('loading')} end />
  if (security === null) return <Row title={t('failed')} end />
  const provider = security.provider === 'password' || security.provider === 'emergency' ? t(`method_${security.provider}`) : fill(t('method_sso'), { provider: PROVIDERS[security.provider] ?? security.provider })
  return <>
    <Row title={t('method')}><span style={label}>{provider}</span></Row>
    {security.passwordChange ? <PasswordForm api={api} t={t} onChanged={onChanged} /> : <>
      <Row title={t('bindings')} detail={t('ssoPassword')} />
      {security.bindings.length === 0 ? <Row title={t('noBindings')} end /> : security.bindings.map((binding, index) =>
        <Row key={`${binding.provider}:${binding.subject}`} end={index === security.bindings.length - 1}
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><IconLinkOutlineRegular size={16} />{PROVIDERS[binding.provider] ?? binding.provider}<Tag>{binding.subject}</Tag></span>}
          detail={`${fill(t('bound'), { date: date(binding.createdAt) })} · ${binding.lastLoginAt === null ? t('never') : fill(t('lastLogin'), { date: date(binding.lastLoginAt) })}`} />)}
    </>}
  </>
}

function Sessions({ api, t, version }: { api: AccountApi; t: T; version: number }) {
  const [sessions, setSessions] = useState<readonly AccountSession[] | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>()
  // `version` changes after a password change, which signs the other sessions out.
  const load = useCallback(() => { api.sessions().then(setSessions, () => setSessions(null)) }, [api, version])
  useEffect(load, [load])
  if (sessions === undefined) return <Row title={t('loading')} end />
  if (sessions === null) return <Row title={t('failed')} end />
  const others = sessions.filter(s => !s.current).length
  return <>
    {sessions.map(session => <Row key={session.id} title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{deviceLabel(session.userAgent) ?? t('unknownDevice')}{session.current && <Tag>{t('thisDevice')}</Tag>}</span>}
      detail={[fill(t('lastActive'), { date: date(session.lastActiveAt) }), session.ipAddress].filter(Boolean).join(' · ')}>
      {!session.current && <Button variant="outline" size="sm" onClick={() => { api.revoke(session.id).then(load, () => setNote({ ok: false, text: t('failed') })) }}>{t('revoke')}</Button>}
    </Row>)}
    <div style={{ ...last, flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
      {note !== undefined && <p role={note.ok ? 'status' : 'alert'} style={status(note.ok)}>{note.text}</p>}
      <div><Button variant="outline" disabled={others === 0} onClick={() => { api.revokeOthers().then(count => { setNote({ ok: true, text: fill(t('revokedOthers'), { count }) }); load() }, () => setNote({ ok: false, text: t('failed') })) }}>
        {others === 0 ? t('noOthers') : t('revokeOthers')}</Button></div>
    </div>
  </>
}

function Usage({ api, t }: { api: AccountApi; t: T }) {
  const [usage, setUsage] = useState<AccountUsage | null>()
  useEffect(() => { api.usage().then(value => setUsage(value ?? null), () => setUsage(null)) }, [api])
  if (usage === undefined) return <Row title={t('loading')} end />
  if (usage === null) return <Row title={t('noUsage')} end />
  const share = Math.min(1, usage.limitTokens === 0 ? 0 : usage.usedTokens / usage.limitTokens)
  const peak = Math.max(1, ...usage.history.map(day => day.tokens))
  const over = overLimitText(usage, t)
  return <>
    {over !== undefined && <p role={usage.state === 'blocked' ? 'alert' : 'status'} data-team-personal-over={usage.state} style={{ margin: '12px 0 0', padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: '20px',
      background: 'var(--dsw-alias-interactive-bg-hover)', color: usage.state === 'blocked' ? 'var(--dsw-alias-state-error, #d92d20)' : 'var(--dsw-alias-label-primary)' }}>
      <Tag tone={usage.state === 'blocked' ? 'danger' : 'warning'}>{t(`policy_${usage.overLimit ?? 'block'}`)}</Tag> {over}</p>}
    <Row title={t('today')} detail={fill(t('resets'), { date: date(usage.resetAt) })}>
      <span style={label}>{fill(t('tokens'), { used: usage.usedTokens.toLocaleString(), limit: usage.limitTokens.toLocaleString() })}</span>
    </Row>
    <div style={{ padding: '0 0 16px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }}>
      <div role="meter" aria-valuemin={0} aria-valuemax={usage.limitTokens} aria-valuenow={usage.usedTokens} aria-label={t('today')}
        style={{ height: 6, borderRadius: 3, background: 'var(--dsw-alias-interactive-bg-hover)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(share * 100)}%`, height: '100%', background: usage.state === 'blocked' || usage.state === 'grace' || usage.state === 'over' ? 'var(--dsw-alias-state-warning, #f79009)' : 'var(--dsw-alias-button-primary-fill)' }} />
      </div>
    </div>
    <div style={{ ...last, flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={label}>{t('history')}</div>
      {usage.history.length === 0 && <div style={hint}>{t('noHistory')}</div>}
      {usage.history.map(day => <div key={day.day} style={{ display: 'grid', gridTemplateColumns: '96px 1fr 120px', alignItems: 'center', gap: 12, fontSize: 12, lineHeight: '18px' }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{day.day}</span>
        <span style={{ height: 6, borderRadius: 3, width: `${Math.max(2, Math.round(day.tokens / peak * 100))}%`, background: 'var(--dsw-alias-button-primary-fill)' }} />
        <span style={{ textAlign: 'right' }}>{day.tokens.toLocaleString()}</span>
      </div>)}
    </div>
  </>
}

/** The personal center page.
 * @param props - profile, client, settings opener and translator.
 * @returns the personal panel.
 */
export function PersonalCenter({ profile, api, kb, openSettings, t }: { profile: AccountProfile; api: AccountApi; kb?: KbApi; openSettings: () => void } & PropsLocale<'publicHarnessPersonal'>) {
  const [version, setVersion] = useState(0)
  const initial = (profile.name || profile.email).trim().charAt(0).toUpperCase()
  return <div style={page} data-team-personal>
    <div style={column}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: '50%', background: 'var(--dsw-alias-button-primary-fill)',
          color: 'var(--dsw-alias-label-primary-foreground)', fontSize: 20, fontWeight: 600 }}>{initial}</span>
        <div><h1 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }}>{profile.name}</h1>
          <div style={{ ...hint, marginTop: 2 }}>{profile.email}</div></div>
        <Tag>{t(profile.role === 'admin' ? 'role_admin' : 'role_member')}</Tag>
      </header>
      <Section id="team-personal-account" icon={<IconUserOutlineRegular size={16} />} title={t('account')}>
        <Row title={t('name')}><span style={label}>{profile.name}</span></Row>
        <Row title={t('email')}><span style={label}>{profile.email}</span></Row>
        <Row title={t('role')} end><span style={label}>{t(profile.role === 'admin' ? 'role_admin' : 'role_member')}</span></Row>
      </Section>
      <Section id="team-personal-security" icon={<IconShieldOutlineRegular size={16} />} title={t('signIn')}><Security api={api} t={t} onChanged={() => setVersion(v => v + 1)} /></Section>
      <Section id="team-personal-sessions" icon={<IconBrowseOutlineRegular size={16} />} title={t('sessions')}><Sessions api={api} t={t} version={version} /></Section>
      <Section id="team-personal-usage" icon={<IconGaugeOutlineRegular size={16} />} title={t('usage')}><Usage api={api} t={t} /></Section>
      {kb !== undefined && <KnowledgeBases api={kb} t={t} frame={body => <Section id="team-personal-kb" icon={<IconDatabaseOutlineRegular size={16} />} title={t('kb_title')}>{body}</Section>} />}
      <Section id="team-personal-preferences" icon={<IconSlidersTwoOutlineRegular size={16} />} title={t('preferences')}>
        <Row title={t('appearance')} detail={t('appearanceHint')} end><Button variant="outline" onClick={openSettings}>{t('open')}</Button></Row>
      </Section>
    </div>
  </div>
}
