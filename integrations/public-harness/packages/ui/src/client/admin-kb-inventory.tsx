/** System Admin, knowledge base inventory: every KB with owner, size, share state, scope and an over-limit badge with a filter; manage
 * a publication (change scope, revoke, convert to a company KB); preview one user's effective set; create company KBs and maintain
 * them in an editor (upload, compile, page edit, history, publish or roll back). The server decides access; the sensitive actions
 * ask for re-authentication through the shared dialog. */
import { Button, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { AdminApi, AdminKb, AdminKbContent, AdminKbPreview, KbScopeEntry, Proof } from './admin-api.ts'
import { kbSize, ScopePicker, useDirectory } from './admin-kb.tsx'
import { Card, date, errorText, field, fill, hint, label, Note, Row, select, type T, useReauth } from './admin-kit.tsx'

type Filter = 'all' | 'over' | 'published' | 'pending'
type Attempt = (run: (proof: Proof) => Promise<void>) => void
const textarea: CSSProperties = { boxSizing: 'border-box', width: '100%', minHeight: 220, resize: 'vertical', padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)',
  border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 13, lineHeight: '20px' }

/** "Visible to …" for a scope list. */
export function scopeSummary(t: T, scope: readonly KbScopeEntry[]) {
  if (scope.some(entry => entry.kind === 'company')) return fill(t('kbScopeSummary'), { scope: t('kbScopeCompanyShort') })
  return fill(t('kbScopeSummary'), { scope: fill(t('kbScopeCount'), { groups: scope.filter(e => e.kind === 'group').length, users: scope.filter(e => e.kind === 'user').length }) })
}
const shareTone = (state: AdminKb['share']['state']) => state === 'published' ? 'success' : state === 'pending' ? 'info' : state === 'revoked' ? 'neutral' : 'quiet'

function Manage({ api, t, kb, attempt, onClose, onDone }: { api: AdminApi; t: T; kb: AdminKb; attempt: Attempt; onClose: () => void; onDone: (text: string) => void }) {
  const [scope, setScope] = useState<KbScopeEntry[]>(kb.share.scope.slice()), [confirm, setConfirm] = useState<'revoke' | 'convert'>()
  const { groups, users } = useDirectory(api)
  return <Modal open onClose={onClose} title={kb.title} closeLabel={t('cancel')} description={scopeSummary(t, kb.share.scope)}>
    <div data-team-admin-kb-manage data-team-wide="m" style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <ScopePicker t={t} value={scope} onChange={setScope} groups={groups} users={users} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={scope.length === 0} onClick={() => attempt(async proof => { await api.setKbScope(kb.id, scope, proof); onDone(t('kbDone')) })}>{t('kbSaveScope')}</Button>
      </div>
      {confirm !== undefined ? <div style={{ display: 'grid', gap: 10, paddingTop: 12, borderTop: '0.5px solid var(--dsw-alias-border-l2)' }}>
        <div style={label}>{fill(t(confirm === 'revoke' ? 'kbRevokeConfirm' : 'kbConvertConfirm'), { title: kb.title })}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={() => setConfirm(undefined)}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => attempt(async proof => {
            if (confirm === 'revoke') await api.revokeKb(kb.id, proof); else await api.convertKb(kb.id, proof)
            onDone(t('kbDone'))
          })}>{t(confirm === 'revoke' ? 'kbRevoke' : 'kbConvert')}</Button>
        </div>
      </div> : <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '0.5px solid var(--dsw-alias-border-l2)' }}>
        <Button variant="outline" onClick={() => setConfirm('revoke')}>{t('kbRevoke')}</Button>
        {kb.kind === 'personal' && <Button variant="outline" onClick={() => setConfirm('convert')}>{t('kbConvert')}</Button>}
      </div>}
    </div>
  </Modal>
}

function OrgEditor({ api, t, kb, attempt, onClose, onChanged }: { api: AdminApi; t: T; kb: AdminKb; attempt: Attempt; onClose: () => void; onChanged: () => void }) {
  const [content, setContent] = useState<AdminKbContent | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const [path, setPath] = useState(''), [text, setText] = useState(''), [message, setMessage] = useState(''), [scope, setScope] = useState<KbScopeEntry[]>(kb.share.scope.slice())
  const file = useRef<HTMLInputElement>(null)
  const { groups, users } = useDirectory(api)
  const load = useCallback(() => { api.kbContent(kb.id).then(setContent, () => setContent(null)) }, [api, kb.id])
  useEffect(load, [load])
  const fail = (error: unknown) => setNote({ ok: false, text: errorText(t, error) })
  const run = (work: () => Promise<void>, done: string) => { setNote(undefined); work().then(() => { setNote({ ok: true, text: done }); load(); onChanged() }, fail) }
  const open = (p: string) => { setPath(p); api.kbContent(kb.id, p).then(reply => setText(reply.text ?? ''), fail) }
  const save = (event: FormEvent) => { event.preventDefault(); run(() => api.editOrgPage(kb.id, path, text, message), t('kbOrgSaved')) }
  const publish = (commit?: string) => attempt(async proof => { await api.publishOrgKb(kb.id, commit, scope, proof); setNote({ ok: true, text: t('kbPublishedNote') }); load(); onChanged() })
  const pages = content?.files?.filter(f => /^(wiki\/.+\.md|index\.md|schema\.md)$/.test(f.path)) ?? []
  const sources = content?.files?.filter(f => f.path.startsWith('raw/')) ?? []
  return <Modal open onClose={onClose} title={fill(t('kbEditorTitle'), { title: kb.title })} closeLabel={t('cancel')} description={fill(t('kbOrgHint'), { principal: kb.chargedTo ?? '' })}>
    <div data-team-admin-kb-editor data-team-wide="l" style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <Note note={note} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input ref={file} type="file" hidden accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm" onChange={e => {
          const picked = e.target.files?.[0]; e.target.value = ''
          if (picked !== undefined) run(() => api.uploadOrgSource(kb.id, { name: picked.name, data: picked }), t('kbOrgSaved'))
        }} />
        <Button variant="outline" onClick={() => file.current?.click()}>{t('kbUpload')}</Button>
        {(['ingest', 'lint', 'rebuild'] as const).map(op => <Button key={op} variant="outline" onClick={() => run(() => api.compileOrgKb(kb.id, op), t('kbCompileQueued'))}>{t(`kbCompile_${op}`)}</Button>)}
        <span style={{ ...hint, marginTop: 0 }}>{fill(t('kbSize'), { size: kbSize(kb.bytes), pages: kb.pages, sources: kb.sources })}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 2fr)', gap: 14 }}>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <div style={{ ...label, fontWeight: 600 }}>{t('kbPages')}</div>
          {content === undefined ? <div style={hint}>{t('loading')}</div> : [...pages, ...sources].map(f => <button key={f.path} type="button" disabled={f.path.startsWith('raw/')} onClick={() => open(f.path)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 0', border: 'none', background: f.path === path ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: f.path.startsWith('raw/') ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: f.path.startsWith('raw/') ? 'default' : 'pointer' }}><code>{f.path}</code></button>)}
        </div>
        <form onSubmit={save} style={{ display: 'grid', gap: 8 }}>
          <label style={field}>{t('kbNewPage')}<Input value={path} placeholder="wiki/page.md" onChange={e => setPath(e.target.value)} /></label>
          <label style={field}>{t('kbPageText')}<textarea style={textarea} value={text} onChange={e => setText(e.target.value)} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
            <label style={field}>{t('kbCommitMessage')}<Input value={message} maxLength={200} onChange={e => setMessage(e.target.value)} /></label>
            <Button type="submit" variant="primary" disabled={!/^(wiki\/[^/]+\.md|index\.md|schema\.md)$/.test(path)}>{t('kbSavePage')}</Button>
          </div>
        </form>
      </div>
      <ScopePicker t={t} value={scope} onChange={setScope} groups={groups} users={users} />
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ ...label, fontWeight: 600 }}>{t('kbHistory')}</div>
          <Button variant="primary" size="sm" disabled={scope.length === 0} onClick={() => publish()}>{t('kbPublishHead')}</Button>
        </div>
        {kb.share.state !== 'published' && <div style={hint}>{t('kbNotPublished')}</div>}
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {content?.history?.map(c => <div key={c.sha} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', fontSize: 13 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><code>{c.sha.slice(0, 10)}</code> {c.subject} <span style={{ ...hint, display: 'inline' }}>{date(c.at)}</span></span>
            {c.published ? <Tag tone="success">{t('kbPublished')}</Tag> : <Button variant="outline" size="sm" disabled={scope.length === 0} onClick={() => publish(c.sha)}>{t('kbRollback')}</Button>}
          </div>)}
        </div>
      </div>
    </div>
  </Modal>
}

function Preview({ api, t }: { api: AdminApi; t: T }) {
  const { users } = useDirectory(api)
  const [user, setUser] = useState(''), [preview, setPreview] = useState<AdminKbPreview | null>()
  useEffect(() => { if (user) api.kbPreview(user).then(setPreview, () => setPreview(null)); else setPreview(undefined) }, [api, user])
  return <Card testId="kb-preview">
    <div style={{ padding: '14px 0', display: 'grid', gap: 8 }}>
      <div style={label}>{t('kbPreview')}</div>
      <label style={{ ...field, maxWidth: 360 }}>{t('kbPreviewUser')}<select style={select} value={user} onChange={e => setUser(e.target.value)}><option value="">—</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
      {preview === null ? <div style={hint}>{t('failed')}</div> : preview !== undefined && (preview.user.disabled ? <div style={hint}>{t('kbPreviewDisabled')}</div>
        : preview.kbs.length === 0 ? <div style={hint}>{t('kbPreviewNone')}</div>
          : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{preview.kbs.map(k => <Tag key={k.id} tone="outline">{k.path}</Tag>)}</div>)}
    </div>
  </Card>
}

/** The inventory section. */
export function KbInventory({ api, t }: { api: AdminApi; t: T }) {
  const [filter, setFilter] = useState<Filter>('all'), [data, setData] = useState<{ kbs: readonly AdminKb[]; totals: { all: number; over: number } } | null>()
  const [note, setNote] = useState<{ ok: boolean; text: string }>(), [manage, setManage] = useState<AdminKb>(), [editor, setEditor] = useState<AdminKb>()
  const [titleText, setTitleText] = useState(''), [description, setDescription] = useState('')
  const load = useCallback(() => { api.kbInventory(filter).then(setData, () => setData(null)) }, [api, filter])
  useEffect(load, [load])
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!titleText.trim()) return
    attempt(async proof => { const kb = await api.createOrgKb(titleText.trim(), description.trim(), proof); setTitleText(''); setDescription(''); load(); setEditor(kb) })
  }
  const totals = data?.totals ?? { all: 0, over: 0 }
  return <>
    <SegmentedControl id="team-admin-kb-filter" label={t('kb')} value={filter} onChange={setFilter} options={[{ value: 'all', label: fill(t('kbFilterAll'), { n: totals.all }) },
      { value: 'over', label: fill(t('kbFilterOver'), { n: totals.over }) }, { value: 'published', label: t('kbFilterPublished') }, { value: 'pending', label: t('kbFilterPending') }]} />
    <Note note={note} />
    <Card testId="kb-inventory">
      {data === undefined ? <Row title={t('loading')} end /> : data === null ? <Row title={t('failed')} end />
        : data.kbs.length === 0 ? <Row title={<span style={hint}>{t('kbEmpty')}</span>} end />
          : data.kbs.map((kb, index) => <Row key={kb.id} end={index === data.kbs.length - 1}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{kb.title}
              <Tag tone="quiet">{t(`kbKind_${kb.kind}`)}</Tag><Tag tone={shareTone(kb.share.state)}>{t(`kbShare_${kb.share.state}`)}</Tag>
              {kb.over.length > 0 && <Tag tone="danger">{t('kbOverBadge')}</Tag>}
              {kb.archivedAt !== null && <Tag tone="neutral">{t('kbArchived')}</Tag>}</span>}
            detail={[kb.kind === 'org' ? t('kbOrgOwner') : fill(t('kbOwner'), { email: kb.ownerEmail ?? kb.ownerUserId ?? '' }),
              fill(t('kbSize'), { size: kbSize(kb.bytes), pages: kb.pages, sources: kb.sources }),
              kb.share.state === 'published' ? scopeSummary(t, kb.share.scope) : undefined, kb.convertedTo !== null ? t('kbConvertedTo') : undefined,
              ...kb.over.map(o => fill(t('kbOverDetail'), { limit: t(`kbLimit_${o.limit}`), value: o.limit === 'max_bytes' ? kbSize(o.value) : o.value, allowed: o.limit === 'max_bytes' ? kbSize(o.allowed) : o.allowed }))].filter(Boolean).join(' · ')}>
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {kb.share.state === 'published' && <Button variant="outline" size="sm" onClick={() => setManage(kb)} data-team-admin-kb-manage-open>{t('kbActions')}</Button>}
              {kb.kind === 'org' && <Button variant="outline" size="sm" onClick={() => setEditor(kb)} data-team-admin-kb-open>{t('kbEditor')}</Button>}
            </span>
          </Row>)}
    </Card>
    <Card testId="kb-org-new">
      <form onSubmit={create} style={{ padding: '14px 0' }}>
        <div style={label}>{t('kbNewOrg')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto', gap: 12, alignItems: 'end', marginTop: 10 }}>
          <label style={field}>{t('kbOrgTitle')}<Input maxLength={120} value={titleText} onChange={e => setTitleText(e.target.value)} /></label>
          <label style={field}>{t('kbOrgDescription')}<Input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
          <Button type="submit" variant="primary" disabled={!titleText.trim()}>{t('kbOrgCreate')}</Button>
        </div>
      </form>
    </Card>
    <Preview api={api} t={t} />
    {manage !== undefined && <Manage api={api} t={t} kb={manage} attempt={attempt} onClose={() => setManage(undefined)} onDone={text => { setManage(undefined); setNote({ ok: true, text }); load() }} />}
    {editor !== undefined && <OrgEditor api={api} t={t} kb={editor} attempt={attempt} onClose={() => setEditor(undefined)} onChanged={load} />}
    {dialog}
  </>
}
