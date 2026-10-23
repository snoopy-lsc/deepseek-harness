/** Personal center, My plugins: submissions (submit / withdraw / ask delist), defaults with re-enable, revoked notice, and profile snapshots. */
import { Button, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { PluginSource, PluginSubmission, PluginsApi, PluginSnapshot, PluginsOverview } from './plugins-api.ts'
import { AccountApiError } from './me.ts'
import { pluginsCopy } from './plugins-copy.ts'

type PlgKey = keyof typeof pluginsCopy.en
type T = (key: PlgKey) => string

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
const date = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const errorText = (t: T, error: unknown) => error instanceof AccountApiError ? t('plg_failed') : t('plg_failed')

const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }
const label: CSSProperties = { fontSize: 14, lineHeight: '20px' }
const hint: CSSProperties = { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }
const field: CSSProperties = { display: 'grid', gap: 6, minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
const notice: CSSProperties = { margin: '12px 0 0', padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: '20px', background: 'var(--dsw-alias-interactive-bg-hover)' }
const status = (ok: boolean): CSSProperties => ({ margin: 0, padding: '12px 0 0', fontSize: 12, lineHeight: '18px', color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' })

function Line({ title, detail, children, end }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; end?: boolean }) {
  return <div style={end ? { ...row, borderBottom: 'none' } : row}>
    <div style={{ minWidth: 0 }}><div style={label}>{title}</div>{detail !== undefined && <div style={hint}>{detail}</div>}</div>
    {children !== undefined && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>{children}</div>}
  </div>
}

const stateTone = (state: PluginSubmission['state']) => state === 'approved' ? 'success' : state === 'pending' ? 'info' : state === 'rejected' || state === 'revoked' ? 'danger' : 'neutral'

function SubmitDialog({ api, t, onClose, onSent }: { api: PluginsApi; t: T; onClose: () => void; onSent: () => void }) {
  const [name, setName] = useState(''), [version, setVersion] = useState(''), [sourceType, setSourceType] = useState<'npm' | 'git' | 'upload'>('npm')
  const [registry, setRegistry] = useState(''), [gitUrl, setGitUrl] = useState(''), [commit, setCommit] = useState(''), [gitPath, setGitPath] = useState('')
  const [note, setNote] = useState(''), [error, setError] = useState<string>()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !version.trim()) return
    const source: PluginSource = sourceType === 'npm'
      ? { type: 'npm', registry: registry.trim(), name: name.trim(), version: version.trim() }
      : sourceType === 'git'
        ? { type: 'git', url: gitUrl.trim(), commit: commit.trim(), name: name.trim(), version: version.trim(), ...gitPath.trim() ? { path: gitPath.trim() } : {} }
        : { type: 'upload', name: name.trim(), version: version.trim() }
    api.submit({ name: name.trim(), version: version.trim(), source, ...note.trim() ? { note: note.trim() } : {} })
      .then(() => { onSent(); onClose() }, e => setError(errorText(t, e)))
  }
  return <Modal open onClose={onClose} title={t('plg_submitTitle')} description={t('plg_submitHint')} closeLabel={t('plg_cancel')}>
    <form onSubmit={submit} data-team-plg-submit style={{ display: 'grid', gap: 12 }}>
      <label style={field}>{t('plg_name')}<Input data-modal-autofocus maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
      <label style={field}>{t('plg_version')}<Input maxLength={64} value={version} onChange={e => setVersion(e.target.value)} /></label>
      <SegmentedControl id="team-plg-source" label={t('plg_source')} value={sourceType} onChange={setSourceType}
        options={[{ value: 'npm', label: t('plg_source_npm') }, { value: 'git', label: t('plg_source_git') }, { value: 'upload', label: t('plg_source_upload') }]} />
      {sourceType === 'npm' && <label style={field}>{t('plg_registry')}<Input value={registry} onChange={e => setRegistry(e.target.value)} /></label>}
      {sourceType === 'git' && <>
        <label style={field}>{t('plg_gitUrl')}<Input value={gitUrl} onChange={e => setGitUrl(e.target.value)} /></label>
        <label style={field}>{t('plg_gitCommit')}<Input value={commit} onChange={e => setCommit(e.target.value)} /></label>
        <label style={field}>{t('plg_gitPath')}<Input value={gitPath} onChange={e => setGitPath(e.target.value)} /></label>
      </>}
      <label style={field}>{t('plg_note')}<Input maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label>
      {error !== undefined && <p role="alert" style={status(false)}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="outline" onClick={onClose}>{t('plg_cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || !version.trim()}>{t('plg_send')}</Button>
      </div>
    </form>
  </Modal>
}

/** The My plugins section body.
 * @param props - plugins client, translator and the section frame.
 * @returns the framed section, or nothing when the deployment has no plugins service.
 */
export function MyPlugins({ api, t, frame }: { api: PluginsApi; t: T; frame: (body: ReactNode) => ReactNode }) {
  const [overview, setOverview] = useState<PluginsOverview | null>(), [snapshots, setSnapshots] = useState<readonly PluginSnapshot[]>([])
  const [note, setNote] = useState<{ ok: boolean; text: string }>(), [dialog, setDialog] = useState(false)
  const load = useCallback(() => {
    api.overview().then(setOverview, () => setOverview(null))
    api.snapshots().then(setSnapshots, () => setSnapshots([]))
  }, [api])
  useEffect(load, [load])
  if (overview === undefined) return frame(<Line title={t('plg_loading')} end />)
  if (overview === null) return null
  const fail = (error: unknown) => setNote({ ok: false, text: errorText(t, error) })
  return frame(<div data-team-plg>
    {(overview.revoked || overview.restartRequired) && <p role="status" style={notice}>
      <Tag tone="warning">{overview.revoked ? t('plg_revokedFlag') : t('plg_restartNotice')}</Tag>
    </p>}
    <Line title={t('plg_title')} detail={t('plg_submitHint')}>
      <Button variant="outline" onClick={() => setDialog(true)} data-team-plg-new>{t('plg_submit')}</Button>
    </Line>
    {note !== undefined && <p role={note.ok ? 'status' : 'alert'} style={status(note.ok)}>{note.text}</p>}
    {overview.submissions.length === 0 && <Line title={t('plg_none')} />}
    {overview.submissions.map(item => <Line key={item.versionId} end={false}
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><code>{item.name}</code>
        <Tag tone={stateTone(item.state)}>{t(`plg_state_${item.state}` as PlgKey)}</Tag></span>}
      detail={[fill(t('plg_versionLabel'), { version: item.version }), item.mirrorState ? fill(t('plg_mirror'), { state: item.mirrorState }) : undefined,
        item.state === 'rejected' && item.reason ? fill(t('plg_rejected'), { reason: item.reason }) : undefined,
        item.submittedAt ? date(item.submittedAt) : undefined].filter(Boolean).join(' · ')}>
      {item.state === 'pending' && <Button variant="outline" size="sm" onClick={() => { api.withdraw(item.versionId).then(load, fail) }} data-team-plg-withdraw>{t('plg_withdraw')}</Button>}
      {(item.state === 'approved' || item.state === 'revoked') && <Button variant="outline" size="sm" onClick={() => { api.delistRequest(item.packageId).then(() => { setNote({ ok: true, text: t('plg_done') }); load() }, fail) }} data-team-plg-delist>{t('plg_delistAsk')}</Button>}
    </Line>)}
    <div style={{ ...label, fontWeight: 600, padding: '16px 0 0' }}>{t('plg_defaults')}</div>
    {overview.defaults.length === 0 ? <Line title={<span style={hint}>{t('plg_noDefaults')}</span>} />
      : overview.defaults.map((item, index) => <Line key={item.packageId} end={index === overview.defaults.length - 1 && snapshots.length === 0}
        title={<code>{item.name ?? item.packageId}</code>} detail={fill(t('plg_defaultState'), { state: item.state })}>
        {item.optedOut && <Button variant="outline" size="sm" onClick={() => { api.reenableDefault(item.packageId).then(() => { setNote({ ok: true, text: t('plg_done') }); load() }, fail) }}>{t('plg_reenable')}</Button>}
      </Line>)}
    <div style={{ ...label, fontWeight: 600, padding: '16px 0 0' }}>{t('plg_snapshots')}</div>
    {snapshots.length === 0 ? <Line end title={<span style={hint}>{t('plg_noSnapshots')}</span>} />
      : snapshots.map((snap, index) => <Line key={snap.id} end={index === snapshots.length - 1} title={snap.label ?? snap.id} detail={fill(t('plg_snapshotAt'), { date: date(snap.savedAt) })}>
        <Button variant="outline" size="sm" onClick={() => { api.restore(snap.id).then(() => setNote({ ok: true, text: t('plg_restored') }), fail) }}>{t('plg_restore')}</Button>
      </Line>)}
    {dialog && <SubmitDialog api={api} t={t} onClose={() => setDialog(false)} onSent={() => { setNote({ ok: true, text: t('plg_submitted') }); load() }} />}
  </div>)
}
