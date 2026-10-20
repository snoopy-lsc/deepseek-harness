/** Shared editable profile fields and own-avatar controls. */
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { AccountApiError, type AccountApi, type AdminProfilePatch, type AvatarUpload, type UserProfile } from './me.ts'
import { AdminApiError, type AdminApi } from './admin-api.ts'
import { avatarSource, prepareAvatar, profilePatch, profileValidation } from './profile.ts'
import type { ProfileCopyKey, ProfileT } from './profile-copy.ts'

const field: CSSProperties = { display: 'grid', gap: 6, minWidth: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
const hint: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16 }
const actions: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
const status = (ok: boolean): CSSProperties => ({ margin: '8px 0', fontSize: 13, lineHeight: '20px', color: ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)' })

function failureKey(error: unknown): ProfileCopyKey {
  const code = error instanceof AccountApiError || error instanceof AdminApiError ? error.code : undefined
  return code === 'profile-managed' ? 'profileManaged' : code === 'bad-name' ? 'profileInvalidName'
    : code === 'bad-phone' ? 'profileInvalidPhone' : code === 'bad-employee-id' ? 'profileInvalidEmployeeId'
      : code === 'bad-department' ? 'profileInvalidDepartment' : code === 'bad-job-title' ? 'profileInvalidJobTitle' : 'profileFailed'
}

/** Current avatar with an initial fallback when absent or unreadable.
 * @param props - Server profile, optional avatar description, and size.
 * @returns The image or initial.
 */
export function ProfileAvatar({ profile, label, size = 48 }: { profile: Pick<UserProfile, 'name' | 'email' | 'avatarUrl'>; label?: string; size?: number }) {
  const url = avatarSource(profile.avatarUrl), [failed, setFailed] = useState<string>()
  const style: CSSProperties = { width: size, height: size, flex: 'none', borderRadius: '50%', objectFit: 'cover' }
  return url !== undefined && failed !== url ? <img src={url} alt={label ?? ''} style={style} onError={() => setFailed(url)} />
    : <span aria-hidden="true" style={{ ...style, display: 'grid', placeItems: 'center', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', fontSize: 20, fontWeight: 500 }}>{(profile.name || profile.email).trim().charAt(0).toUpperCase()}</span>
}

/** Profile editor retaining the draft on a refused save.
 * @param props - Initial profile, editable field policy, save action and localized copy.
 * @returns The editable form.
 */
export function ProfileForm({ initial, admin = false, save, onSaved, t }: { initial: UserProfile; admin?: boolean; save: (patch: AdminProfilePatch) => Promise<UserProfile>; onSaved: (profile: UserProfile) => void; t: ProfileT }) {
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [note, setNote] = useState<{ ok: boolean; key: ProfileCopyKey }>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = (key: 'name' | 'phone' | 'employeeId' | 'department' | 'jobTitle', value: string) => { setDraft(previous => ({ ...previous, [key]: value })); setNote(undefined) }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const invalid = profileValidation(draft, admin)
    if (invalid !== undefined) { setNote({ ok: false, key: invalid }); return }
    setBusy(true); setNote(undefined)
    save(profilePatch(draft, admin)).then(profile => {
      if (mounted.current) { setDraft(profile); setNote({ ok: true, key: 'profileSaved' }); onSaved(profile) }
    }, error => { if (mounted.current) setNote({ ok: false, key: failureKey(error) }) }).finally(() => { if (mounted.current) setBusy(false) })
  }
  return <form onSubmit={submit} data-team-profile-form={admin ? 'admin' : 'own'} style={{ display: 'grid', gap: 16, padding: '16px 0' }} aria-busy={busy}>
    <div style={grid}>
      <label style={field}>{t('profileName')}<Input name="profile-name" autoComplete="name" value={draft.name} disabled={busy || draft.managedBy === 'sso'} maxLength={100} required={draft.managedBy === 'local'} onChange={event => update('name', event.target.value)} />
        {draft.managedBy === 'sso' && <span style={hint}>{t('profileSsoHint')}</span>}</label>
      <label style={field}>{t('profileEmail')}<Input name="profile-email" type="email" autoComplete="email" value={draft.email} readOnly /><span style={hint}>{t('profileEmailHint')}</span></label>
      <label style={field}>{t('profilePhone')}<Input name="profile-phone" type="tel" autoComplete="tel" value={draft.phone} disabled={busy} maxLength={40} onChange={event => update('phone', event.target.value)} /><span style={hint}>{t('profilePhoneHint')}</span></label>
    </div>
    <div style={{ borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 16, display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{t('profileOrganization')}</div>
      {!admin && <p style={hint}>{t('profileOrganizationHint')}</p>}
      <div style={grid}>
        {(['employeeId', 'department', 'jobTitle'] as const).map(key => <label key={key} style={field}>{t(({ employeeId: 'profileEmployeeId', department: 'profileDepartment', jobTitle: 'profileJobTitle' } as const)[key])}
          <Input name={`profile-${key}`} value={draft[key]} readOnly={!admin} disabled={busy} maxLength={key === 'employeeId' ? 64 : 100} placeholder={admin ? undefined : t('profileNotSet')} onChange={event => update(key, event.target.value)} /></label>)}
      </div>
    </div>
    <div style={{ minHeight: 20 }} aria-live="polite">{note !== undefined && <p role={note.ok ? 'status' : 'alert'} style={status(note.ok)}>{t(note.key)}</p>}</div>
    <div style={actions}><Button type="submit" variant="primary" disabled={busy}>{t(busy ? 'profileSaving' : 'profileSave')}</Button></div>
  </form>
}

/** Avatar selection and upload; failed requests retain the prepared image for retry.
 * @param props - Current profile, own account API and localized feedback.
 * @returns Image controls and preview.
 */
export function AvatarEditor({ profile, api, onSaved, t }: { profile: UserProfile; api: AccountApi; onSaved: (profile: UserProfile) => void; t: ProfileT }) {
  const [pending, setPending] = useState<{ upload: AvatarUpload; preview: string }>(), [busy, setBusy] = useState<'prepare' | 'save'>(), [note, setNote] = useState<{ ok: boolean; key: ProfileCopyKey }>()
  const input = useRef<HTMLInputElement>(null), generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const choose = (file: File) => {
    const current = ++generation.current
    setBusy('prepare'); setNote(undefined)
    prepareAvatar(file).then(prepared => { if (generation.current === current) setPending(prepared) }, () => { if (generation.current === current) setNote({ ok: false, key: 'profileAvatarBad' }) })
      .finally(() => { if (generation.current === current) setBusy(undefined) })
  }
  const save = (image: AvatarUpload) => {
    if (busy !== undefined) return
    const current = ++generation.current
    setBusy('save'); setNote(undefined)
    api.avatar(image).then(next => { if (generation.current === current) { onSaved(next); setPending(undefined); setNote({ ok: true, key: 'profileAvatarSaved' }) } },
      error => { if (generation.current === current) setNote({ ok: false, key: error instanceof AccountApiError && ['bad-avatar', 'avatar', 'body-too-large'].includes(error.code) ? 'profileAvatarBad' : 'profileAvatarFailed' }) })
      .finally(() => { if (generation.current === current) setBusy(undefined) })
  }
  return <div data-team-avatar-editor style={{ display: 'grid', gap: 12, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }} aria-busy={busy !== undefined}>
    <div style={{ ...actions, gap: 16 }}>
      {pending === undefined ? <ProfileAvatar profile={profile} label={t('profileAvatar')} size={64} /> : <img src={pending.preview} alt={t('profileAvatarPreview')} style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />}
      <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: 14, marginBottom: 4 }}>{t('profileAvatar')}</div><p style={hint}>{t('profileAvatarHint')}</p></div>
    </div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('profileChooseAvatar')} style={{ display: 'none' }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) choose(file) }} />
    <div style={actions}>
      <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => input.current?.click()}>{t('profileChooseAvatar')}</Button>
      {pending !== undefined && <><Button variant="primary" size="sm" disabled={busy !== undefined} onClick={() => save(pending.upload)}>{t(busy === 'save' ? 'profileSaving' : 'profileUploadAvatar')}</Button>
        <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { setPending(undefined); setNote(undefined) }}>{t('profileDiscardAvatar')}</Button></>}
      {profile.avatarUrl !== null && <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => save({ data: null })}>{t('profileRemoveAvatar')}</Button>}
    </div>
    <div style={{ minHeight: 20 }} aria-live="polite">{busy === 'prepare' && <span role="status" style={hint}>{t('profileAvatarBusy')}</span>}{note !== undefined && <p role={note.ok ? 'status' : 'alert'} style={status(note.ok)}>{t(note.key)}</p>}</div>
  </div>
}

/** Administrator profile dialog with cancellable loading and isolated drafts per user.
 * @param props - Target user, administrator API and refresh callback.
 * @returns The shared modal.
 */
export function AdminProfileDialog({ userId, api, onClose, onSaved, t }: { userId: string; api: AdminApi; onClose: () => void; onSaved: (profile: UserProfile) => void; t: ProfileT }) {
  const [profile, setProfile] = useState<UserProfile | null>(), [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    api.profile(userId).then(value => { if (live) setProfile(value) }, () => { if (live) setProfile(null) })
    return () => { live = false }
  }, [api, userId, version])
  return <Modal open title={t('profileEdit')} onClose={onClose} closeLabel={t('profileCancel')}>
    <div data-team-admin-profile data-team-wide="m" style={{ minWidth: 0 }}>
    {profile === undefined ? <div style={{ display: 'grid', placeItems: 'center', minHeight: 100 }}><StateDot state="ongoing" size={20} /></div> : profile === null
      ? <div><p role="alert" style={status(false)}>{t('profileLoadFailed')}</p><Button variant="outline" onClick={() => { setProfile(undefined); setVersion(value => value + 1) }}>{t('profileRetry')}</Button></div>
      : <><div style={actions}><ProfileAvatar profile={profile} /><span style={{ ...hint, overflowWrap: 'anywhere' }}>{profile.email}</span></div>
        <ProfileForm key={userId} initial={profile} admin t={t} save={patch => api.updateProfile(userId, patch)} onSaved={next => { setProfile(next); onSaved(next) }} /></>}
    </div>
  </Modal>
}
