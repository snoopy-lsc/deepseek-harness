/** Shared building blocks of the System Admin pages: card and row geometry, notes, errors and the re-authentication dialog.
 * Colours come from the theme tokens only; cards use the frosted-glass menu backdrop. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { AdminApiError, type Proof } from './admin-api.ts'

export type T = PropsLocale<'publicHarnessAdmin'>['t']
export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
export const date = (value: number | string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
export const errorText = (t: T, error: unknown) => {
  if (error instanceof AdminApiError) {
    const key = `err_${error.code.replace(/-/g, '_')}`
    const known = ['err_last_admin', 'err_config_admin', 'err_emergency_admin', 'err_self', 'err_rate_limited']
    if (known.includes(key)) return t(key as 'err_self')
  }
  return t('failed')
}

export const page: CSSProperties = { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '40px 56px 64px', color: 'var(--dsw-alias-label-primary)' }
export const column: CSSProperties = { maxWidth: 880, margin: '0 auto', display: 'grid', gap: 20 }
export const card: CSSProperties = { background: 'var(--dsw-alias-settings-card-fill)', borderRadius: 'var(--dsw-radius-lg)', padding: '0 20px',
  boxShadow: 'var(--dsw-elevation-soft)', WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter)', backdropFilter: 'var(--dsw-menu-backdrop-filter)' }
export const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }
export const label: CSSProperties = { fontSize: 14, lineHeight: '20px' }
export const hint: CSSProperties = { marginTop: 2, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }
export const field: CSSProperties = { display: 'grid', gap: 6, minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
export const statusStyle = (ok: boolean): CSSProperties => ({ margin: '8px 0', fontSize: 13, color: ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error, #d92d20)' })
export const select: CSSProperties = { height: 36, borderRadius: 'var(--dsw-radius-md)', border: '0.5px solid var(--dsw-alias-border-l2)', padding: '0 10px', background: 'transparent',
  color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13 }

export function Row({ title, detail, children, end }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; end?: boolean }) {
  return <div style={end ? { ...rowStyle, borderBottom: 'none' } : rowStyle}>
    <div style={{ minWidth: 0 }}><div style={label}>{title}</div>{detail !== undefined && <div style={hint}>{detail}</div>}</div>
    {children !== undefined && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>{children}</div>}
  </div>
}
export function Card({ children, testId }: { children: ReactNode; testId?: string }) { return <div style={card} data-team-admin-card={testId}>{children}</div> }
export function Note({ note }: { note?: { ok: boolean; text: string } | undefined }) {
  return note === undefined ? null : <p role={note.ok ? 'status' : 'alert'} style={statusStyle(note.ok)} data-team-admin-note>{note.text}</p>
}

/* Re-authentication: run an action; when the server asks for proof, collect it and retry once more. */
export type Pending = { run: (proof: Proof) => Promise<void>; method: 'password' | 'sso'; wrong?: boolean }
export function useReauth(t: T, onError: (error: unknown) => void) {
  const [pending, setPending] = useState<Pending>()
  const attempt = useCallback((run: (proof: Proof) => Promise<void>, proof: Proof = {}) => {
    run(proof).then(() => setPending(undefined), (error: unknown) => {
      if (error instanceof AdminApiError && (error.code === 'reauth-required' || error.code === 'reauth') && error.method !== undefined) {
        setPending({ run, method: error.method, wrong: error.code === 'reauth' })
      } else { setPending(undefined); onError(error) }
    })
  }, [onError])
  const dialog = pending === undefined ? null : <ReauthDialog t={t} pending={pending} onCancel={() => setPending(undefined)} onPassword={password => attempt(pending.run, { password })} />
  return { attempt, dialog }
}
export function ReauthDialog({ t, pending, onCancel, onPassword }: { t: T; pending: Pending; onCancel: () => void; onPassword: (password: string) => void }) {
  const [password, setPassword] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); if (password) onPassword(password) }
  // Back to this very page (path, query and fragment) after the sign-in; the server re-checks it against the user's own route.
  const ret = `${globalThis.location?.pathname ?? '/'}${globalThis.location?.search ?? ''}${globalThis.location?.hash ?? ''}`
  return <Modal open onClose={onCancel} title={t('reauthTitle')} closeLabel={t('cancel')} description={pending.method === 'password' ? t('reauthPassword') : t('reauthSso')}>
    {pending.method === 'password'
      ? <form onSubmit={submit} data-team-admin-reauth="password" style={{ display: 'grid', gap: 12 }}>
        <label style={field}>{t('password')}<Input data-modal-autofocus type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        {pending.wrong && <p role="alert" style={statusStyle(false)}>{t('reauthWrong')}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={onCancel}>{t('cancel')}</Button><Button type="submit" variant="primary">{t('confirm')}</Button></div>
      </form>
      : <div data-team-admin-reauth="sso" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" onClick={() => { globalThis.location.assign(`/api/auth/sso/start?return=${encodeURIComponent(ret)}`) }}>{t('signInAgain')}</Button>
      </div>}
  </Modal>
}
