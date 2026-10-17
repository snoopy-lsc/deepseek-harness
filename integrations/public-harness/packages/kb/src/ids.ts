/** Opaque identifiers; never derived from titles or file names. */
import { randomBytes } from 'node:crypto'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
/** `<prefix>_` plus 16 base32 characters (80 random bits). */
export function newId(prefix: 'kb' | 'job' | 'req' | 'snap'): string {
  return `${prefix}_${Array.from(randomBytes(16), byte => BASE32[byte & 31]).join('')}`
}
export const ID_PATTERN = { kb: /^kb_[a-z2-7]{16}$/, job: /^job_[a-z2-7]{16}$/, req: /^req_[a-z2-7]{16}$/, snap: /^snap_[a-z2-7]{16}$/ } as const

/** A slug from a title: lower-case ASCII letters, digits and single hyphens, 1–40 characters, `kb` when nothing is left. */
export function slugify(title: string): string {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  return slug || 'kb'
}
