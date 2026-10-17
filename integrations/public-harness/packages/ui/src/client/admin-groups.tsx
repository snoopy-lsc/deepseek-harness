/** System Admin, Groups: synced departments and groups (alias, member count, last refresh) and administrator-managed local groups
 * with their members. Membership changes and deletions may ask for re-authentication; the server decides. */
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdminApi, AdminGroup, AdminGroupMember, AdminUser, Proof } from './admin-api.ts'
import { Card, date, errorText, field, fill, hint, label, Note, Row, select, type T, useReauth } from './admin-kit.tsx'

const SOURCE: Record<AdminGroup['source'], string> = { oidc: 'OIDC', saml: 'SAML', ldap: 'LDAP', wecom: 'WeCom', dingtalk: 'DingTalk', local: 'Local' }
/** Display name of a group: alias or local name, else the directory value. */
export const groupName = (group: Pick<AdminGroup, 'displayName' | 'externalId'>) => group.displayName ?? group.externalId

export function Groups({ api, t }: { api: AdminApi; t: T }) {
  const [groups, setGroups] = useState<readonly AdminGroup[] | null>(), [name, setName] = useState(''), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const [naming, setNaming] = useState<AdminGroup>(), [members, setMembers] = useState<AdminGroup>()
  const load = useCallback(() => { api.groups().then(setGroups, () => setGroups(null)) }, [api])
  useEffect(load, [load])
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    api.createGroup(name.trim()).then(() => { setName(''); setNote({ ok: true, text: t('done') }); load() }, fail)
  }
  const local = groups?.filter(group => group.source === 'local') ?? [], synced = groups?.filter(group => group.source !== 'local') ?? []
  const list = (items: readonly AdminGroup[], empty: string, testId: string) => <Card testId={testId}>
    {groups === undefined ? <Row title={t('loading')} end /> : groups === null ? <Row title={t('failed')} end /> : items.length === 0 ? <Row title={<span style={hint}>{empty}</span>} end />
      : items.map((group, index) => <Row key={group.id} end={index === items.length - 1}
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{groupName(group)}<Tag tone={group.source === 'local' ? 'info' : 'neutral'}>{SOURCE[group.source]}</Tag></span>}
        detail={[group.source === 'local' ? undefined : group.externalId, fill(t('groupMembers'), { n: group.members }), fill(t('groupRefreshed'), { date: date(group.updatedAt) })].filter(Boolean).join(' · ')}>
        <Button variant="outline" size="sm" onClick={() => setMembers(group)}>{t('groupMembersOpen')}</Button>
        <Button variant="outline" size="sm" onClick={() => setNaming(group)}>{group.source === 'local' ? t('groupRename') : t('groupAlias')}</Button>
        {group.source === 'local' && <Button variant="outline" size="sm" onClick={() => attempt(async proof => { await api.deleteGroup(group.id, proof); setNote({ ok: true, text: t('done') }); load() })}>{t('remove')}</Button>}
      </Row>)}
  </Card>
  return <>
    <Card testId="groups-new"><form onSubmit={create} style={{ padding: '16px 0' }}>
      <div style={label}>{t('groupNew')}</div><div style={hint}>{t('groupNewHint')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'end', marginTop: 12 }}>
        <label style={field}>{t('groupName')}<Input name="group" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
        <Button type="submit" variant="primary">{t('groupCreate')}</Button>
      </div>
    </form></Card>
    <Note note={note} />
    <div style={{ ...label, fontWeight: 600 }}>{t('groupLocal')}</div>
    {list(local, t('groupNoLocal'), 'groups-local')}
    <div style={{ ...label, fontWeight: 600 }}>{t('groupSynced')}</div>
    <div style={{ ...hint, marginTop: -12 }}>{t('groupSyncedHint')}</div>
    {list(synced, t('groupNoSynced'), 'groups-synced')}
    {naming !== undefined && <NameDialog t={t} group={naming} onClose={() => setNaming(undefined)}
      onSave={value => api.nameGroup(naming.id, naming.source === 'local' ? 'rename' : 'alias', value).then(() => { setNaming(undefined); setNote({ ok: true, text: t('done') }); load() }, fail)} />}
    {members !== undefined && <MembersDialog api={api} t={t} group={members} attempt={attempt} onClose={() => { setMembers(undefined); load() }} />}
    {dialog}
  </>
}

function NameDialog({ t, group, onClose, onSave }: { t: T; group: AdminGroup; onClose: () => void; onSave: (value: string | null) => void }) {
  const [value, setValue] = useState(group.displayName ?? '')
  const local = group.source === 'local'
  return <Modal open onClose={onClose} title={local ? t('groupRename') : t('groupAlias')} closeLabel={t('cancel')} description={local ? undefined : t('groupAliasHint')}>
    <form style={{ display: 'grid', gap: 12 }} onSubmit={event => { event.preventDefault(); onSave(value.trim() === '' ? (local ? group.displayName : null) : value.trim()) }}>
      <label style={field}>{t('groupName')}<Input data-modal-autofocus maxLength={120} value={value} onChange={e => setValue(e.target.value)} /></label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={onClose}>{t('cancel')}</Button><Button type="submit" variant="primary">{t('save')}</Button></div>
    </form>
  </Modal>
}

function MembersDialog({ api, t, group, attempt, onClose }: { api: AdminApi; t: T; group: AdminGroup; attempt: (run: (proof: Proof) => Promise<void>) => void; onClose: () => void }) {
  const [members, setMembers] = useState<readonly AdminGroupMember[] | null>(), [users, setUsers] = useState<readonly AdminUser[]>([]), [userId, setUserId] = useState('')
  const load = useCallback(() => { api.groupMembers(group.id).then(setMembers, () => setMembers(null)) }, [api, group.id])
  useEffect(() => { load(); if (group.source === 'local') api.users({ limit: 100 }).then(page => setUsers(page.users), () => undefined) }, [api, group.id, group.source, load])
  const change = (id: string, op: 'add' | 'remove') => attempt(async proof => { await api.setGroupMember(group.id, id, op, proof); setUserId(''); load() })
  return <Modal open onClose={onClose} title={groupName(group)} closeLabel={t('cancel')} description={group.source === 'local' ? t('groupLocalMembersHint') : t('groupSyncedMembersHint')}>
    <div style={{ display: 'grid', gap: 8, maxHeight: 360, overflow: 'auto' }} data-team-admin-group-members>
      {members === undefined ? <div style={hint}>{t('loading')}</div> : members === null ? <div style={hint}>{t('failed')}</div> : members.length === 0 ? <div style={hint}>{t('groupNoMembers')}</div>
        : members.map(member => <div key={member.userId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={label}>{member.email ?? member.userId}</span>
          {group.source === 'local' && <Button variant="outline" size="sm" onClick={() => change(member.userId, 'remove')}>{t('remove')}</Button>}
        </div>)}
    </div>
    {group.source === 'local' && <form style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end', marginTop: 12 }}
      onSubmit={event => { event.preventDefault(); if (userId) change(userId, 'add') }}>
      <label style={field}>{t('user')}<select style={select} value={userId} onChange={e => setUserId(e.target.value)}><option value="">—</option>
        {users.filter(user => !members?.some(member => member.userId === user.id)).map(user => <option key={user.id} value={user.id}>{user.email}</option>)}</select></label>
      <Button type="submit" variant="primary">{t('groupAdd')}</Button>
    </form>}
  </Modal>
}
