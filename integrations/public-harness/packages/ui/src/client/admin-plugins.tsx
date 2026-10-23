/** System Admin, Plugin market: review queue, listed plugins (scope / rollback / delist / revoke), upload, defaults, policy and limits.
 * Built from admin-kit cards and rows; re-authentication wraps approve / upload / scope / rollback / delist / revoke and other design-listed writes. */
import { Button, Checkbox, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type {
  AdminApi, AdminGroup, AdminPlugin, AdminPluginLimits, AdminPluginPolicy, AdminPluginRequest, AdminPluginRequestDetail,
  PluginLimitName, PluginLimitScope, PluginScopeEntry, PluginUploadBody, Proof,
} from './admin-api.ts'
import { groupName } from './admin-groups.tsx'
import { useDirectory } from './admin-kb.tsx'
import { Card, date, errorText, field, fill, hint, label, Note, Row, select, type T, useReauth } from './admin-kit.tsx'

type Tab = 'requests' | 'listed' | 'upload' | 'defaults' | 'policy' | 'limits'
type Attempt = (run: (proof: Proof) => Promise<void>) => void

function PluginScopePicker({ t, value, onChange, groups }: { t: T; value: readonly PluginScopeEntry[]; onChange: (next: PluginScopeEntry[]) => void; groups: readonly AdminGroup[] }) {
  const company = value.some(entry => entry.kind === 'company')
  const [pick, setPick] = useState('')
  const options = groups.map(g => ({ value: g.id, label: `${groupName(g)} (${g.source})` })).filter(option => !value.some(entry => entry.kind === 'group' && entry.target === option.value))
  return <div data-team-admin-plg-scope style={{ display: 'grid', gap: 10 }}>
    <div style={label}>{t('plgScope')}</div>
    <SegmentedControl id="team-admin-plg-scope" label={t('plgScope')} value={company ? 'company' : 'list'} onChange={v => onChange(v === 'company' ? [{ kind: 'company', target: '*' }] : [])}
      options={[{ value: 'company', label: t('plgScopeCompany') }, { value: 'list', label: t('plgScopeGroups') }]} />
    {!company && <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {value.length === 0 ? <span style={hint}>{t('plgScopeEmpty')}</span> : value.map(entry => <span key={`${entry.kind}:${entry.target}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Tag tone="info">{groups.find(g => g.id === entry.target) ? groupName(groups.find(g => g.id === entry.target)!) : entry.target}</Tag>
          <Button variant="outline" size="sm" aria-label={`${t('remove')} ${entry.target}`} onClick={() => onChange(value.filter(e => e !== entry))}>×</Button>
        </span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
        <label style={field}>{t('plgSearchGroups')}<select style={select} value={pick} onChange={e => setPick(e.target.value)}><option value="">—</option>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <Button variant="outline" disabled={!pick} onClick={() => { onChange([...value, { kind: 'group', target: pick }]); setPick('') }}>{t('plgAdd')}</Button>
      </div>
    </>}
  </div>
}

function Review({ api, t, request, attempt, onClose, onDone }: { api: AdminApi; t: T; request: AdminPluginRequest; attempt: Attempt; onClose: () => void; onDone: (text: string) => void }) {
  const [detail, setDetail] = useState<AdminPluginRequestDetail | null>(), [error, setError] = useState<string>()
  const [scope, setScope] = useState<PluginScopeEntry[]>([{ kind: 'company', target: '*' }])
  const [digest, setDigest] = useState(request.artifactSha512 ?? ''), [builds, setBuilds] = useState(''), [rejecting, setRejecting] = useState(false), [reason, setReason] = useState('')
  const { groups } = useDirectory(api)
  useEffect(() => { api.pluginRequestDetail(request.id).then(next => {
    setDetail(next); if (next.digest) setDigest(next.digest); else if (next.request.artifactSha512) setDigest(next.request.artifactSha512)
    if (next.allowedBuilds?.length) setBuilds(next.allowedBuilds.join(', '))
  }, () => setDetail(null)) }, [api, request.id])
  const approve = () => attempt(async proof => {
    await api.approvePlugin(request.id, scope[0] ?? { kind: 'company', target: '*' }, digest.trim(), builds.split(',').map(s => s.trim()).filter(Boolean), proof)
    onDone(t('plgApproved'))
  })
  const reject = (event: FormEvent) => { event.preventDefault(); if (reason.trim()) api.rejectPlugin(request.id, reason.trim()).then(() => onDone(t('plgRejected')), e => setError(errorText(t, e))) }
  return <Modal open onClose={onClose} title={fill(t('plgReviewTitle'), { name: request.name })} closeLabel={t('cancel')} description={fill(t('plgReviewHint'), { digest: (digest || '—').slice(0, 24) })}>
    <div data-team-admin-plg-review data-team-wide="l" style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div style={{ ...hint, marginTop: 0 }}>{[request.submittedByEmail ? fill(t('plgFrom'), { email: request.submittedByEmail }) : undefined, fill(t('plgSubmitted'), { date: date(request.submittedAt) }),
        fill(t('plgVersion'), { version: request.version }), request.note ? fill(t('plgNote'), { note: request.note }) : undefined,
        request.mirrorState ? fill(t('plgMirror'), { state: request.mirrorState }) : undefined].filter(Boolean).join(' · ')}</div>
      <div>
        <div style={{ ...label, fontWeight: 600 }}>{t('plgFilesTitle')}</div>
        <div style={hint}>{t('plgOpenFile')}</div>
        {detail === undefined ? <div style={hint}>{t('loading')}</div> : detail === null ? <div style={hint}>{t('failed')}</div>
          : <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }}>{(detail.files ?? []).map(f => <div key={f.path} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', fontSize: 13 }}>
            <code>{f.path}</code><span style={hint}>{f.bytes} B</span></div>)}</div>}
      </div>
      <label style={field}>{t('plgExpectedDigest')}<Input value={digest} onChange={e => setDigest(e.target.value)} /></label>
      <label style={field}>{t('plgAllowedBuilds')}<Input value={builds} onChange={e => setBuilds(e.target.value)} /></label>
      <PluginScopePicker t={t} value={scope} onChange={setScope} groups={groups} />
      {error !== undefined && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-state-error, #d92d20)' }}>{error}</p>}
      {rejecting ? <form onSubmit={reject} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8, alignItems: 'end' }}>
        <label style={field}>{t('plgRejectReason')}<Input data-modal-autofocus maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button variant="outline" onClick={() => setRejecting(false)}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={!reason.trim()}>{t('plgReject')}</Button>
      </form> : <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="outline" onClick={() => setRejecting(true)} data-team-admin-plg-reject>{t('plgReject')}</Button>
        <Button variant="primary" disabled={scope.length === 0 || !digest.trim()} onClick={approve} data-team-admin-plg-approve>{t('plgApprove')}</Button>
      </div>}
    </div>
  </Modal>
}

function RequestsCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [state, setState] = useState<'pending' | 'all'>('pending'), [requests, setRequests] = useState<readonly AdminPluginRequest[] | null>()
  const [note, setNote] = useState<{ ok: boolean; text: string }>(), [review, setReview] = useState<AdminPluginRequest>()
  const load = useCallback(() => { api.pluginRequests(state).then(setRequests, () => setRequests(null)) }, [api, state])
  useEffect(load, [load])
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <SegmentedControl id="team-admin-plg-requests" label={t('plgTabRequests')} value={state} onChange={setState}
        options={[{ value: 'pending', label: t('plgPending') }, { value: 'all', label: t('plgAllRequests') }]} />
    </div>
    <Note note={note} />
    <Card testId="plg-requests">
      {requests === undefined ? <Row title={t('loading')} end /> : requests === null ? <Row title={t('failed')} end />
        : requests.length === 0 ? <Row title={<span style={hint}>{state === 'pending' ? t('plgNoRequests') : t('plgNoHistory')}</span>} end />
          : requests.map((request, index) => <Row key={request.id} end={index === requests.length - 1}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><code>{request.name}</code>
              {state === 'all' && <Tag tone={request.state === 'approved' ? 'success' : request.state === 'pending' ? 'info' : request.state === 'rejected' ? 'danger' : 'neutral'}>{t(`plgReqState_${request.state}`)}</Tag>}</span>}
            detail={[request.submittedByEmail ? fill(t('plgFrom'), { email: request.submittedByEmail }) : undefined, fill(t('plgSubmitted'), { date: date(request.submittedAt) }),
              fill(t('plgVersion'), { version: request.version }), request.mirrorState ? fill(t('plgMirror'), { state: request.mirrorState }) : undefined,
              request.note ? fill(t('plgNote'), { note: request.note }) : request.reason ?? undefined].filter(Boolean).join(' · ')}>
            {request.state === 'pending' && <Button variant="primary" size="sm" onClick={() => setReview(request)} data-team-admin-plg-review-open>{t('plgReview')}</Button>}
          </Row>)}
    </Card>
    {review !== undefined && <Review api={api} t={t} request={review} attempt={attempt} onClose={() => setReview(undefined)} onDone={text => { setReview(undefined); setNote({ ok: true, text }); load() }} />}
  </>
}

function Manage({ api, t, plugin, attempt, onClose, onDone }: { api: AdminApi; t: T; plugin: AdminPlugin; attempt: Attempt; onClose: () => void; onDone: (text: string) => void }) {
  const [scope, setScope] = useState<PluginScopeEntry[]>(plugin.scopes.slice()), [confirm, setConfirm] = useState<'delist' | 'rollback'>()
  const [reason, setReason] = useState(''), [versionId, setVersionId] = useState(plugin.currentVersionId ?? '')
  const { groups } = useDirectory(api)
  return <Modal open onClose={onClose} title={plugin.name} closeLabel={t('cancel')}>
    <div data-team-admin-plg-manage data-team-wide="m" style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <PluginScopePicker t={t} value={scope} onChange={setScope} groups={groups} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={scope.length === 0} onClick={() => attempt(async proof => { await api.setPluginScope(plugin.packageId, scope, proof); onDone(t('plgDone')) })}>{t('plgSaveScope')}</Button>
      </div>
      <label style={field}>{t('plgRevokeVersion')}<Input value={versionId} onChange={e => setVersionId(e.target.value)} /></label>
      <label style={field}>{t('plgRevokeReason')}<Input value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="outline" disabled={!versionId.trim()} onClick={() => attempt(async proof => { await api.revokePlugin(versionId.trim(), reason.trim() || undefined, proof); onDone(t('plgDone')) })}>{t('plgRevoke')}</Button>
        {plugin.listed
          ? <Button variant="outline" onClick={() => setConfirm('delist')}>{t('plgDelist')}</Button>
          : <Button variant="outline" onClick={() => attempt(async proof => { await api.relistPlugin(plugin.packageId, proof); onDone(t('plgDone')) })}>{t('plgRelist')}</Button>}
        <Button variant="outline" onClick={() => setConfirm('rollback')}>{t('plgRollback')}</Button>
      </div>
      {confirm !== undefined && <div style={{ display: 'grid', gap: 10, paddingTop: 12, borderTop: '0.5px solid var(--dsw-alias-border-l2)' }}>
        <div style={label}>{fill(t(confirm === 'delist' ? 'plgDelistConfirm' : 'plgRollbackConfirm'), { name: plugin.name })}</div>
        {confirm === 'delist' && <label style={field}>{t('plgDelistReason')}<Input value={reason} onChange={e => setReason(e.target.value)} /></label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="outline" onClick={() => setConfirm(undefined)}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => attempt(async proof => {
            if (confirm === 'delist') await api.delistPlugin(plugin.packageId, reason.trim() || undefined, proof)
            else await api.rollbackPlugin(plugin.packageId, proof)
            onDone(t('plgDone'))
          })}>{t(confirm === 'delist' ? 'plgDelist' : 'plgRollback')}</Button>
        </div>
      </div>}
    </div>
  </Modal>
}

function ListedCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [plugins, setPlugins] = useState<readonly AdminPlugin[] | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>(), [manage, setManage] = useState<AdminPlugin>()
  const load = useCallback(() => { api.pluginInventory().then(page => setPlugins(page.plugins), () => setPlugins(null)) }, [api])
  useEffect(load, [load])
  return <>
    <Note note={note} />
    <Card testId="plg-listed">
      {plugins === undefined ? <Row title={t('loading')} end /> : plugins === null ? <Row title={t('failed')} end />
        : plugins.length === 0 ? <Row title={<span style={hint}>{t('plgEmpty')}</span>} end />
          : plugins.map((plugin, index) => <Row key={plugin.packageId} end={index === plugins.length - 1}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><code>{plugin.name}</code>
              <Tag tone={plugin.listed ? 'success' : 'neutral'}>{plugin.listed ? t('plgListed') : t('plgDelisted')}</Tag></span>}
            detail={[plugin.currentVersion ? fill(t('plgCurrent'), { version: plugin.currentVersion }) : undefined,
              plugin.previousVersion ? fill(t('plgPrevious'), { version: plugin.previousVersion }) : t('plgNoPrevious'),
              plugin.applyCount !== undefined ? fill(t('plgApplies'), { n: plugin.applyCount }) : undefined].filter(Boolean).join(' · ')}>
            <Button variant="outline" size="sm" onClick={() => setManage(plugin)} data-team-admin-plg-manage-open>{t('plgManage')}</Button>
          </Row>)}
    </Card>
    {manage !== undefined && <Manage api={api} t={t} plugin={manage} attempt={attempt} onClose={() => setManage(undefined)} onDone={text => { setManage(undefined); setNote({ ok: true, text }); load() }} />}
  </>
}

function UploadCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [name, setName] = useState(''), [version, setVersion] = useState(''), [sourceType, setSourceType] = useState<'npm' | 'git' | 'upload'>('npm')
  const [registry, setRegistry] = useState(''), [gitUrl, setGitUrl] = useState(''), [commit, setCommit] = useState(''), [gitPath, setGitPath] = useState('')
  const [scope, setScope] = useState<PluginScopeEntry[]>([{ kind: 'company', target: '*' }]), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const { groups } = useDirectory(api)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !version.trim() || scope.length === 0) return
    const source: PluginUploadBody['source'] = sourceType === 'npm'
      ? { type: 'npm', registry: registry.trim(), name: name.trim(), version: version.trim() }
      : sourceType === 'git'
        ? { type: 'git', url: gitUrl.trim(), commit: commit.trim(), name: name.trim(), version: version.trim(), ...gitPath.trim() ? { path: gitPath.trim() } : {} }
        : { type: 'upload', name: name.trim(), version: version.trim() }
    attempt(async proof => {
      await api.uploadPlugin({ name: name.trim(), version: version.trim(), source, scope: scope[0]! }, proof)
      setNote({ ok: true, text: t('plgDone') }); setName(''); setVersion('')
    })
  }
  return <Card testId="plg-upload">
    <form style={{ padding: '14px 0' }} onSubmit={submit}>
      <div style={label}>{t('plgUploadTitle')}</div><div style={hint}>{t('plgUploadHint')}</div>
      <Note note={note} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 12, marginTop: 12 }}>
        <label style={field}>{t('plgName')}<Input value={name} onChange={e => setName(e.target.value)} /></label>
        <label style={field}>{t('plgVer')}<Input value={version} onChange={e => setVersion(e.target.value)} /></label>
      </div>
      <div style={{ marginTop: 12 }}>
        <SegmentedControl id="team-admin-plg-source" label={t('plgSourceType')} value={sourceType} onChange={setSourceType}
          options={[{ value: 'npm', label: t('plgSource_npm') }, { value: 'git', label: t('plgSource_git') }, { value: 'upload', label: t('plgSource_upload') }]} />
      </div>
      {sourceType === 'npm' && <label style={{ ...field, marginTop: 12 }}>{t('plgRegistry')}<Input value={registry} onChange={e => setRegistry(e.target.value)} /></label>}
      {sourceType === 'git' && <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <label style={field}>{t('plgGitUrl')}<Input value={gitUrl} onChange={e => setGitUrl(e.target.value)} /></label>
        <label style={field}>{t('plgGitCommit')}<Input value={commit} onChange={e => setCommit(e.target.value)} /></label>
        <label style={field}>{t('plgGitPath')}<Input value={gitPath} onChange={e => setGitPath(e.target.value)} /></label>
      </div>}
      <div style={{ marginTop: 14 }}><PluginScopePicker t={t} value={scope} onChange={setScope} groups={groups} /></div>
      <div style={{ marginTop: 12 }}><Button type="submit" variant="primary" data-team-admin-plg-upload>{t('plgUpload')}</Button></div>
    </form>
  </Card>
}

function DefaultsCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [plugins, setPlugins] = useState<readonly AdminPlugin[] | null>(), [packageId, setPackageId] = useState(''), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const [scope, setScope] = useState<PluginScopeEntry[]>([{ kind: 'company', target: '*' }])
  const { groups } = useDirectory(api)
  const load = useCallback(() => { api.pluginInventory().then(page => setPlugins(page.plugins), () => setPlugins(null)) }, [api])
  useEffect(load, [load])
  const defaults = (plugins ?? []).flatMap(plugin => (plugin.defaults ?? []).map(row => ({ ...row, packageId: plugin.packageId, name: plugin.name })))
  const act = (enabled: boolean) => {
    if (!packageId.trim() || scope.length === 0) return
    attempt(async proof => {
      await api.setPluginDefaults({ packageId: packageId.trim(), scope: scope[0]!, enabled }, proof)
      setNote({ ok: true, text: t('plgDone') }); load()
    })
  }
  return <Card testId="plg-defaults">
    <div style={{ padding: '14px 0' }}>
      <div style={label}>{t('plgDefaultsTitle')}</div><div style={hint}>{t('plgDefaultsHint')}</div>
      <Note note={note} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto auto', gap: 8, alignItems: 'end', marginTop: 12 }}>
        <label style={field}>{t('plgDefaultPackage')}<Input value={packageId} onChange={e => setPackageId(e.target.value)} /></label>
        <Button variant="primary" onClick={() => act(true)}>{t('plgDefaultEnable')}</Button>
        <Button variant="outline" onClick={() => act(false)}>{t('plgDefaultClear')}</Button>
        <Button variant="outline" onClick={() => {
          if (!packageId.trim() || scope.length === 0) return
          attempt(async proof => { await api.resetPluginDefaults({ packageId: packageId.trim(), scope: scope[0]! }, proof); setNote({ ok: true, text: t('plgDone') }); load() })
        }}>{t('plgDefaultReset')}</Button>
      </div>
      <div style={{ marginTop: 12 }}><PluginScopePicker t={t} value={scope} onChange={setScope} groups={groups} /></div>
      <div style={{ ...label, padding: '14px 0 0' }}>{t('plgDefaultsTitle')}</div>
      {defaults.length === 0 ? <Row title={<span style={hint}>{t('plgNoDefaults')}</span>} end />
        : defaults.map((row, index) => <Row key={`${row.packageId}:${row.scope.kind}:${row.scope.target}`} end={index === defaults.length - 1}
          title={<code>{row.name ?? row.packageId}</code>} detail={fill(t('plgDefaultScope'), { scope: row.scope.kind === 'company' ? t('plgScopeCompany') : row.scope.target })} />)}
    </div>
  </Card>
}

function PolicyCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [policy, setPolicy] = useState<AdminPluginPolicy | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>()
  useEffect(() => { api.pluginPolicy().then(setPolicy, () => setPolicy(null)) }, [api])
  if (policy === undefined) return <Card><Row title={t('loading')} end /></Card>
  if (policy === null) return <Card><Row title={t('failed')} end /></Card>
  const toggle = (key: keyof AdminPluginPolicy) => setPolicy({ ...policy, [key]: !policy[key] })
  return <Card testId="plg-policy">
    <form style={{ padding: '14px 0' }} onSubmit={event => {
      event.preventDefault()
      attempt(async proof => { setPolicy(await api.setPluginPolicy(policy, proof)); setNote({ ok: true, text: t('plgDone') }) })
    }}>
      <div style={label}>{t('plgPolicyTitle')}</div><div style={hint}>{t('plgPolicyHint')}</div>
      <Note note={note} />
      {(['market_only', 'install_scripts', 'egress_lock'] as const).map(key => <Row key={key} title={t(`plgPolicy_${key}`)}>
        <Checkbox checked={policy[key]} onChange={() => toggle(key)} label={policy[key] ? t('plgPolicyOn') : t('plgPolicyOff')} />
      </Row>)}
      <div style={{ padding: '12px 0' }}><Button type="submit" variant="primary">{t('plgSavePolicy')}</Button></div>
    </form>
  </Card>
}

const LIMIT_NAMES: readonly PluginLimitName[] = ['max_submissions', 'max_submission_bytes']

function LimitsCard({ api, t, attempt }: { api: AdminApi; t: T; attempt: Attempt }) {
  const [limits, setLimits] = useState<AdminPluginLimits | null>(), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const [values, setValues] = useState<Record<PluginLimitName, string>>({ max_submissions: '', max_submission_bytes: '' })
  const [unlimited, setUnlimited] = useState<Record<PluginLimitName, boolean>>({ max_submissions: true, max_submission_bytes: true })
  const [target, setTarget] = useState(''), [name, setName] = useState<PluginLimitName>('max_submissions'), [value, setValue] = useState(''), [none, setNone] = useState(false)
  const [effectiveUser, setEffectiveUser] = useState('')
  const { groups, users } = useDirectory(api)
  const apply = useCallback((next: AdminPluginLimits) => {
    setLimits(next)
    setValues(Object.fromEntries(LIMIT_NAMES.map(n => [n, next.global[n] == null ? '' : String(next.global[n])])) as Record<PluginLimitName, string>)
    setUnlimited(Object.fromEntries(LIMIT_NAMES.map(n => [n, next.global[n] == null])) as Record<PluginLimitName, boolean>)
  }, [])
  useEffect(() => { api.pluginLimits().then(apply, () => setLimits(null)) }, [api, apply])
  if (limits === undefined) return <Card><Row title={t('loading')} end /></Card>
  if (limits === null) return <Card><Row title={t('failed')} end /></Card>
  const parse = (text: string) => /^[1-9][0-9]{0,14}$/.test(text) ? Number(text) : undefined
  const saveGlobal = (event: FormEvent) => {
    event.preventDefault()
    const changes: Array<[PluginLimitName, number | null]> = []
    for (const n of LIMIT_NAMES) {
      const next = unlimited[n] ? null : parse(values[n])
      if (next === undefined && !unlimited[n]) { setNote({ ok: false, text: t('plgLimitInvalid') }); return }
      if (next !== (limits.global[n] ?? null)) changes.push([n, next ?? null])
    }
    attempt(async proof => { let last = limits; for (const [n, v] of changes) last = await api.setPluginLimit({ type: 'global', id: '*' }, n, v, proof); apply(last); setNote({ ok: true, text: t('plgDone') }) })
  }
  const addOverride = (event: FormEvent) => {
    event.preventDefault()
    const [type, id] = target.split('|') as ['group' | 'user', string]
    const next = none ? null : parse(value)
    if (!target || (next === undefined && !none)) { setNote({ ok: false, text: t('plgLimitInvalid') }); return }
    attempt(async proof => { apply(await api.setPluginLimit({ type, id }, name, next ?? null, proof)); setValue(''); setNone(false); setNote({ ok: true, text: t('plgDone') }) })
  }
  const remove = (scope: PluginLimitScope, n: PluginLimitName) => attempt(async proof => { apply(await api.deletePluginLimit(scope, n, proof)); setNote({ ok: true, text: t('plgDone') }) })
  const targets = [...groups.map(g => ({ value: `group|${g.id}`, label: `${groupName(g)} (${g.source})` })), ...users.map(u => ({ value: `user|${u.id}`, label: u.email }))]
  const shown = (n: PluginLimitName, v: number | null | undefined) => v === undefined ? '—' : v === null ? t('plgUnlimited') : v.toLocaleString()
  return <Card testId="plg-limits">
    <Note note={note} />
    <form style={{ padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} onSubmit={saveGlobal}>
      <div style={label}>{t('plgLimitsTitle')}</div><div style={hint}>{t('plgLimitsHint')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 10 }}>
        {LIMIT_NAMES.map(n => <div key={n} style={field}>{t(`plgLimit_${n}`)}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Input style={{ width: 140 }} inputMode="numeric" disabled={unlimited[n]} value={unlimited[n] ? '' : values[n]} onChange={e => setValues({ ...values, [n]: e.target.value.replace(/\D/g, '') })} />
            <Checkbox checked={unlimited[n]} onChange={v => setUnlimited({ ...unlimited, [n]: v })} label={t('plgUnlimited')} />
          </div>
        </div>)}
      </div>
      <div style={{ marginTop: 12 }}><Button type="submit" variant="primary">{t('save')}</Button></div>
    </form>
    <form style={{ padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} onSubmit={addOverride}>
      <div style={label}>{t('plgAddLimitOverride')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ ...field, flex: '2 1 260px' }}>{t('plgOverrideFor')}<select style={select} value={target} onChange={e => setTarget(e.target.value)}><option value="">—</option>{targets.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <label style={{ ...field, flex: '1 1 220px' }}>{t('plgLimitName')}<select style={select} value={name} onChange={e => setName(e.target.value as PluginLimitName)}>{LIMIT_NAMES.map(n => <option key={n} value={n}>{t(`plgLimit_${n}`)}</option>)}</select></label>
        <label style={{ ...field, flex: '1 1 220px' }}>{t('plgLimitValue')}<Input inputMode="numeric" disabled={none} value={none ? '' : value} onChange={e => setValue(e.target.value.replace(/\D/g, ''))} /></label>
        <Checkbox checked={none} onChange={setNone} label={t('plgUnlimited')} />
        <Button type="submit" variant="primary">{t('save')}</Button>
      </div>
    </form>
    <div style={{ ...label, padding: '14px 0 0' }}>{t('plgOverrides')}</div>
    {(limits.overrides ?? []).length === 0 ? <Row title={<span style={hint}>{t('plgNoLimitOverrides')}</span>} />
      : limits.overrides.map(o => <Row key={`${o.scope.type}:${o.scope.id}`} title={o.scope.type === 'user' ? o.scope.email ?? o.scope.id : o.scope.id}
        detail={LIMIT_NAMES.map(n => `${t(`plgLimit_${n}`)}: ${shown(n, o.values[n])}`).join(' · ')}>
        <span style={{ display: 'inline-flex', gap: 6 }}>{LIMIT_NAMES.filter(n => o.values[n] !== undefined).map(n =>
          <Button key={n} variant="outline" size="sm" onClick={() => remove({ type: o.scope.type, id: o.scope.id }, n)}>{`${t('remove')} · ${t(`plgLimit_${n}`)}`}</Button>)}</span>
      </Row>)}
    <div style={{ padding: '14px 0', display: 'grid', gap: 8 }}>
      <div style={label}>{t('plgEffective')}</div>
      <label style={{ ...field, maxWidth: 360 }}>{t('user')}<select style={select} value={effectiveUser} onChange={e => {
        setEffectiveUser(e.target.value)
        if (e.target.value) api.pluginEffective(e.target.value).then(() => undefined, () => undefined)
      }}><option value="">—</option>{users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
    </div>
  </Card>
}

/** The Plugin market administration section. */
export function PluginMarket({ api, t }: { api: AdminApi; t: T }) {
  const [tab, setTab] = useState<Tab>('requests'), [note, setNote] = useState<{ ok: boolean; text: string }>()
  const fail = useCallback((error: unknown) => setNote({ ok: false, text: errorText(t, error) }), [t])
  const { attempt, dialog } = useReauth(t, fail)
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <SegmentedControl id="team-admin-plg-tabs" label={t('plugins')} value={tab} onChange={setTab}
        options={[{ value: 'requests', label: t('plgTabRequests') }, { value: 'listed', label: t('plgTabListed') }, { value: 'upload', label: t('plgTabUpload') },
          { value: 'defaults', label: t('plgTabDefaults') }, { value: 'policy', label: t('plgTabPolicy') }, { value: 'limits', label: t('plgTabLimits') }]} />
    </div>
    <Note note={note} />
    {tab === 'requests' && <RequestsCard api={api} t={t} attempt={attempt} />}
    {tab === 'listed' && <ListedCard api={api} t={t} attempt={attempt} />}
    {tab === 'upload' && <UploadCard api={api} t={t} attempt={attempt} />}
    {tab === 'defaults' && <DefaultsCard api={api} t={t} attempt={attempt} />}
    {tab === 'policy' && <PolicyCard api={api} t={t} attempt={attempt} />}
    {tab === 'limits' && <LimitsCard api={api} t={t} attempt={attempt} />}
    {dialog}
  </>
}
