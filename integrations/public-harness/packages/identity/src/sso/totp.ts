/** RFC 6238 time-based one-time passwords (SHA-1, six digits, 30-second steps), the emergency path's second factor. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const STEP_MS = 30_000
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Compute the code for one time step.
 * @param secret Shared secret bytes.
 * @param step Time step (Unix seconds divided by 30).
 * @returns Six-digit code.
 */
export function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return value.toString().padStart(6, '0')
}

/** Check a code against the current step and one step either side.
 * @param secret Shared secret bytes.
 * @param code Submitted code.
 * @param now Clock in milliseconds.
 * @param window Accepted steps of drift on each side.
 * @returns The matching step, which the caller must mark used, or undefined.
 */
export function verifyTotp(secret: Buffer, code: string, now: number, window = 1): number | undefined {
  if (!/^[0-9]{6}$/.test(code)) return undefined
  const current = Math.floor(now / STEP_MS)
  let match: number | undefined
  // Every candidate is compared so timing does not reveal which step matched.
  for (let step = current - window; step <= current + window; step++) {
    if (timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code)) && match === undefined) match = step
  }
  return match
}

/** Generate a 160-bit secret.
 * @returns Secret bytes.
 */
export function newTotpSecret(): Buffer { return randomBytes(20) }

/** Base32-encode a secret (RFC 4648, no padding).
 * @param bytes Secret bytes.
 * @returns Base32 text.
 */
export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Enrollment URI for authenticator apps.
 * @param secret Secret bytes.
 * @param account Account label (the administrator's email).
 * @param issuer Issuer label.
 * @returns `otpauth://totp/...` URI.
 */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const params = new URLSearchParams({ secret: base32(secret), issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${params}`
}
