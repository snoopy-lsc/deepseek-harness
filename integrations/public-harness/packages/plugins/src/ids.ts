/** Opaque catalogue identifiers; never derived from package names. */
import { randomBytes } from 'node:crypto'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** `<prefix>_` plus 16 base32 characters (80 random bits). */
export function newId(prefix: 'plg' | 'plv' | 'pps'): string {
  return `${prefix}_${Array.from(randomBytes(16), byte => BASE32[byte & 31]).join('')}`
}

export const ID_PATTERN = {
  plg: /^plg_[a-z2-7]{16}$/,
  plv: /^plv_[a-z2-7]{16}$/,
  pps: /^pps_[a-z2-7]{16}$/,
} as const
