/** Administrator emergency password gate (decision D6): allow-listed source address, enrolled administrator, single-use TOTP code; the password itself is checked by Better Auth. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { EmergencyConfig } from './config.ts'
import { ipAllowed } from './ip.ts'
import type { SsoStore } from './store.ts'
import { verifyTotp } from './totp.ts'

/** A refused emergency attempt; `detail` is audited, never shown. */
export class EmergencyDeniedError extends Error {
  override readonly name = 'EmergencyDeniedError'
  constructor(readonly detail: 'ip' | 'body' | 'not-enrolled' | 'totp', readonly email?: string) { super('emergency sign-in denied') }
}

const key = (serviceSecret: string) => Buffer.from(hkdfSync('sha256', serviceSecret, 'dsh-identity', 'emergency-totp-v1', 32))

/** Seal a TOTP secret with a key derived from the service secret, so a copy of the database alone does not reveal it.
 * @param secret TOTP secret bytes.
 * @param serviceSecret Better Auth secret from `secretFile`.
 * @returns `v1.` plus base64url of IV, tag and ciphertext.
 */
export function sealSecret(secret: Buffer, serviceSecret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(serviceSecret), iv)
  const body = Buffer.concat([cipher.update(secret), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}

/** Open a sealed TOTP secret.
 * @param sealed Value from `sealSecret`.
 * @param serviceSecret Better Auth secret.
 * @returns Secret bytes; throws when the value or key is wrong.
 */
export function openSecret(sealed: string, serviceSecret: string): Buffer {
  if (!sealed.startsWith('v1.')) throw new Error('unknown sealed secret format')
  const raw = Buffer.from(sealed.slice(3), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key(serviceSecret), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
}

/** Collaborators of the gate. */
export interface EmergencyDeps {
  readonly config: Extract<EmergencyConfig, { enabled: true }>
  readonly store: SsoStore
  readonly serviceSecret: string
  readonly userIdByEmail: (email: string) => string | undefined
  readonly clock: () => number
}

/** Check one attempt before the password is tried.
 * @param deps Settings, store, secret, user lookup and clock.
 * @param ip Client address from the trusted proxy.
 * @param body Parsed JSON body.
 * @returns The email and password to hand to Better Auth; throws `EmergencyDeniedError` otherwise.
 */
export function checkEmergency(deps: EmergencyDeps, ip: string, body: unknown): { userId: string; email: string; password: string } {
  if (!ipAllowed(ip, deps.config.allowedIps)) throw new EmergencyDeniedError('ip')
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const { email: rawEmail, password, code } = record
  if (typeof rawEmail !== 'string' || rawEmail.length > 320 || typeof password !== 'string' || password.length > 256) throw new EmergencyDeniedError('body')
  const email = rawEmail.trim().toLowerCase()
  const userId = deps.userIdByEmail(email)
  const sealed = userId === undefined || deps.store.origin(userId) !== 'emergency' ? undefined : deps.store.emergencySecret(userId)
  if (userId === undefined || sealed === undefined) throw new EmergencyDeniedError('not-enrolled', email)
  const step = typeof code === 'string' ? verifyTotp(openSecret(sealed, deps.serviceSecret), code, deps.clock()) : undefined
  // The step is consumed before the password is tried, so one observed code can never be used again.
  if (step === undefined || !deps.store.useTotpStep(userId, step)) throw new EmergencyDeniedError('totp', email)
  return { userId, email, password }
}
