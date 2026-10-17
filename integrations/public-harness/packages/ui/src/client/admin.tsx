/** System administration inside the unified shell. While the administration panel is open its submenu takes the place of the session
 * browser in the same sidebar (no second column), with a row that returns to the conversation. Sections: invites, users, audit log,
 * SSO configuration (read-only) and daily allowances. Built from Harness primitives and the settings-row geometry; only colours come from the theme.
 * Every refusal comes from the server; disable, role changes and allowance changes may ask the administrator to re-authenticate. */
import { Button, IconChecklistOutlineRegular, IconChevronLeftOutlineRegular, IconGaugeOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular,
  IconDatabaseOutlineRegular, IconSearchOutlineRegular, IconShareOutlineRegular, IconUsersOutlineRegular, IconWorkspaceTreeOutlineRegular, Input, Modal, SegmentedControl, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { groupAdminCopy } from './admin-kb-copy.ts'
import { groupName, Groups } from './admin-groups.tsx'
import { KbRequests } from './admin-kb.tsx'
import { KbInventory } from './admin-kb-inventory.tsx'
import { KbLimitsCard } from './admin-kb-limits.tsx'
import { card, column, date, errorText, field, fill, hint, label, Note, page, Row, Card, select, type T, useReauth } from './admin-kit.tsx'
import { type AdminApi, type AdminAuditPage, type AdminInvite, type AdminQuota, type AdminSso, type AdminUser, type AdminUserPage, type OverLimitMode, type Proof } from './admin-api.ts'

/** Locale-owned administration copy. */
export const adminDictionaries = {
  en: {
    title: 'Administration', back: 'Back to sessions', menu: 'Administration sections',
    invites: 'Invites', users: 'Users', audit: 'Audit log', sso: 'SSO', quota: 'Quotas',
    inviteNew: 'New invite', inviteNote: 'Note', inviteHours: 'Valid for (hours)', create: 'Create invite', inviteCode: 'Invite code — shown once', copy: 'Copy', copied: 'Copied',
    noInvites: 'No invites yet.', expires: 'Expires {date}', created: 'Created {date}', usedBy: 'Used by {email}', revoke: 'Revoke',
    st_active: 'Active', st_used: 'Used', st_revoked: 'Revoked', st_expired: 'Expired', st_disabled: 'Disabled',
    search: 'Search name or email', all: 'All', admins: 'Admins', members: 'Members', active: 'Active', disabled: 'Disabled',
    role_admin: 'Administrator', role_member: 'Member', src_config: 'from DSH_ADMIN_EMAILS', src_emergency: 'emergency account', src_grant: 'granted here',
    lastLogin: 'Last sign-in {date}', neverLogin: 'Never signed in', you: 'You', disable: 'Disable', enable: 'Enable', makeAdmin: 'Make administrator', removeAdmin: 'Remove administrator',
    page: '{from}–{to} of {total}', prev: 'Previous', next: 'Next', noUsers: 'No matching users.',
    disableTitle: 'Disable {email}?', disableBody: 'Every session of this account ends now and it cannot sign in until it is enabled again.', reason: 'Reason', confirmDisable: 'Disable account', cancel: 'Cancel',
    reauthTitle: 'Confirm it is you', reauthPassword: 'Enter your password to continue.', password: 'Password', confirm: 'Confirm',
    reauthSso: 'This action needs a recent sign-in. Sign in again with your company account, then repeat it.', signInAgain: 'Sign in again', reauthWrong: 'The password is wrong.',
    err_last_admin: 'This is the last active administrator. Add another administrator first.', 'err_config_admin': 'Administrators from DSH_ADMIN_EMAILS are changed in the service configuration.',
    'err_emergency_admin': 'Emergency administrator accounts keep their role.', err_self: 'You cannot disable your own account.', 'err_rate_limited': 'Too many changes. Try again later.',
    failed: 'Something went wrong. Try again.', loading: 'Loading…', done: 'Saved.',
    event: 'Event', allEvents: 'All events', outcome: 'Outcome', ok: 'OK', denied: 'Denied', error: 'Error', filter: 'Filter by email or detail', more: 'Load more', noAudit: 'No audit entries.',
    provider: 'Provider', off: 'Not configured', redactedNote: 'Secrets are never shown.', reconcile: 'Directory reconciliation', scheduled: 'Every {minutes} min', notScheduled: 'Not scheduled',
    lastRun: 'Last run', noRun: 'No run yet', deprovision: 'Deprovisioning policy', inactive: 'Disable after {days} days without sign-in', inactiveOff: 'Inactivity rule off', maxPerRun: 'At most {n} disables per run',
    emergency: 'Emergency sign-in', emergencyOn: 'Allowed from {ips}', emergencyOff: 'Off', enrollment: 'Public enrollment', open: 'Open', closed: 'Closed', configAdmins: 'Configured administrators', disabledCount: 'Disabled accounts',
    configured: 'Configured daily limit', defaultLimit: 'Default daily limit', defaultHint: 'Applies to everyone without a personal limit; at most the site limit.', tokens: '{n} tokens',
    save: 'Save', reset: 'Use configured', perUser: 'Personal limits', addOverride: 'Set a personal limit', user: 'User', dailyTokens: 'Daily tokens', remove: 'Remove', noOverrides: 'No personal limits.',
    noQuota: 'The quota ledger is not connected to this deployment.', invalidTokens: 'Enter a whole number above zero.',
    overLimit: 'When someone reaches their limit', mode_block: 'Block', mode_grace: 'Grace', mode_warn: 'Warn only',
    modeHint_block: 'New requests are refused until the daily reset. Users see the allowance notice.',
    modeHint_grace: 'Requests keep running for an extra share of the limit, with a warning; then they are refused.',
    modeHint_warn: 'The personal limit is advisory: requests keep running with a warning. The site daily limit still refuses.',
    gracePercent: 'Grace (% of the limit)', invalidGrace: 'Enter a whole percentage from 1 to 100.',
    exportCsv: 'Export CSV', exportHint: 'Exports the entries matching these filters (newest first, at most 50,000 rows). The export is recorded in this log.',
    ...groupAdminCopy.en,
  },
  zh: {
    title: '系统管理', back: '返回会话', menu: '系统管理分区',
    invites: '邀请码', users: '用户', audit: '审计日志', sso: '单点登录', quota: '额度',
    inviteNew: '新建邀请码', inviteNote: '备注', inviteHours: '有效期（小时）', create: '创建邀请码', inviteCode: '邀请码（仅显示一次）', copy: '复制', copied: '已复制',
    noInvites: '还没有邀请码。', expires: '{date} 过期', created: '创建于 {date}', usedBy: '已被 {email} 使用', revoke: '作废',
    st_active: '可用', st_used: '已使用', st_revoked: '已作废', st_expired: '已过期', st_disabled: '已停用',
    search: '搜索名称或邮箱', all: '全部', admins: '管理员', members: '成员', active: '正常', disabled: '已停用',
    role_admin: '管理员', role_member: '成员', src_config: '来自 DSH_ADMIN_EMAILS', src_emergency: '紧急账户', src_grant: '在此授予',
    lastLogin: '最近登录 {date}', neverLogin: '从未登录', you: '你', disable: '停用', enable: '启用', makeAdmin: '设为管理员', removeAdmin: '取消管理员',
    page: '第 {from}–{to} 条，共 {total} 条', prev: '上一页', next: '下一页', noUsers: '没有匹配的用户。',
    disableTitle: '停用 {email}？', disableBody: '该账户的所有会话会立即结束，重新启用前无法登录。', reason: '原因', confirmDisable: '停用账户', cancel: '取消',
    reauthTitle: '确认是你本人', reauthPassword: '请输入你的密码以继续。', password: '密码', confirm: '确认',
    reauthSso: '此操作需要最近登录过。请用企业账号重新登录后再操作。', signInAgain: '重新登录', reauthWrong: '密码不正确。',
    err_last_admin: '这是最后一位有效管理员，请先添加其他管理员。', 'err_config_admin': '来自 DSH_ADMIN_EMAILS 的管理员需在服务配置中修改。',
    'err_emergency_admin': '紧急管理员账户的角色不能更改。', err_self: '不能停用自己的账户。', 'err_rate_limited': '操作过于频繁，请稍后再试。',
    failed: '操作失败，请重试。', loading: '加载中…', done: '已保存。',
    event: '事件', allEvents: '全部事件', outcome: '结果', ok: '成功', denied: '拒绝', error: '错误', filter: '按邮箱或详情筛选', more: '加载更多', noAudit: '没有审计记录。',
    provider: '身份源', off: '未配置', redactedNote: '密钥从不显示。', reconcile: '目录同步', scheduled: '每 {minutes} 分钟', notScheduled: '未启用',
    lastRun: '最近一次', noRun: '尚未运行', deprovision: '自动停用策略', inactive: '{days} 天未登录即停用', inactiveOff: '未启用不活跃规则', maxPerRun: '每次最多停用 {n} 个',
    emergency: '紧急登录', emergencyOn: '允许来源 {ips}', emergencyOff: '关闭', enrollment: '公开注册', open: '开放', closed: '关闭', configAdmins: '配置的管理员', disabledCount: '已停用账户',
    configured: '配置的每日额度', defaultLimit: '默认每日额度', defaultHint: '适用于没有个人额度的所有人；不能超过站点额度。', tokens: '{n} tokens',
    save: '保存', reset: '恢复配置值', perUser: '个人额度', addOverride: '设置个人额度', user: '用户', dailyTokens: '每日 tokens', remove: '移除', noOverrides: '没有个人额度。',
    noQuota: '此部署未连接额度账本。', invalidTokens: '请输入大于零的整数。',
    overLimit: '用户达到额度后', mode_block: '阻止', mode_grace: '宽限', mode_warn: '仅提醒',
    modeHint_block: '在每日重置前拒绝新的请求，用户会看到额度提示。',
    modeHint_grace: '在额度之外再允许一定比例的用量并提醒用户，超出后拒绝。',
    modeHint_warn: '个人额度仅作提醒：请求继续并提示用户；站点每日额度仍会拒绝。',
    gracePercent: '宽限比例（额度的 %）', invalidGrace: '请输入 1 到 100 之间的整数百分比。',
    exportCsv: '导出 CSV', exportHint: '导出符合当前筛选条件的记录（最新在前，最多 50,000 条）。导出操作本身也会记录在此日志中。',
    ...groupAdminCopy.zh,
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    publicHarnessAdmin: keyof typeof adminDictionaries.en
  }
}

/** Administration sections, in menu order. */
export const ADMIN_SECTIONS = ['users', 'groups', 'kb', 'kbRequests', 'invites', 'audit', 'sso', 'quota'] as const
export type AdminSection = typeof ADMIN_SECTIONS[number]

/** The selected section, shared by the sidebar submenu and the main panel. */
export interface SectionState { get(): AdminSection; set(next: AdminSection): void; subscribe(fn: () => void): () => void }
export function createSectionState(initial: AdminSection = 'users'): SectionState {
  let value = initial
  const listeners = new Set<() => void>()
  return { get: () => value, set: next => { if (next !== value) { value = next; for (const fn of listeners) fn() } }, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } }
}
const useSection = (state: SectionState) => useSyncExternalStore(state.subscribe, state.get, state.get)

const PROVIDERS: Record<string, string> = { oidc: 'OIDC', saml: 'SAML', ldap: 'LDAP', wecom: 'WeCom', dingtalk: 'DingTalk', password: 'Password', emergency: 'Emergency' }
const ICONS: Record<AdminSection, (size: number) => ReactNode> = {
  users: size => <IconUsersOutlineRegular size={size} />, invites: size => <IconPlusOutlineRegular size={size} />, audit: size => <IconChecklistOutlineRegular size={size} />,
  sso: size => <IconLinkOutlineRegular size={size} />, quota: size => <IconGaugeOutlineRegular size={size} />, groups: size => <IconWorkspaceTreeOutlineRegular size={size} />,
  kbRequests: size => <IconShareOutlineRegular size={size} />, kb: size => <IconDatabaseOutlineRegular size={size} />,
}
/* Sidebar submenu: rows share the sidebar's panel-row geometry (36px, 12px radius, hover surface). */
function MenuRow({ icon, label, active, onClick, wide, testId }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; wide: boolean; testId: string }) {
  const [hover, setHover] = useState(false)
  const style: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '0 2px 0 6px', minHeight: 36, padding: wide ? '7px 8px' : 0, boxSizing: 'border-box', border: 'none',
    width: wide ? undefined : 36, height: wide ? undefined : 36, justifyContent: wide ? 'flex-start' : 'center',
    borderRadius: 'var(--dsw-radius-md)', background: active || hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', lineHeight: '22px', textAlign: 'left', cursor: 'pointer' }
  return <button type="button" data-team-admin-menu={testId} aria-current={active ? 'page' : undefined} aria-label={label} title={wide ? undefined : label} style={style}
    onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <span aria-hidden="true" style={{ display: 'inline-flex' }}>{icon}</span>{wide && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
  </button>
}

/** Occupant of `sidebar.workspaces` while the administration panel is open: the section list and a way back.
 * @param props - column state from the sidebar plus the shared section state and the back action.
 * @returns the submenu.
 */
export function AdminMenu({ wide, section, back, t }: { wide: boolean; section: SectionState; back: () => void } & PropsLocale<'publicHarnessAdmin'>) {
  const current = useSection(section)
  return <nav aria-label={t('menu')} data-team-admin-submenu style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
    <MenuRow wide={wide} testId="back" icon={<IconChevronLeftOutlineRegular size={wide ? 16 : 18} />} label={t('back')} onClick={back} />
    {wide && <div style={{ margin: '10px 10px 4px 14px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>{t('title')}</div>}
    {ADMIN_SECTIONS.map(name => <MenuRow key={name} wide={wide} testId={name} icon={ICONS[name](wide ? 16 : 18)} label={t(name)} active={current === name} onClick={() => section.set(name)} />)}
  </nav>
}

function Invites({ api, t }: { api: AdminApi; t: T }) {
  const [invites, setInvites] = useState<readonly AdminInvite[] | null>(), [note, setNote] = useState(''), [hours, setHours] = useState('168')
  const [created, setCreated] = useState<string>(), [status, setStatus] = useState<{ ok: boolean; text: string }>()
  const load = useCallback(() => { api.invites().then(setInvites, () => setInvites(null)) }, [api])
  useEffect(load, [load])
  const create = (event: FormEvent) => {
    event.preventDefault()
    api.createInvite(Number(hours) || 168, note.trim()).then(invite => { setCreated(invite.code); setNote(''); setStatus(undefined); load() }, error => setStatus({ ok: false, text: errorText(t, error) }))
  }
  const now = Date.now()
  const state = (invite: AdminInvite) => invite.revokedAt !== null ? 'revoked' : invite.usedAt !== null ? 'used' : invite.expiresAt <= now ? 'expired' : 'active'
  return <>
    <Card testId="invite-new"><form onSubmit={create} style={{ padding: '16px 0' }}>
      <div style={label}>{t('inviteNew')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto', gap: 12, alignItems: 'end', marginTop: 12 }}>
        <label style={field}>{t('inviteNote')}<Input name="note" maxLength={200} value={note} onChange={e => setNote(e.target.value)} /></label>
        <label style={field}>{t('inviteHours')}<Input name="hours" inputMode="numeric" value={hours} onChange={e => setHours(e.target.value.replace(/\D/g, ''))} /></label>
        <Button type="submit" variant="primary">{t('create')}</Button>
      </div>
      {created !== undefined && <div data-team-admin-invite-code style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-interactive-bg-hover)' }}>
        <div><div style={hint}>{t('inviteCode')}</div><code style={{ fontSize: 14 }}>{created}</code></div>
        <Button variant="outline" size="sm" onClick={() => { void writeClipboard(created); setStatus({ ok: true, text: t('copied') }) }}>{t('copy')}</Button>
      </div>}
      <Note note={status} />
    </form></Card>
    <Card testId="invite-list">
      {invites === undefined ? <Row title={t('loading')} end /> : invites === null ? <Row title={t('failed')} end /> : invites.length === 0 ? <Row title={t('noInvites')} end />
        : invites.map((invite, index) => {
          const st = state(invite)
          return <Row key={invite.id} end={index === invites.length - 1} title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{invite.note ?? invite.id}
            <Tag tone={st === 'active' ? 'success' : st === 'used' ? 'info' : 'neutral'}>{t(`st_${st}`)}</Tag></span>}
            detail={[fill(t('created'), { date: date(invite.createdAt) }), st === 'used' && invite.usedBy ? fill(t('usedBy'), { email: invite.usedBy }) : fill(t('expires'), { date: date(invite.expiresAt) })].join(' · ')}>
            {st === 'active' && <Button variant="outline" size="sm" onClick={() => { api.revokeInvite(invite.id).then(load, error => setStatus({ ok: false, text: errorText(t, error) })) }}>{t('revoke')}</Button>}
          </Row>
        })}
    </Card>
  </>
}

const PAGE = 20
function Users({ api, t }: { api: AdminApi; t: T }) {
  const [q, setQ] = useState(''), [role, setRole] = useState<'all' | 'admin' | 'member'>('all'), [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all'), [offset, setOffset] = useState(0)
  const [result, setResult] = useState<AdminUserPage | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>(), [disabling, setDisabling] = useState<AdminUser>(), [reason, setReason] = useState('')
  const load = useCallback(() => { api.users({ q, role: role === 'all' ? undefined : role, status: status === 'all' ? undefined : status, offset, limit: PAGE } as never).then(setResult, () => setResult(null)) }, [api, q, role, status, offset])
  useEffect(load, [load])
  const [groupNames, setGroupNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => { api.groups().then(list => setGroupNames(new Map(list.map(group => [group.id, groupName(group)]))), () => undefined) }, [api])
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  const act = (run: (proof: Proof) => Promise<void>) => { setNote(undefined); attempt(async proof => { await run(proof); setNote({ ok: true, text: t('done') }); load() }) }
  return <>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <Input style={{ minWidth: 260 }} icon={<IconSearchOutlineRegular size={16} />} placeholder={t('search')} aria-label={t('search')} value={q} onChange={e => { setQ(e.target.value); setOffset(0) }} />
      <SegmentedControl id="team-admin-role" label={t('role_admin')} value={role} onChange={v => { setRole(v); setOffset(0) }} options={[{ value: 'all', label: t('all') }, { value: 'admin', label: t('admins') }, { value: 'member', label: t('members') }]} />
      <SegmentedControl id="team-admin-status" label={t('active')} value={status} onChange={v => { setStatus(v); setOffset(0) }} options={[{ value: 'all', label: t('all') }, { value: 'active', label: t('active') }, { value: 'disabled', label: t('disabled') }]} />
    </div>
    <Note note={note} />
    <Card testId="users">
      {result === undefined ? <Row title={t('loading')} end /> : result === null ? <Row title={t('failed')} end /> : result.users.length === 0 ? <Row title={t('noUsers')} end />
        : result.users.map((user, index) => {
          const self = user.id === result.self
          return <div key={user.id} data-team-admin-user={user.email}><Row end={index === result.users.length - 1}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{user.name}<span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{user.email}</span>
              {self && <Tag tone="solid">{t('you')}</Tag>}</span>}
            detail={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Tag tone={user.role === 'admin' ? 'info' : 'outline'}>{t(`role_${user.role}`)}{user.roleSource ? ` · ${t(`src_${user.roleSource}`)}` : ''}</Tag>
              <Tag tone={user.status === 'active' ? 'success' : 'danger'}>{t(user.status === 'active' ? 'active' : 'st_disabled')}</Tag>
              <Tag tone="neutral">{PROVIDERS[user.provider] ?? user.provider}</Tag>
              <span>{user.lastLoginAt === null ? t('neverLogin') : fill(t('lastLogin'), { date: date(user.lastLoginAt) })}</span>
              {user.disabledReason !== null && <span>· {user.disabledReason}</span>}
              {(user.groups?.length ?? 0) > 0 && <span data-team-admin-user-groups>· {fill(t('userGroups'), { groups: user.groups!.map(id => groupNames.get(id) ?? id).join(', ') })}</span>}</span>}>
            {user.role === 'member' && user.status === 'active' && <Button variant="outline" size="sm" onClick={() => act(proof => api.setRole(user.id, 'admin', proof))}>{t('makeAdmin')}</Button>}
            {user.roleSource === 'grant' && <Button variant="outline" size="sm" onClick={() => act(proof => api.setRole(user.id, 'member', proof))}>{t('removeAdmin')}</Button>}
            {user.status === 'active'
              ? <Button variant="outline" size="sm" data-team-admin-disable={user.email} onClick={() => { setReason(''); setDisabling(user) }}>{t('disable')}</Button>
              : <Button variant="outline" size="sm" onClick={() => act(() => api.enable(user.id))}>{t('enable')}</Button>}
          </Row></div>
        })}
    </Card>
    {result != null && result.total > PAGE && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, ...hint }}>
      {fill(t('page'), { from: offset + 1, to: Math.min(offset + PAGE, result.total), total: result.total })}
      <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('prev')}</Button>
      <Button variant="outline" size="sm" disabled={offset + PAGE >= result.total} onClick={() => setOffset(offset + PAGE)}>{t('next')}</Button>
    </div>}
    {disabling !== undefined && <Modal open onClose={() => setDisabling(undefined)} title={fill(t('disableTitle'), { email: disabling.email })} closeLabel={t('cancel')} description={t('disableBody')}>
      <form data-team-admin-disable-form style={{ display: 'grid', gap: 12 }} onSubmit={event => { event.preventDefault(); const target = disabling; setDisabling(undefined); act(proof => api.disable(target.id, reason.trim() || 'admin', proof)) }}>
        <label style={field}>{t('reason')}<Input data-modal-autofocus maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={() => setDisabling(undefined)}>{t('cancel')}</Button><Button type="submit" variant="primary">{t('confirmDisable')}</Button></div>
      </form>
    </Modal>}
    {dialog}
  </>
}

const EVENTS = ['sso-sign-in', 'emergency-sign-in', 'emergency-enroll', 'emergency-revoke', 'sso-disable', 'sso-enable', 'sso-reconcile', 'password-change', 'session-revoke', 'sessions-revoke-others',
  'admin-invite-create', 'admin-invite-revoke', 'admin-user-disable', 'admin-user-enable', 'admin-role-change', 'admin-quota-change', 'admin-reauth']
function Audit({ api, t }: { api: AdminApi; t: T }) {
  const [event, setEvent] = useState(''), [outcome, setOutcome] = useState<'' | 'ok' | 'denied' | 'error'>(''), [q, setQ] = useState('')
  const [entries, setEntries] = useState<AdminAuditPage['entries'] | null>(), [next, setNext] = useState<number | null>(null)
  const load = useCallback((before?: number) => {
    api.audit({ event, outcome, q, ...before === undefined ? {} : { before }, limit: 25 }).then(page => {
      setEntries(prev => before === undefined || prev == null ? page.entries : [...prev, ...page.entries]); setNext(page.nextBefore)
    }, () => setEntries(null))
  }, [api, event, outcome, q])
  useEffect(() => { load() }, [load])
  const tone = (o: string) => o === 'ok' ? 'success' : o === 'denied' ? 'warning' : 'danger'
  return <>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <select aria-label={t('event')} style={select} value={event} onChange={e => setEvent(e.target.value)}>
        <option value="">{t('allEvents')}</option>{EVENTS.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <SegmentedControl id="team-admin-outcome" label={t('outcome')} value={outcome} onChange={setOutcome}
        options={[{ value: '', label: t('all') }, { value: 'ok', label: t('ok') }, { value: 'denied', label: t('denied') }, { value: 'error', label: t('error') }]} />
      <Input style={{ minWidth: 240 }} icon={<IconSearchOutlineRegular size={16} />} placeholder={t('filter')} aria-label={t('filter')} value={q} onChange={e => setQ(e.target.value)} />
      <Button variant="outline" data-team-admin-export onClick={() => {
        // A same-origin link with the session cookie; the server streams the file as an attachment, so the page stays put.
        const link = globalThis.document.createElement('a'); link.href = api.auditCsvUrl({ event, outcome, q }); link.download = ''; link.click()
      }}>{t('exportCsv')}</Button>
    </div>
    <div style={{ ...hint, marginTop: -8 }}>{t('exportHint')}</div>
    <Card testId="audit">
      {entries === undefined ? <Row title={t('loading')} end /> : entries === null ? <Row title={t('failed')} end /> : entries.length === 0 ? <Row title={t('noAudit')} end />
        : entries.map((entry, index) => <Row key={entry.id} end={index === entries.length - 1 && next === null}
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><code style={{ fontSize: 13 }}>{entry.event}</code><Tag tone={tone(entry.outcome)}>{t(entry.outcome as 'ok')}</Tag>
            {entry.email !== null && <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{entry.email}</span>}</span>}
          detail={[date(entry.at), entry.ip, entry.detail].filter(Boolean).join(' · ')} />)}
      {next !== null && <div style={{ padding: '12px 0' }}><Button variant="outline" size="sm" onClick={() => load(next)}>{t('more')}</Button></div>}
    </Card>
  </>
}

function Sso({ api, t }: { api: AdminApi; t: T }) {
  const [view, setView] = useState<AdminSso | null>()
  useEffect(() => { api.sso().then(setView, () => setView(null)) }, [api])
  if (view === undefined) return <Card><Row title={t('loading')} end /></Card>
  if (view === null) return <Card><Row title={t('failed')} end /></Card>
  const fields = Object.entries(view.provider).filter(([name, value]) => name !== 'kind' && value !== undefined)
  const show = (value: unknown) => Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  const last = view.reconcile.last
  return <>
    <Card testId="sso-provider">
      <Row title={t('provider')} detail={t('redactedNote')}><Tag tone={view.provider.kind === 'off' ? 'neutral' : 'info'}>{view.provider.kind === 'off' ? t('off') : PROVIDERS[view.provider.kind] ?? view.provider.kind}</Tag></Row>
      {fields.map(([name, value], index) => <Row key={name} end={index === fields.length - 1} title={<code style={{ fontSize: 13 }}>{name}</code>}>
        <span style={{ ...label, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: value === '[redacted]' ? 'var(--dsw-alias-label-secondary)' : undefined }}>{show(value)}</span></Row>)}
    </Card>
    <Card testId="sso-reconcile">
      <Row title={t('reconcile')}><Tag tone={view.reconcile.scheduled ? 'success' : 'neutral'}>{view.reconcile.scheduled ? fill(t('scheduled'), { minutes: Math.round(view.reconcile.intervalMs / 60000) }) : t('notScheduled')}</Tag></Row>
      <Row title={t('lastRun')} detail={last?.detail ?? undefined}>{last === null ? <span style={label}>{t('noRun')}</span>
        : <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><span style={label}>{date(last.at)}</span><Tag tone={last.outcome === 'ok' ? 'success' : 'danger'}>{t(last.outcome as 'ok')}</Tag></span>}</Row>
      <Row title={t('deprovision')} detail={fill(t('maxPerRun'), { n: view.deprovision.maxDisablePerRun })}>
        <span style={label}>{view.deprovision.maxInactiveDays > 0 ? fill(t('inactive'), { days: view.deprovision.maxInactiveDays }) : t('inactiveOff')}</span></Row>
      <Row title={t('disabledCount')} end><span style={label}>{view.disabledAccounts}</span></Row>
    </Card>
    <Card testId="sso-access">
      <Row title={t('emergency')}><span style={label}>{view.emergency.enabled ? fill(t('emergencyOn'), { ips: (view.emergency.allowedIps ?? []).join(', ') }) : t('emergencyOff')}</span></Row>
      <Row title={t('enrollment')}><span style={label}>{view.enrollmentOpen ? t('open') : t('closed')}</span></Row>
      <Row title={t('configAdmins')} end><span style={label}>{view.adminEmails.join(', ') || '—'}</span></Row>
    </Card>
  </>
}

function Quota({ api, t }: { api: AdminApi; t: T }) {
  const [quota, setQuota] = useState<AdminQuota | null>(), [users, setUsers] = useState<readonly AdminUser[]>([])
  const [defaultValue, setDefaultValue] = useState(''), [userId, setUserId] = useState(''), [userValue, setUserValue] = useState(''), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const apply = useCallback((next: AdminQuota | undefined) => { setQuota(next ?? null); if (next) setDefaultValue(String(next.defaultDailyTokens)) }, [])
  useEffect(() => { api.quota().then(apply, () => setQuota(null)); api.users({ limit: 100 }).then(page => setUsers(page.users), () => undefined) }, [api, apply])
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  const parse = (text: string) => /^[1-9][0-9]{0,14}$/.test(text) ? Number(text) : undefined
  const save = (run: (proof: Proof) => Promise<AdminQuota>) => { setNote(undefined); attempt(async proof => { apply(await run(proof)); setNote({ ok: true, text: t('done') }) }) }
  if (quota === undefined) return <Card><Row title={t('loading')} end /></Card>
  const kbLimits = <KbLimitsCard api={api} t={t} attempt={attempt} note={(ok, text) => setNote({ ok, text })} />
  if (quota === null) return <><Note note={note} /><Card><Row title={t('noQuota')} end /></Card>{kbLimits}{dialog}</>
  const email = (id: string) => users.find(user => user.id === id)?.email ?? id
  const tokens = (n: number) => fill(t('tokens'), { n: n.toLocaleString() })
  return <>
    <Note note={note} />
    <OverLimitCard quota={quota} t={t} onSave={(mode, grace) => {
      if (mode === 'grace' && !(/^[1-9][0-9]?$|^100$/.test(grace))) { setNote({ ok: false, text: t('invalidGrace') }); return }
      save(proof => api.setOverLimit(mode, mode === 'grace' ? Number(grace) : quota.overLimit?.gracePercent ?? 10, proof))
    }} />
    {kbLimits}
    <Card testId="quota-default">
      <Row title={t('configured')}><span style={label}>{tokens(quota.configuredDailyTokens)}</span></Row>
      <form style={{ padding: '14px 0' }} onSubmit={event => { event.preventDefault(); const n = parse(defaultValue); if (n === undefined) { setNote({ ok: false, text: t('invalidTokens') }); return } save(proof => api.setDefaultQuota(n, proof)) }}>
        <div style={label}>{t('defaultLimit')}</div><div style={hint}>{t('defaultHint')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <Input style={{ width: 200 }} inputMode="numeric" aria-label={t('defaultLimit')} value={defaultValue} onChange={e => setDefaultValue(e.target.value.replace(/\D/g, ''))} />
          <Button type="submit" variant="primary">{t('save')}</Button>
          {quota.defaultOverride !== undefined && <Button variant="outline" onClick={() => save(proof => api.setDefaultQuota(null, proof))}>{t('reset')}</Button>}
        </div>
      </form>
    </Card>
    <Card testId="quota-users">
      <form style={{ padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} onSubmit={event => {
        event.preventDefault(); const n = parse(userValue); if (!userId || n === undefined) { setNote({ ok: false, text: t('invalidTokens') }); return }
        save(proof => api.setUserQuota(userId, n, proof))
      }}>
        <div style={label}>{t('addOverride')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto', gap: 12, alignItems: 'end', marginTop: 10 }}>
          <label style={field}>{t('user')}<select style={select} value={userId} onChange={e => setUserId(e.target.value)}><option value="">—</option>{users.map(user => <option key={user.id} value={user.id}>{user.email}</option>)}</select></label>
          <label style={field}>{t('dailyTokens')}<Input inputMode="numeric" value={userValue} onChange={e => setUserValue(e.target.value.replace(/\D/g, ''))} /></label>
          <Button type="submit" variant="primary">{t('save')}</Button>
        </div>
      </form>
      <div style={{ ...label, padding: '14px 0 0' }}>{t('perUser')}</div>
      {quota.overrides.length === 0 ? <Row title={<span style={hint}>{t('noOverrides')}</span>} end />
        : quota.overrides.map((item, index) => <Row key={item.userId} end={index === quota.overrides.length - 1} title={email(item.userId)} detail={tokens(item.dailyTokens)}>
          <Button variant="outline" size="sm" onClick={() => save(proof => api.setUserQuota(item.userId, null, proof))}>{t('remove')}</Button></Row>)}
    </Card>
    {dialog}
  </>
}

function OverLimitCard({ quota, t, onSave }: { quota: AdminQuota; t: T; onSave: (mode: OverLimitMode, grace: string) => void }) {
  const current = quota.overLimit ?? { mode: 'block' as const, gracePercent: 10 }
  const [mode, setMode] = useState<OverLimitMode>(current.mode), [grace, setGrace] = useState(String(current.gracePercent))
  useEffect(() => { setMode(current.mode); setGrace(String(current.gracePercent)) }, [current.mode, current.gracePercent])
  return <Card testId="quota-over-limit">
    <form style={{ padding: '14px 0' }} onSubmit={event => { event.preventDefault(); onSave(mode, grace) }}>
      <div style={label}>{t('overLimit')}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <SegmentedControl id="team-admin-over-limit" label={t('overLimit')} value={mode} onChange={setMode}
          options={[{ value: 'block', label: t('mode_block') }, { value: 'grace', label: t('mode_grace') }, { value: 'warn', label: t('mode_warn') }]} />
        {mode === 'grace' && <label style={{ ...field, gridAutoFlow: 'column', alignItems: 'center', gap: 8 }}>{t('gracePercent')}
          <Input style={{ width: 80 }} inputMode="numeric" value={grace} onChange={e => setGrace(e.target.value.replace(/\D/g, ''))} /></label>}
        <Button type="submit" variant="primary">{t('save')}</Button>
      </div>
      <div style={hint}>{t(`modeHint_${mode}`)}</div>
    </form>
  </Card>
}

/** The administration main panel: the section chosen in the sidebar submenu.
 * @param props - client, shared section state and translator.
 * @returns the panel.
 */
export function AdminPage({ api, section, t }: { api: AdminApi; section: SectionState } & PropsLocale<'publicHarnessAdmin'>) {
  const current = useSection(section)
  return <div style={page} data-team-admin={current}>
    <div style={column}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' }}>{ICONS[current](20)}</span>
        <h1 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }}>{t(current)}</h1>
        <span style={{ ...hint, marginTop: 0 }}>· {t('title')}</span>
      </header>
      {current === 'groups' ? <Groups api={api} t={t} /> : current === 'kbRequests' ? <KbRequests api={api} t={t} /> : current === 'kb' ? <KbInventory api={api} t={t} /> : current === 'invites' ? <Invites api={api} t={t} /> : current === 'users' ? <Users api={api} t={t} /> : current === 'audit' ? <Audit api={api} t={t} />
        : current === 'sso' ? <Sso api={api} t={t} /> : <Quota api={api} t={t} />}
    </div>
  </div>
}
