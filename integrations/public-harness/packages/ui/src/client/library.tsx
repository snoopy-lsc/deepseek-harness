/** Standalone knowledge library: private materials, published team knowledge, files and safe text previews. */
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconDatabaseOutlineRegular, IconEnhanceOutlineRegular,
  IconFolderOpenOutlineRegular, IconPaperclipOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconShareOutlineRegular, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AdminApi } from './admin-api.ts'
import type { T as AdminT } from './admin-kit.tsx'
import { KbInventory } from './admin-kb-inventory.tsx'
import { KbRequests } from './admin-kb.tsx'
import type { KbApi, KbContent, KbFile, KbItem, KbOverview, KbShared } from './kb-api.ts'
import { kbCopy, size } from './kb-copy.ts'
import { CreateDialog, JobDrawer, ShareDialog } from './kb.tsx'
import { libraryCopy } from './library-copy.ts'
import { browseEntries, filterLibraries, sourceFileError, type LibraryEntry } from './library-model.ts'
import { AccountApiError } from './me.ts'

/** Library locale, including the shared create/compile/share dialog labels. */
export const libraryDictionaries = { en: { ...kbCopy.en, ...libraryCopy.en }, zh: { ...kbCopy.zh, ...libraryCopy.zh } }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { publicHarnessLibrary: keyof typeof libraryDictionaries.en }
}

type T = PropsLocale<'publicHarnessLibrary'>['t']
type Tab = 'own' | 'shared' | 'manage' | 'reviews'
type Selection = { readonly kind: 'own'; readonly kb: KbItem } | { readonly kind: 'shared'; readonly kb: KbShared }
interface LoadState<Value> { readonly value?: Value; readonly loading: boolean; readonly error?: unknown }

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
const date = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' })
const stack: CSSProperties = { display: 'grid', gap: 16, minWidth: 0 }
const actions: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
const hint: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px', overflowWrap: 'anywhere' }
const card: CSSProperties = { boxSizing: 'border-box', minWidth: 0, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-settings-card-fill)', border: '0.5px solid var(--dsw-alias-border-l2)' }
const tileGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 16 }
const errorStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, lineHeight: '20px', overflowWrap: 'anywhere' }

function useLoad<Value>(load: () => Promise<Value>, version: number): LoadState<Value> {
  const [state, setState] = useState<LoadState<Value>>({ loading: true })
  useEffect(() => {
    let live = true
    setState(previous => ({ ...previous, loading: true, error: undefined }))
    load().then(value => { if (live) setState({ value, loading: false }) }, error => {
      if (live) setState(previous => ({ ...(error instanceof AccountApiError && [401, 403, 404].includes(error.status) ? {} : { value: previous.value }), loading: false, error }))
    })
    return () => { live = false }
  }, [load, version])
  return state
}

function operationError(t: T, error: unknown): string {
  if (error instanceof AccountApiError) {
    const key = `kb_err_${error.code.replace(/-/g, '_')}` as keyof typeof kbCopy.en
    if (key in kbCopy.en) return t(key)
  }
  return t('kb_failed')
}
function contentError(t: T, error: unknown, preview = false): string {
  return error instanceof AccountApiError && (error.status === 403 || error.status === 404)
    ? t('libraryAccessLost') : t(preview ? 'libraryPreviewFailed' : 'libraryFilesFailed')
}
function Loading({ t }: { t: T }) {
  return <div role="status" aria-label={t('kb_loading')} style={{ display: 'grid', placeItems: 'center', minHeight: 160 }}><StateDot state="ongoing" size={20} /></div>
}
function Failure({ text, retry, t }: { text: string; retry: () => void; t: T }) {
  return <div style={{ ...card, ...actions, padding: '12px 16px', justifyContent: 'space-between' }}><p role="alert" style={errorStyle}>{text}</p><Button variant="outline" size="sm" onClick={retry}>{t('libraryRetry')}</Button></div>
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div style={{ ...card, display: 'grid', justifyItems: 'center', gap: 12, padding: '44px 24px', textAlign: 'center' }}>
    <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: 56, height: 56, borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }}><IconFolderOpenOutlineRegular size={28} /></span>
    <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500 }}>{title}</h2><p style={{ ...hint, maxWidth: 420 }}>{detail}</p>
  </div>
}

function LibraryTabs({ value, admin, onChange, t }: { value: Tab; admin: boolean; onChange: (value: Tab) => void; t: T }) {
  const tabs: Array<{ key: Tab; label: keyof typeof libraryCopy.en }> = [{ key: 'own', label: 'libraryMine' }, { key: 'shared', label: 'libraryShared' },
    ...admin ? [{ key: 'manage' as const, label: 'libraryManage' as const }, { key: 'reviews' as const, label: 'libraryReviews' as const }] : []]
  return <div role="tablist" aria-label={t('libraryTabs')} style={{ ...actions, gap: 6, borderBottom: '0.5px solid var(--dsw-alias-border-l2)', paddingBottom: 12 }}>
    {tabs.map((tab, index) => <Button key={tab.key} role="tab" id={`team-library-tab-${tab.key}`} aria-selected={value === tab.key} aria-controls="team-library-panel" tabIndex={value === tab.key ? 0 : -1}
      variant="ghost" style={{ fontWeight: 500, ...value === tab.key ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {} }} onClick={() => onChange(tab.key)}
      onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
        if (next === undefined) return
        event.preventDefault(); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(next).focus(); onChange(tabs[next]!.key)
      }}>{t(tab.label)}</Button>)}
  </div>
}

function Limits({ overview, t }: { overview: KbOverview; t: T }) {
  const { limits, usage } = overview
  return <div style={{ ...stack, gap: 10 }}>
    <div aria-label={t('libraryLimits')} style={{ ...actions, justifyContent: 'space-between', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>
      <span>{fill(t(limits.max_kbs.value === null ? 'kb_summaryUnlimited' : 'kb_summary'), { count: usage.kbs, max: limits.max_kbs.value ?? '' })}</span>
      <span>{fill(t('kb_each'), { bytes: limits.max_bytes.value === null ? t('kb_unlimited') : size(limits.max_bytes.value), pages: limits.max_pages.value ?? t('kb_unlimited') })}</span>
    </div>
    {overview.over.map((over, index) => <p key={index} role="status" style={{ ...card, margin: 0, padding: '10px 14px', fontSize: 13, lineHeight: '20px', overflowWrap: 'anywhere' }}>
      {fill(t(over.limit === 'max_kbs' ? 'kb_overCount' : 'kb_over'), { kb: overview.kbs.find(kb => kb.id === over.kbId)?.title ?? '', limit: t(`kb_limit_${over.limit}`), value: over.value, allowed: over.allowed })}
    </p>)}
  </div>
}

const shareTone = (state: KbItem['share']['state']) => state === 'published' ? 'success' : state === 'pending' ? 'info' : state === 'rejected' ? 'danger' : state === 'revoked' ? 'warning' : 'neutral'
function LibraryTile({ selection, t, open }: { selection: Selection; t: T; open: () => void }) {
  const item = selection.kb
  return <Button variant="ghost" data-team-library-kb={item.id} onClick={open} style={{ ...card, display: 'grid', gap: 14, height: 'auto', minHeight: 176, width: '100%', padding: 20, textAlign: 'left', justifyContent: 'stretch', alignContent: 'start', whiteSpace: 'normal' }}>
    <span style={{ ...actions, justifyContent: 'space-between', gap: 12 }}><span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-interactive-bg-hover)' }}><IconFolderOpenOutlineRegular size={22} /></span>
      {selection.kind === 'own' ? <Tag tone={shareTone(selection.kb.share.state)}>{t(`kb_state_${selection.kb.share.state}`)}</Tag> : <Tag tone="quiet">{t('libraryReadOnly')}</Tag>}</span>
    <span style={{ display: 'grid', gap: 6, minWidth: 0 }}><span style={{ fontSize: 15, lineHeight: '22px', fontWeight: 500, overflowWrap: 'anywhere' }}>{item.title}</span>
      <span style={hint}>{selection.kind === 'own' ? selection.kb.description || t('libraryNoDescription') : fill(t('libraryOwner'), { owner: selection.kb.owner ?? t('kb_org') })}</span></span>
    <span style={{ display: 'grid', gap: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>
      {selection.kind === 'own' && <span>{fill(t('kb_stats'), { pages: selection.kb.pages, sources: selection.kb.sources, size: size(selection.kb.bytes) })}</span>}
      <span>{fill(t(selection.kind === 'own' ? 'libraryCreated' : 'libraryPublished'), { date: date(selection.kind === 'own' ? selection.kb.createdAt : selection.kb.publishedAt) })}</span>
    </span>
  </Button>
}

function entryName(entry: LibraryEntry, t: T): string {
  return entry.path === 'raw' && entry.kind === 'directory' ? t('librarySources') : entry.path === 'wiki' && entry.kind === 'directory' ? t('libraryWiki') : entry.name
}
function FilePreview({ api, kbId, path, version, close, t }: { api: KbApi; kbId: string; path: string; version: number; close: () => void; t: T }) {
  const load = useCallback(() => api.file(kbId, path), [api, kbId, path])
  const [retry, setRetry] = useState(0), file = useLoad<KbFile>(load, version + retry)
  return <section aria-label={t('libraryPreview')} data-team-library-preview style={{ ...card, ...stack, padding: 20, alignContent: 'start' }}>
    <div style={{ ...actions, alignItems: 'flex-start', justifyContent: 'space-between' }}><div style={{ display: 'grid', gap: 4, minWidth: 0, flex: 1 }}><h3 style={{ margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500, overflowWrap: 'anywhere' }}>{path}</h3><p style={{ ...hint, fontSize: 12 }}>{t('libraryPlainText')}{file.value === undefined ? '' : ` · ${size(file.value.bytes)}`}</p></div>
      <Button variant="ghost" size="sm" onClick={close}>{t('libraryPreviewBack')}</Button></div>
    {file.error !== undefined && <Failure text={contentError(t, file.error, true)} retry={() => setRetry(value => value + 1)} t={t} />}
    {file.loading && file.value === undefined ? <Loading t={t} /> : file.value !== undefined && <>
      {file.value.truncated && <p role="status" style={hint}>{t('libraryTruncated')}</p>}
      {file.value.text === null ? <p style={hint}>{t('libraryNoPreview')}</p> : file.value.text === '' ? <p style={hint}>{t('libraryEmptyFile')}</p>
        : <pre tabIndex={0} style={{ boxSizing: 'border-box', maxHeight: '60vh', overflow: 'auto', margin: 0, padding: 14, borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-interactive-bg-hover)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: '22px', fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' }}>{file.value.text}</pre>}
    </>}
  </section>
}

function LibraryBrowser({ api, selection, onBack, onChanged, t }: { api: KbApi; selection: Selection; onBack: () => void; onChanged: () => void; t: T }) {
  const [version, setVersion] = useState(0), [directory, setDirectory] = useState(''), [query, setQuery] = useState(''), [path, setPath] = useState<string>()
  const [dialog, setDialog] = useState<'jobs' | 'share'>(), [busy, setBusy] = useState<'upload' | 'withdraw'>(), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const file = useRef<HTMLInputElement>(null), mutation = useRef(false), live = useRef(true)
  const load = useCallback(() => api.content(selection.kb.id), [api, selection.kb.id]), content = useLoad<KbContent>(load, version)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const refresh = useCallback(() => { setVersion(value => value + 1); onChanged() }, [onChanged])
  const own = selection.kind === 'own' ? selection.kb : undefined
  const editable = own !== undefined && own.archivedAt === null && content.error === undefined && content.value?.readOnly === false
  const run = (kind: 'upload' | 'withdraw', work: () => Promise<void>, done: string) => {
    if (mutation.current) return
    mutation.current = true; setBusy(kind); setNote(undefined)
    work().then(() => { if (live.current) { setNote({ ok: true, text: done }); refresh() } }, error => { if (live.current) setNote({ ok: false, text: operationError(t, error) }) })
      .finally(() => { mutation.current = false; if (live.current) setBusy(undefined) })
  }
  const entries = browseEntries(content.value?.files ?? [], directory, query)
  const enter = (next: string) => { setDirectory(next); setQuery(''); setPath(undefined) }
  const parts = directory === '' ? [] : directory.split('/')
  return <div style={stack} data-team-library-browser={selection.kb.id}>
    <div style={actions}><Button variant="ghost" onClick={onBack}><IconChevronLeftOutlineRegular size={14} />{t('libraryBack')}</Button></div>
    <nav aria-label={t('libraryBreadcrumb')} style={{ ...actions, gap: 4, fontSize: 13, lineHeight: '20px' }}>
      <Button variant="ghost" size="sm" onClick={onBack}>{t('libraryTitle')}</Button><IconChevronRightOutlineRegular size={12} />
      <Button variant="ghost" size="sm" onClick={() => enter('')} style={{ maxWidth: '100%', height: 'auto', minHeight: 28, whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' }}>{selection.kb.title}</Button>
      {parts.map((part, index) => <span key={index} style={{ ...actions, gap: 4, maxWidth: '100%' }}><IconChevronRightOutlineRegular size={12} /><Button variant="ghost" size="sm" onClick={() => enter(parts.slice(0, index + 1).join('/'))} style={{ height: 'auto', minHeight: 28, whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' }}>{part}</Button></span>)}
    </nav>
    <header style={{ ...actions, justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
      <div style={{ display: 'grid', gap: 8, minWidth: 0, flex: '1 1 260px' }}><h2 style={{ margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 500, overflowWrap: 'anywhere' }}>{selection.kb.title}</h2>
        {own !== undefined && <p style={hint}>{own.description}</p>}
        <div style={actions}>{own !== undefined ? <Tag tone={shareTone(own.share.state)}>{t(`kb_state_${own.share.state}`)}</Tag> : <Tag tone="quiet">{t('libraryReadOnly')}</Tag>}
          {content.value !== undefined && <span style={{ ...hint, fontSize: 12 }}>{fill(t('libraryFileDetails'), { count: content.value.files.length, size: size(content.value.files.reduce((total, item) => total + item.bytes, 0)) })}</span>}</div>
      </div>
      {editable && own !== undefined && <div style={actions}>
        <Button variant="primary" disabled={busy !== undefined} onClick={() => file.current?.click()} data-team-kb-upload><IconPlusOutlineRegular size={14} />{t(busy === 'upload' ? 'libraryUploading' : 'kb_upload')}</Button>
        <Button variant="outline" disabled={busy !== undefined} onClick={() => setDialog('jobs')} data-team-kb-compile><IconEnhanceOutlineRegular size={14} />{t('kb_compile')}</Button>
        {own.share.state === 'pending' ? <Button variant="outline" disabled={busy !== undefined} onClick={() => run('withdraw', () => api.withdraw(own.id), t('libraryWithdrawn'))}>{t(busy === 'withdraw' ? 'libraryWithdrawing' : 'kb_withdraw')}</Button>
          : <Button variant="outline" disabled={busy !== undefined} onClick={() => setDialog('share')} data-team-kb-share-open><IconShareOutlineRegular size={14} />{t('kb_share')}</Button>}
      </div>}
    </header>
    {selection.kind === 'shared' && <p style={hint}>{t('libraryReadOnlyHint')}</p>}
    {editable && <p style={{ ...hint, fontSize: 12 }}>{t('libraryUploadHint')}</p>}
    {own?.share.state === 'rejected' && own.share.reason && <p role="status" style={hint}>{fill(t('kb_rejected'), { reason: own.share.reason })}</p>}
    {note !== undefined && <p role={note.ok ? 'status' : 'alert'} style={note.ok ? hint : errorStyle}>{note.text}</p>}
    <div style={{ ...actions, justifyContent: 'space-between' }}><div style={{ display: 'grid', minWidth: 0, flex: '1 1 220px', maxWidth: 480 }}><Input icon={<IconSearchOutlineRegular size={16} />} aria-label={t('librarySearchFiles')} placeholder={t('librarySearchFiles')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <Button variant="outline" disabled={content.loading || busy !== undefined} onClick={() => setVersion(value => value + 1)}><IconRefreshOutlineRegular size={14} />{t('libraryReload')}</Button></div>
    {content.error !== undefined && <Failure text={contentError(t, content.error)} retry={() => setVersion(value => value + 1)} t={t} />}
    {content.loading && content.value === undefined ? <Loading t={t} /> : content.value !== undefined && <div style={{ display: 'grid', gridTemplateColumns: path === undefined ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 16, minWidth: 0 }}>
      <section aria-label={t('libraryContents')} style={{ ...card, padding: 12, minWidth: 0, alignSelf: 'start' }}>
        <div style={{ ...actions, justifyContent: 'space-between', padding: '4px 8px 12px', fontSize: 13, fontWeight: 500 }}><span>{t(directory === '' ? 'libraryAllFiles' : 'libraryContents')}</span><span style={{ ...hint, fontSize: 12 }}>{entries.length}</span></div>
        {entries.length === 0 ? <p style={{ ...hint, padding: '24px 8px' }}>{t(query.trim() === '' ? 'libraryEmptyFolder' : 'libraryNoFilesMatch')}</p>
          : <div style={{ display: 'grid', maxHeight: 'min(48vh, 440px)', overflow: 'auto', gap: 2, padding: 2 }}>
            {entries.map(entry => <Button variant="ghost" key={entry.path} data-team-library-file={entry.path} aria-pressed={entry.kind === 'file' ? path === entry.path : undefined} onClick={() => entry.kind === 'directory' ? enter(entry.path) : setPath(entry.path)}
              style={{ justifyContent: 'flex-start', width: '100%', height: 'auto', minHeight: 58, padding: '10px 12px', gap: 12, textAlign: 'left', ...path === entry.path ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {} }}>
              <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-secondary)' }}>{entry.kind === 'directory' ? <IconFolderOpenOutlineRegular size={20} /> : <IconPaperclipOutlineRegular size={18} />}</span>
              <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}><span style={{ fontSize: 13, lineHeight: '20px', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{entryName(entry, t)}</span>
                <span style={{ ...hint, fontSize: 12 }}>{entry.kind === 'directory' ? `${entry.name}/ · ${fill(t('libraryFileCount'), { count: entry.count })}` : size(entry.bytes)}</span></span>
              {entry.kind === 'directory' && <span aria-hidden="true" style={{ flex: 'none' }}><IconChevronRightOutlineRegular size={14} /></span>}
            </Button>)}
          </div>}
      </section>
      {path !== undefined && <FilePreview key={`${selection.kb.id}/${path}`} api={api} kbId={selection.kb.id} path={path} version={version} close={() => setPath(undefined)} t={t} />}
    </div>}
    <input ref={file} type="file" hidden accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm" data-team-library-upload onChange={event => {
      const chosen = event.target.files?.[0]; event.target.value = ''
      if (chosen === undefined || !editable) return
      const invalid = sourceFileError(chosen)
      if (invalid !== undefined) { setNote({ ok: false, text: t(invalid) }); return }
      run('upload', () => api.upload(selection.kb.id, { name: chosen.name, data: chosen }), fill(t('libraryFileUploaded'), { name: chosen.name }))
    }} />
    {dialog === 'jobs' && own !== undefined && <JobDrawer api={api} kb={own} t={t} onClose={() => setDialog(undefined)} onChanged={refresh} />}
    {dialog === 'share' && own !== undefined && <ShareDialog api={api} kb={own} t={t} onClose={() => setDialog(undefined)} onSent={() => { setNote({ ok: true, text: t('kb_requested') }); refresh() }} />}
  </div>
}

/** Independent library panel with personal, team and administrator sections.
 * @param props - Authenticated knowledge APIs, administrator locale where allowed, and library locale.
 * @returns The library page.
 */
export function LibraryPage({ api, admin, adminT, t }: { api: KbApi; admin?: AdminApi; adminT?: AdminT } & PropsLocale<'publicHarnessLibrary'>) {
  const [tab, setTab] = useState<Tab>('own'), [query, setQuery] = useState(''), [selection, setSelection] = useState<Selection>(), [creating, setCreating] = useState(false), [version, setVersion] = useState(0)
  const overview = useLoad<KbOverview>(api.overview, version), shared = useLoad<readonly KbShared[]>(api.shared, version)
  const reload = useCallback(() => setVersion(value => value + 1), [])
  const ownItems = overview.value?.kbs.filter(kb => kb.archivedAt === null) ?? [], sharedItems = shared.value ?? []
  const items = tab === 'own' ? filterLibraries(ownItems, query) : filterLibraries(sharedItems, query)
  const current = selection?.kind === 'own' ? { kind: 'own' as const, kb: overview.value?.kbs.find(kb => kb.id === selection.kb.id) ?? selection.kb } : selection
  const personal = tab === 'own' || tab === 'shared', loading = tab === 'own' ? overview.loading : shared.loading, value = tab === 'own' ? overview.value : shared.value, error = tab === 'own' ? overview.error : shared.error
  const atMax = overview.value !== undefined && overview.value.limits.max_kbs.value !== null && overview.value.usage.kbs >= overview.value.limits.max_kbs.value
  const switchTab = (next: Tab) => { setTab(next); setSelection(undefined); setCreating(false); setQuery('') }
  return <div data-team-library style={{ boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '36px clamp(16px, 4vw, 48px) 64px', color: 'var(--dsw-alias-label-primary)' }}>
    <div style={{ display: 'grid', gap: 24, maxWidth: 1120, margin: '0 auto', minWidth: 0 }}>
      <header style={{ ...actions, alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0, flex: '1 1 280px' }}><h1 style={{ ...actions, gap: 10, margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 500 }}><IconDatabaseOutlineRegular size={24} />{t('libraryTitle')}</h1><p style={{ ...hint, maxWidth: 680 }}>{t('librarySubtitle')}</p></div>
        {tab === 'own' && <Button variant="primary" disabled={overview.value === undefined || atMax} onClick={() => setCreating(true)} data-team-kb-new><IconPlusOutlineRegular size={16} />{t('kb_create')}</Button>}
      </header>
      <LibraryTabs value={tab} admin={admin !== undefined && adminT !== undefined} onChange={switchTab} t={t} />
      <div role="tabpanel" id="team-library-panel" aria-labelledby={`team-library-tab-${tab}`} style={stack}>
        {tab === 'manage' && admin !== undefined && adminT !== undefined ? <div style={{ ...stack, overflowX: 'auto' }}><KbInventory api={admin} t={adminT} /></div>
          : tab === 'reviews' && admin !== undefined && adminT !== undefined ? <div style={{ ...stack, overflowX: 'auto' }}><KbRequests api={admin} t={adminT} /></div>
            : personal && current !== undefined ? <LibraryBrowser key={`${current.kind}/${current.kb.id}`} api={api} selection={current} onBack={() => setSelection(undefined)} onChanged={reload} t={t} />
              : personal && <>
                <div style={{ ...actions, justifyContent: 'space-between', gap: 16 }}><div style={{ display: 'grid', minWidth: 0, flex: '1 1 240px', maxWidth: 480 }}><Input icon={<IconSearchOutlineRegular size={16} />} aria-label={t('librarySearch')} placeholder={t('librarySearch')} value={query} onChange={event => setQuery(event.target.value)} /></div>
                  <Button variant="outline" disabled={loading} onClick={reload}><IconRefreshOutlineRegular size={14} />{t('libraryReload')}</Button></div>
                <p style={hint}>{t(tab === 'own' ? 'libraryMineHint' : 'librarySharedHint')}</p>
                {tab === 'own' && overview.value !== undefined && <Limits overview={overview.value} t={t} />}
                {error !== undefined && <Failure text={error instanceof AccountApiError && error.status === 404 ? t('libraryNoService') : t('libraryLoadFailed')} retry={reload} t={t} />}
                {loading && value === undefined ? <Loading t={t} /> : value !== undefined && (items.length === 0
                  ? <Empty title={query.trim() !== '' ? t('libraryNoMatches') : t(tab === 'own' ? 'libraryEmptyTitle' : 'librarySharedEmptyTitle')} detail={query.trim() !== '' ? t('librarySearch') : t(tab === 'own' ? 'libraryEmptyHint' : 'librarySharedEmptyHint')} />
                  : <div style={tileGrid}>{tab === 'own' ? filterLibraries(ownItems, query).map(kb => <LibraryTile key={kb.id} selection={{ kind: 'own', kb }} t={t} open={() => setSelection({ kind: 'own', kb })} />)
                    : filterLibraries(sharedItems, query).map(kb => <LibraryTile key={kb.id} selection={{ kind: 'shared', kb }} t={t} open={() => setSelection({ kind: 'shared', kb })} />)}</div>)}
              </>}
      </div>
      {creating && <CreateDialog api={api} t={t} onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  </div>
}
