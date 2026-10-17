/** Knowledge base limit units for the System Admin card (kept free of UI primitives so node tests can import it). */
import type { KbLimitName } from './admin-api.ts'

export const KB_LIMIT_NAMES: readonly KbLimitName[] = ['max_kbs', 'max_bytes', 'max_pages']
const MB = 1024 * 1024
/** Display value of a limit (MB for sizes). */
export const limitText = (name: KbLimitName, value: number | null) => value === null ? '' : name === 'max_bytes' ? String(Math.round(value / MB)) : String(value)
/** Parse an entered value into the stored unit; undefined when it is not a whole number in range. */
export function parseLimit(name: KbLimitName, text: string, range: readonly [number, number]): number | undefined {
  if (!/^[1-9][0-9]{0,12}$/.test(text)) return undefined
  const value = name === 'max_bytes' ? Number(text) * MB : Number(text)
  return value >= range[0] && value <= range[1] ? value : undefined
}
