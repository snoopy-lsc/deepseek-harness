/** System Admin, knowledge bases: the share-request queue with review (files, diff against the current publication, compile log), approve
 * with a scope and the raw option, and reject with a reason; plus the scope picker reused by the inventory. The server decides access
 * and asks for re-authentication where the design requires it. */
import { Button, Checkbox, DiffBlock, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AdminApi, AdminGroup, AdminKbFile, AdminKbRequest, AdminKbRequestContent, AdminUser, KbScopeEntry, Proof } from './admin-api.ts'
import { groupName } from './admin-groups.tsx'
import { Card, date, errorText, field, fill, hint, label, Note, Row, select, type T, useReauth } from './admin-kit.tsx'

/** Human size in MB or KB. */
export const kbSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Groups and users the scope picker offers, loaded once per dialog. */
export function useDirectory(api: AdminApi) {
  const [groups, setGroups] = useState<readonly AdminGroup[]>([]), [users, setUsers] = useState<readonly AdminUser[]>([])
  useEffect(() => {
    api.groups().then(setGroups, () => undefined)
    api.users({ limit: 100 }).then(page => setUsers(page.users), () => undefined)
  }, [api])
  return { groups, users }
}

/** Scope picker: the whole company, or a list of groups and users. */
export function ScopePicker({ t, value, onChange, groups, users }: { t: T; value: readonly KbScopeEntry[]; onChange: (next: KbScopeEntry[]) => void; groups: readonly AdminGroup[]; users: readonly AdminUser[] }) {
  const company = value.some(entry => entry.kind === 'company')
  const [pick, setPick] = useState('')
  const name = (entry: KbScopeEntry) => entry.kind === 'group' ? (groups.find(g => g.id === entry.target) ? groupName(groups.find(g => g.id === entry.target)!) : entry.target)
    : users.find(u => u.id === entry.target)?.email ?? entry.target
  const options = [...groups.map(g => ({ value: `group|${g.id}`, label: `${groupName(g)} (${g.source})` })), ...users.map(u => ({ value: `user|${u.id}`, label: u.email }))]
    .filter(option => !value.some(entry => `${entry.kind}|${entry.target}` === option.value))
  return <div data-team-admin-kb-scope style={{ display: 'grid', gap: 10 }}>
    <div style={label}>{t('kbScope')}</div>
    <SegmentedControl id="team-admin-kb-scope" label={t('kbScope')} value={company ? 'company' : 'list'} onChange={v => onChange(v === 'company' ? [{ kind: 'company', target: '*' }] : [])}
      options={[{ value: 'company', label: t('kbScopeCompany') }, { value: 'list', label: `${t('kbScopeGroups')} / ${t('kbScopeUsers')}` }]} />
    {!company && <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {value.length === 0 ? <span style={hint}>{t('kbScopeEmpty')}</span> : value.map(entry => <span key={`${entry.kind}:${entry.target}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Tag tone={entry.kind === 'group' ? 'info' : 'neutral'}>{name(entry)}</Tag>
          <Button variant="outline" size="sm" aria-label={`${t('remove')} ${name(entry)}`} onClick={() => onChange(value.filter(e => e !== entry))}>×</Button>
        </span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
        <label style={field}>{t('kbSearchPeople')}<select style={select} value={pick} onChange={e => setPick(e.target.value)}><option value="">—</option>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <Button variant="outline" disabled={!pick} onClick={() => { const [kind, target] = pick.split('|') as ['group' | 'user', string]; onChange([...value, { kind, target }]); setPick('') }}>{t('kbAdd')}</Button>
      </div>
    </>}
  </div>
}

function Review({ api, t, request, attempt, onClose, onDone }: { api: AdminApi; t: T; request: AdminKbRequest; attempt: (run: (proof: Proof) => Promise<void>) => void; onClose: () => void; onDone: (text: string) => void }) {
  const [content, setContent] = useState<AdminKbRequestContent | null>(), [file, setFile] = useState<AdminKbFile>(), [error, setError] = useState<string>()
  const [scope, setScope] = useState<KbScopeEntry[]>(request.current?.scope.slice() ?? []), [raw, setRaw] = useState(false), [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('')
  const { groups, users } = useDirectory(api)
  useEffect(() => { api.kbRequestContent(request.id).then(setContent, () => setContent(null)) }, [api, request.id])
  const open = (path: string) => { api.kbRequestFile(request.id, path).then(setFile, e => setError(errorText(t, e))) }
  const labels = useMemo(() => ({ codeLabel: t('diffCode'), wrapLabel: t('diffWrap'), unwrapLabel: t('diffUnwrap'), copy: t('diffCopy'), copied: t('diffCopied'), collapseAria: t('diffCollapse'),
    expandAria: (n: number) => fill(t('diffExpand'), { n }), collapse: t('diffCollapse'), expand: (n: number) => fill(t('diffExpand'), { n }) }), [t])
  const approve = () => attempt(async proof => { await api.approveKb(request.id, scope, raw, proof); onDone(t('kbApproved')) })
  const reject = (event: FormEvent) => { event.preventDefault(); if (reason.trim()) api.rejectKb(request.id, reason.trim()).then(() => onDone(t('kbRejected')), e => setError(errorText(t, e))) }
  return <Modal open onClose={onClose} title={fill(t('kbReviewTitle'), { title: request.kb.title })} closeLabel={t('cancel')} description={fill(t('kbReviewHint'), { commit: request.commitSha.slice(0, 12) })}>
    <div data-team-admin-kb-review style={{ display: 'grid', gap: 14, minWidth: 'min(720px, 86vw)' }}>
      <div style={{ ...hint, marginTop: 0 }}>{[request.kb.ownerEmail ? fill(t('kbFrom'), { email: request.kb.ownerEmail }) : t('kbKind_org'), fill(t('kbSubmitted'), { date: date(request.submittedAt) }),
        request.note ? fill(t('kbNote'), { note: request.note }) : undefined].filter(Boolean).join(' · ')}</div>
      <div>
        <div style={{ ...label, fontWeight: 600 }}>{t('kbFilesTitle')}</div>
        <div style={hint}>{t('kbOpenFile')}</div>
        {content === undefined ? <div style={hint}>{t('loading')}</div> : content === null ? <div style={hint}>{t('failed')}</div>
          : <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 6 }} data-team-admin-kb-files>
            {content.files.map(f => <button key={f.path} type="button" onClick={() => open(f.path)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '5px 0',
              border: 'none', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', background: file?.path === f.path ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}>
              <code>{f.path}</code><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><span style={{ ...hint, marginTop: 0 }}>{kbSize(f.bytes)}</span>
                <Tag tone={f.status === 'added' ? 'success' : f.status === 'changed' ? 'warning' : 'quiet'}>{t(`kbStatus_${f.status}`)}</Tag></span>
            </button>)}
            {content.removed.length > 0 && <div style={hint}>{fill(t('kbRemoved'), { paths: content.removed.join(', ') })}</div>}
          </div>}
      </div>
      {file !== undefined && (file.text === null ? <div style={hint}>{t('kbBinary')}</div>
        : <DiffBlock diffs={[{ path: file.path, oldText: file.previous, newText: file.text }]} labels={labels} maxLines={40} />)}
      {content?.jobs !== undefined && content.jobs.length > 0 && <div style={hint}>{fill(t('kbRecentJobs'), { jobs: content.jobs.map(j => `${j.op} ${j.state}`).join(', ') })}</div>}
      <ScopePicker t={t} value={scope} onChange={setScope} groups={groups} users={users} />
      <Checkbox checked={raw} onChange={setRaw} label={t('kbIncludeRaw')} />
      {error !== undefined && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-state-error, #d92d20)' }}>{error}</p>}
      {rejecting ? <form onSubmit={reject} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8, alignItems: 'end' }}>
        <label style={field}>{t('kbRejectReason')}<Input data-modal-autofocus maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button variant="outline" onClick={() => setRejecting(false)}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={!reason.trim()}>{t('kbReject')}</Button>
      </form> : <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="outline" onClick={() => setRejecting(true)} data-team-admin-kb-reject>{t('kbReject')}</Button>
        <Button variant="primary" disabled={scope.length === 0} onClick={approve} data-team-admin-kb-approve>{t('kbApprove')}</Button>
      </div>}
    </div>
  </Modal>
}

/** The share-request queue. */
export function KbRequests({ api, t }: { api: AdminApi; t: T }) {
  const [state, setState] = useState<'pending' | 'all'>('pending'), [requests, setRequests] = useState<readonly AdminKbRequest[] | null>()
  const [note, setNote] = useState<{ ok: boolean; text: string }>(), [review, setReview] = useState<AdminKbRequest>()
  const load = useCallback(() => { api.kbRequests(state).then(setRequests, () => setRequests(null)) }, [api, state])
  useEffect(load, [load])
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <SegmentedControl id="team-admin-kb-requests" label={t('kbRequests')} value={state} onChange={setState} options={[{ value: 'pending', label: t('kbPending') }, { value: 'all', label: t('kbAllRequests') }]} />
    </div>
    <Note note={note} />
    <Card testId="kb-requests">
      {requests === undefined ? <Row title={t('loading')} end /> : requests === null ? <Row title={t('failed')} end />
        : requests.length === 0 ? <Row title={<span style={hint}>{state === 'pending' ? t('kbNoRequests') : t('kbNoHistory')}</span>} end />
          : requests.map((request, index) => <Row key={request.id} end={index === requests.length - 1}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{request.kb.title}<Tag tone="quiet">{t(`kbKind_${request.kb.kind}`)}</Tag>
              {state === 'all' && <Tag tone={request.state === 'approved' ? 'success' : request.state === 'pending' ? 'info' : request.state === 'rejected' ? 'danger' : 'neutral'}>{t(`kbReqState_${request.state}`)}</Tag>}</span>}
            detail={[request.kb.ownerEmail ? fill(t('kbFrom'), { email: request.kb.ownerEmail }) : undefined, fill(t('kbSubmitted'), { date: date(request.submittedAt) }),
              request.files !== undefined && request.state === 'pending' ? fill(t('kbFiles'), { n: request.files, size: kbSize(request.bytes ?? 0) }) : undefined,
              request.current !== null ? fill(t('kbCurrent'), { date: date(request.current.publishedAt) }) : undefined,
              request.note ? fill(t('kbNote'), { note: request.note }) : request.reason ? request.reason : undefined].filter(Boolean).join(' · ')}>
            {request.state === 'pending' && <Button variant="primary" size="sm" onClick={() => setReview(request)} data-team-admin-kb-review-open>{t('kbReview')}</Button>}
          </Row>)}
    </Card>
    {review !== undefined && <Review api={api} t={t} request={review} attempt={attempt} onClose={() => setReview(undefined)} onDone={text => { setReview(undefined); setNote({ ok: true, text }); load() }} />}
    {dialog}
  </>
}
