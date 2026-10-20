/** Knowledge library dialogs for creation, compilation progress, archiving and sharing requests. */
import { Button, IconArchiveOutlineRegular,
  Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { KbApi, KbItem, KbJob, KbLimitName } from './kb-api.ts'
import { AccountApiError } from './me.ts'
import { kbCopy } from './kb-copy.ts'

type KbKey = keyof typeof kbCopy.en
type T = (key: KbKey) => string

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
const date = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const errorText = (t: T, error: unknown) => {
  if (error instanceof AccountApiError) {
    const key = `kb_err_${error.code.replace(/-/g, '_')}` as KbKey
    if (key in kbCopy.en) return t(key)
  }
  return t('kb_failed')
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }
const label: CSSProperties = { fontSize: 14, lineHeight: '20px' }
const hint: CSSProperties = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }
const field: CSSProperties = { display: 'grid', gap: 6, minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
const notice: CSSProperties = { margin: '12px 0 0', padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: '20px', background: 'var(--dsw-alias-interactive-bg-hover)' }
const status = (ok: boolean): CSSProperties => ({ margin: 0, padding: '12px 0 0', fontSize: 12, lineHeight: '18px', color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' })
const list: CSSProperties = { margin: '6px 0 0', padding: '0 0 0 18px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }

function Line({ title, detail, children, end }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; end?: boolean }) {
  return <div style={end ? { ...row, borderBottom: 'none' } : row}>
    <div style={{ minWidth: 0 }}><div style={label}>{title}</div>{detail !== undefined && <div style={hint}>{detail}</div>}</div>
    {children !== undefined && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>{children}</div>}
  </div>
}
const jobTone = (state: KbJob['state']) => state === 'succeeded' ? 'success' : state === 'failed' ? 'danger' : state === 'conflict' || state === 'over-limit' ? 'warning' : 'info'
const jobState = (t: T, state: KbJob['state']) => t(`kb_job_${state.replace('-', '_')}` as KbKey)
const limitName = (t: T, name: KbLimitName) => t(`kb_limit_${name}` as KbKey)

function usePendingAction(fail: (error: unknown) => void) {
  const [busy, setBusy] = useState(false), pending = useRef(false), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const run = (work: () => Promise<unknown>, done: () => void) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    void work().then(() => { if (live.current) done() }, error => { if (live.current) fail(error) }).finally(() => {
      pending.current = false
      if (live.current) setBusy(false)
    })
  }
  return { busy, run }
}

function JobDetail({ job, t }: { job: KbJob; t: T }) {
  const report = job.report
  return <div data-team-kb-job-detail style={{ padding: '0 0 14px' }}>
    <div style={hint}>{fill(t('kb_tokens'), { input: job.inputTokens.toLocaleString(), output: job.outputTokens.toLocaleString(), who: job.chargedTo })}</div>
    {job.error !== null && <p role="alert" style={status(false)}>{job.error === 'allowance' || job.error === 'model' || job.error === 'interrupted' ? t(`kb_error_${job.error}` as KbKey) : fill(t('kb_error_other'), { code: job.error })}</p>}
    {report?.limit !== undefined && report.branch !== undefined && <p style={{ ...notice, marginTop: 8 }}>{fill(t('kb_overBranch'), { limit: limitName(t, report.limit.name), value: report.limit.value, allowed: report.limit.allowed, branch: report.branch })}</p>}
    {report?.limit === undefined && report?.branch !== undefined && <p style={{ ...notice, marginTop: 8 }}>{fill(t('kb_branch'), { branch: report.branch })}</p>}
    {report !== null && <>
      {report.changed.length > 0 && <><div style={{ ...label, fontSize: 13, marginTop: 10 }}>{t('kb_changed')}</div><ul style={list}>{report.changed.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
      <div style={{ ...label, fontSize: 13, marginTop: 10 }}>{t('kb_lint')}</div>
      {report.lint.length === 0 ? <div style={hint}>{t('kb_noFindings')}</div> : <ul style={list}>{report.lint.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      {report.log.length > 0 && <><div style={{ ...label, fontSize: 13, marginTop: 10 }}>{t('kb_log')}</div><ul style={list}>{report.log.map((line, i) => <li key={i}>{line}</li>)}</ul></>}
    </>}
  </div>
}

/** The job drawer for one KB: start ingest, lint or rebuild, and follow the jobs. */
export function JobDrawer({ api, kb, t, onClose, onChanged }: { api: KbApi; kb: KbItem; t: T; onClose: () => void; onChanged: () => void }) {
  const [jobs, setJobs] = useState<readonly KbJob[]>(), [note, setNote] = useState<{ ok: boolean; text: string }>(), [open, setOpen] = useState<string>()
  const request = usePendingAction(error => setNote({ ok: false, text: errorText(t, error) }))
  const load = useCallback(() => api.jobs(kb.id).then(setJobs, () => setJobs([])), [api, kb.id])
  useEffect(() => { void load() }, [load])
  const active = jobs?.some(job => job.state === 'queued' || job.state === 'running') ?? false
  const wasActive = useRef(false)
  useEffect(() => {
    if (wasActive.current && !active) onChanged()
    wasActive.current = active
    if (!active) return
    const timer = setInterval(() => { void load() }, 2000)
    return () => clearInterval(timer)
  }, [active, load, onChanged])
  const run = (op: KbJob['op']) => { setNote(undefined); request.run(() => api.compile(kb.id, op).then(load), () => {}) }
  const archive = () => request.run(() => api.archive(kb.id), () => { onChanged(); onClose() })
  const shown = open ?? jobs?.[0]?.id
  return <Modal open onClose={onClose} title={fill(t('kb_drawer'), { title: kb.title })} closeLabel={t('kb_close')}>
    <div data-team-kb-drawer data-team-wide="m" style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      {(['ingest', 'lint', 'rebuild'] as const).map(op => <Line key={op} title={t(`kb_op_${op}`)} detail={t(`kb_opHint_${op}`)}>
        <Button variant={op === 'ingest' ? 'primary' : 'outline'} size="sm" disabled={active || request.busy || kb.archivedAt !== null} onClick={() => run(op)} data-team-kb-op={op}>{t(`kb_op_${op}`)}</Button>
      </Line>)}
      {note !== undefined && <p role="alert" style={status(note.ok)}>{note.text}</p>}
      <div style={{ ...label, fontWeight: 600, marginTop: 12 }}>{t('kb_jobs')}</div>
      {jobs === undefined ? <div style={hint}>{t('kb_loading')}</div> : jobs.length === 0 ? <div style={hint}>{t('kb_noJobs')}</div>
        : <div style={{ maxHeight: '44vh', overflow: 'auto' }}>{jobs.slice(0, 10).map(job => <div key={job.id}>
          <div role="button" tabIndex={0} onClick={() => setOpen(job.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(job.id) }} style={{ ...row, cursor: 'pointer', padding: '10px 0' }} data-team-kb-job={job.state}>
            <span style={label}>{t(`kb_op_${job.op}`)} <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>{date(job.queuedAt)}</span></span>
            <Tag tone={jobTone(job.state)}>{jobState(t, job.state)}</Tag>
          </div>
          {shown === job.id && <JobDetail job={job} t={t} />}
        </div>)}</div>}
      {kb.archivedAt === null && <Line end title={t('kb_archive')} detail={t('kb_archiveHint')}>
        <Button variant="outline" size="sm" onClick={archive} disabled={request.busy || kb.share.state === 'pending' || kb.share.state === 'published'}><IconArchiveOutlineRegular size={14} />{t('kb_archive')}</Button>
      </Line>}
    </div>
  </Modal>
}

/** Create a personal knowledge base from a named library folder.
 * @param props - API, translator and dialog lifecycle callbacks.
 * @returns The creation dialog.
 */
export function CreateDialog({ api, t, onClose, onCreated }: { api: KbApi; t: T; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [error, setError] = useState<string>()
  const request = usePendingAction(error => setError(errorText(t, error)))
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) { setError(undefined); request.run(() => api.create(title.trim(), description.trim()), () => { onCreated(); onClose() }) } }
  return <Modal open onClose={onClose} title={t('kb_createTitle')} description={t('kb_createHint')} closeLabel={t('kb_cancel')}>
    <form onSubmit={submit} data-team-kb-create style={{ display: 'grid', gap: 12 }}>
      <label style={field}>{t('kb_name')}<Input data-modal-autofocus maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label style={field}>{t('kb_description')}<Input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {error !== undefined && <p role="alert" style={status(false)}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={onClose}>{t('kb_cancel')}</Button><Button type="submit" variant="primary" disabled={request.busy || !title.trim()}>{t('kb_save')}</Button></div>
    </form>
  </Modal>
}

/** Request-share dialog: the current commit goes to the approval queue. */
export function ShareDialog({ api, kb, t, onClose, onSent }: { api: KbApi; kb: KbItem; t: T; onClose: () => void; onSent: () => void }) {
  const [note, setNote] = useState(''), [error, setError] = useState<string>()
  const request = usePendingAction(error => setError(errorText(t, error)))
  const submit = (event: FormEvent) => { event.preventDefault(); setError(undefined); request.run(() => api.share(kb.id, note.trim()), () => { onSent(); onClose() }) }
  return <Modal open onClose={onClose} title={`${t('kb_shareTitle')}: ${kb.title}`} description={t('kb_shareHint')} closeLabel={t('kb_cancel')}>
    <form onSubmit={submit} data-team-kb-share style={{ display: 'grid', gap: 12 }}>
      <label style={field}>{t('kb_note')}<Input data-modal-autofocus maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label>
      {error !== undefined && <p role="alert" style={status(false)}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={onClose}>{t('kb_cancel')}</Button><Button type="submit" variant="primary" disabled={request.busy}>{t('kb_send')}</Button></div>
    </form>
  </Modal>
}
