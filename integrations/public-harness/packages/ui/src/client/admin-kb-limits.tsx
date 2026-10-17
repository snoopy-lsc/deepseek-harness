/** System Admin, Quota, Knowledge base limits: the global values (each with "Unlimited", sizes in MB), group and user overrides with a
 * picker for new rows, and the effective limits of one user with their source and usage. Built like the over-limit editor above it:
 * the same fields, save button and re-authentication dialog. Hidden when the knowledge base service is not running. */
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AdminApiError, type AdminApi, type AdminGroup, type AdminKbEffective, type AdminKbLimits, type AdminUser, type KbLimitName, type KbLimitScope, type Proof } from './admin-api.ts'
import { groupName } from './admin-groups.tsx'
import { kbSize, useDirectory } from './admin-kb.tsx'
import { KB_LIMIT_NAMES, limitText, parseLimit } from './admin-kb-units.ts'
import { Card, field, fill, hint, label, Row, select, type T } from './admin-kit.tsx'

const MB = 1024 * 1024
const rangeText = (name: KbLimitName, range: readonly [number, number]) => name === 'max_bytes' ? { min: range[0] / MB, max: range[1] / MB } : { min: range[0], max: range[1] }

function LimitField({ t, name, value, unlimited, onValue, onUnlimited }: { t: T; name: KbLimitName; value: string; unlimited: boolean; onValue: (v: string) => void; onUnlimited: (v: boolean) => void }) {
  // A div, not a label: the checkbox carries its own label, and labels must not nest.
  return <div style={field}>{t(`kbLimit_${name}`)}
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Input style={{ width: 140 }} inputMode="numeric" aria-label={t(`kbLimit_${name}`)} disabled={unlimited} value={unlimited ? '' : value} onChange={e => onValue(e.target.value.replace(/\D/g, ''))} />
      <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}><Checkbox checked={unlimited} onChange={onUnlimited} label={t('kbUnlimited')} /></span>
    </div>
  </div>
}

/** The card. `attempt` and `note` are the quota section's re-authentication and status line. */
export function KbLimitsCard({ api, t, attempt, note }: { api: AdminApi; t: T; attempt: (run: (proof: Proof) => Promise<void>) => void; note: (ok: boolean, text: string) => void }) {
  const [limits, setLimits] = useState<AdminKbLimits | null>()
  const [values, setValues] = useState<Record<KbLimitName, string>>({ max_kbs: '', max_bytes: '', max_pages: '' }), [unlimited, setUnlimited] = useState<Record<KbLimitName, boolean>>({ max_kbs: false, max_bytes: false, max_pages: false })
  const [target, setTarget] = useState(''), [name, setName] = useState<KbLimitName>('max_kbs'), [value, setValue] = useState(''), [none, setNone] = useState(false)
  const [effectiveUser, setEffectiveUser] = useState(''), [effective, setEffective] = useState<AdminKbEffective | null>()
  const { groups, users } = useDirectory(api)
  const apply = useCallback((next: AdminKbLimits) => {
    setLimits(next)
    setValues(Object.fromEntries(KB_LIMIT_NAMES.map(n => [n, limitText(n, next.global[n])])) as Record<KbLimitName, string>)
    setUnlimited(Object.fromEntries(KB_LIMIT_NAMES.map(n => [n, next.global[n] === null])) as Record<KbLimitName, boolean>)
  }, [])
  useEffect(() => { api.kbLimits().then(apply, error => setLimits(error instanceof AdminApiError && (error.status === 404 || error.status === 503) ? null : null)) }, [api, apply])
  useEffect(() => { if (effectiveUser) api.kbEffective(effectiveUser).then(setEffective, () => setEffective(null)); else setEffective(undefined) }, [api, effectiveUser, limits])
  if (limits === undefined || limits === null) return null
  const scopeName = (scope: { type: 'group' | 'user'; id: string; email?: string | null }) => scope.type === 'user' ? scope.email ?? users.find(u => u.id === scope.id)?.email ?? scope.id
    : (g => g ? groupName(g) : scope.id)(groups.find(g => g.id === scope.id))
  const shown = (n: KbLimitName, v: number | null | undefined) => v === undefined ? t('kbInherit') : v === null ? t('kbUnlimited') : n === 'max_bytes' ? kbSize(v) : v.toLocaleString()
  const saveGlobal = (event: FormEvent) => {
    event.preventDefault()
    const changes: Array<[KbLimitName, number | null]> = []
    for (const n of KB_LIMIT_NAMES) {
      const next = unlimited[n] ? null : parseLimit(n, values[n], limits.ranges[n])
      if (next === undefined) { note(false, fill(t('kbLimitInvalid'), rangeText(n, limits.ranges[n]))); return }
      if (next !== limits.global[n]) changes.push([n, next])
    }
    if (changes.length === 0) { note(true, t('done')); return }
    attempt(async proof => { let last = limits; for (const [n, v] of changes) last = await api.setKbLimit({ type: 'global', id: '*' }, n, v, proof); apply(last); note(true, t('done')) })
  }
  const addOverride = (event: FormEvent) => {
    event.preventDefault()
    const [type, id] = target.split('|') as ['group' | 'user', string]
    const next = none ? null : parseLimit(name, value, limits.ranges[name])
    if (!target || next === undefined) { note(false, fill(t('kbLimitInvalid'), rangeText(name, limits.ranges[name]))); return }
    attempt(async proof => { apply(await api.setKbLimit({ type, id }, name, next, proof)); setValue(''); setNone(false); note(true, t('done')) })
  }
  const remove = (scope: KbLimitScope, n: KbLimitName) => attempt(async proof => { apply(await api.deleteKbLimit(scope, n, proof)); note(true, t('done')) })
  const targets = [...groups.map((g: AdminGroup) => ({ value: `group|${g.id}`, label: `${groupName(g)} (${g.source})` })), ...users.map((u: AdminUser) => ({ value: `user|${u.id}`, label: u.email }))]
  return <Card testId="quota-kb-limits">
    <form style={{ padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} onSubmit={saveGlobal}>
      <div style={label}>{t('kbLimits')}</div><div style={hint}>{t('kbLimitsHint')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 10 }}>
        {KB_LIMIT_NAMES.map(n => <LimitField key={n} t={t} name={n} value={values[n]} unlimited={unlimited[n]} onValue={v => setValues({ ...values, [n]: v })} onUnlimited={v => setUnlimited({ ...unlimited, [n]: v })} />)}
      </div>
      <div style={{ marginTop: 12 }}><Button type="submit" variant="primary">{t('save')}</Button></div>
    </form>
    <form style={{ padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} onSubmit={addOverride}>
      <div style={label}>{t('kbAddLimitOverride')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ ...field, flex: '2 1 260px', minWidth: 0 }}>{t('kbOverrideFor')}<select style={select} value={target} onChange={e => setTarget(e.target.value)}><option value="">—</option>{targets.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <label style={{ ...field, flex: '1 1 220px', minWidth: 0 }}>{t('kbLimitName')}<select style={select} value={name} onChange={e => setName(e.target.value as KbLimitName)}>{KB_LIMIT_NAMES.map(n => <option key={n} value={n}>{t(`kbLimit_${n}`)}</option>)}</select></label>
        <label style={{ ...field, flex: '1 1 220px', minWidth: 0 }}>{t('kbLimitValue')}<Input inputMode="numeric" disabled={none} value={none ? '' : value} onChange={e => setValue(e.target.value.replace(/\D/g, ''))} /></label>
        <span style={{ whiteSpace: 'nowrap', paddingBottom: 8 }}><Checkbox checked={none} onChange={setNone} label={t('kbUnlimited')} /></span>
        <Button type="submit" variant="primary">{t('save')}</Button>
      </div>
    </form>
    <div style={{ ...label, padding: '14px 0 0' }}>{t('kbOverrides')}</div>
    {limits.overrides.length === 0 ? <Row title={<span style={hint}>{t('kbNoLimitOverrides')}</span>} />
      : limits.overrides.map(o => <Row key={`${o.scope.type}:${o.scope.id}`} title={scopeName(o.scope)} detail={KB_LIMIT_NAMES.map(n => `${t(`kbLimit_${n}`)}: ${shown(n, o.values[n])}`).join(' · ')}>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{KB_LIMIT_NAMES.filter(n => o.values[n] !== undefined).map(n =>
          <Button key={n} variant="outline" size="sm" onClick={() => remove({ type: o.scope.type, id: o.scope.id }, n)}>{`${t('remove')} · ${t(`kbLimit_${n}`)}`}</Button>)}</span>
      </Row>)}
    <div style={{ padding: '14px 0', display: 'grid', gap: 8 }}>
      <div style={label}>{t('kbEffective')}</div>
      <label style={{ ...field, maxWidth: 360 }}>{t('user')}<select style={select} value={effectiveUser} onChange={e => setEffectiveUser(e.target.value)}><option value="">—</option>{users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}</select></label>
      {effective === null ? <div style={hint}>{t('failed')}</div> : effective !== undefined && <div data-team-admin-kb-effective style={{ display: 'grid', gap: 4, fontSize: 13 }}>
        {KB_LIMIT_NAMES.map(n => <div key={n}>{t(`kbLimit_${n}`)}: <strong>{shown(n, effective.limits[n].value)}</strong> <span style={{ ...hint, display: 'inline' }}>{fill(t('kbEffectiveSource'), { source: effective.limits[n].source.startsWith('group:')
          ? (g => g ? groupName(g) : effective.limits[n].source.slice(6))(groups.find(g => g.id === effective.limits[n].source.slice(6))) : t(effective.limits[n].source === 'user' ? 'kbSource_user' : 'kbSource_global') })}</span></div>)}
        <div style={hint}>{fill(t('kbUsage'), { kbs: effective.usage.kbs, size: kbSize(effective.usage.maxBytes), pages: effective.usage.maxPages })}</div>
      </div>}
    </div>
  </Card>
}
