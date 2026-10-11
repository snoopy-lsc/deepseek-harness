/** Strict Harness cookie rewriting for one authenticated browser owner. */
import { createHash } from 'node:crypto'
import type { UserId } from '@public-harness/contracts'

/** Re-scope exactly one expected Harness cookie without changing its signed value. */
export function scopeHarnessCookie(raw: string, userId: UserId, publicAuthority: string, secure: boolean): string {
  if (/[\r\n]/.test(raw) || !/^[A-Za-z0-9.:-]+$/.test(publicAuthority)) throw new Error('invalid browser cookie authority')
  const authority = new URL(`http://${publicAuthority}`).host
  if (authority !== publicAuthority) throw new Error('noncanonical browser cookie authority')
  const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  const parts = raw.split('; ')
  if (parts.length !== 6 || !parts[0]?.startsWith(`${name}=`) || parts[2] !== 'Path=/'
    || parts[4] !== 'HttpOnly' || parts[5] !== 'SameSite=Strict') throw new Error('unexpected Harness cookie attributes')
  const value = parts[0].slice(name.length + 1)
  if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid Harness cookie value')
  const age = /^Max-Age=([1-9][0-9]*)$/.exec(parts[1] ?? '')
  if (age === null || !Number.isSafeInteger(Number(age[1]))) throw new Error('invalid Harness cookie lifetime')
  const expiry = /^Expires=(.+)$/.exec(parts[3] ?? '')
  if (expiry === null || !Number.isFinite(Date.parse(expiry[1]!))) throw new Error('invalid Harness cookie expiry')
  return `${parts[0]}; ${parts[1]}; Path=/u/${userId}/; ${parts[3]}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}
