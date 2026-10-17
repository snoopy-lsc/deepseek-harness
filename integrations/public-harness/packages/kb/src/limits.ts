/** Effective knowledge base limits. Each limit resolves on its own: a user override wins, then group overrides (the most permissive
 * across the user's effective groups, which include ancestor departments; unlimited counts as the maximum), then the global value.
 * A missing row inherits; a NULL value means unlimited. */
import { DEFAULT_LIMITS, LIMIT_NAMES, type LimitName, type LimitRow } from './store.ts'

/** One resolved limit and where it came from. */
export interface EffectiveLimit { readonly value: number | null; readonly source: 'user' | `group:${string}` | 'global' }
export type EffectiveLimits = Record<LimitName, EffectiveLimit>

/** Resolve the three limits for one user.
 * @param rows Every limit row.
 * @param userId The user.
 * @param groups The user's effective groups (direct plus ancestors).
 * @returns Value and source per limit.
 */
export function effectiveLimits(rows: readonly LimitRow[], userId: string, groups: readonly string[]): EffectiveLimits {
  const member = new Set(groups)
  const out = {} as Record<LimitName, EffectiveLimit>
  for (const name of LIMIT_NAMES) {
    const user = rows.find(row => row.name === name && row.scopeType === 'user' && row.scopeId === userId)
    if (user !== undefined) { out[name] = { value: user.value, source: 'user' }; continue }
    const groupRows = rows.filter(row => row.name === name && row.scopeType === 'group' && member.has(row.scopeId))
      // Deterministic: unlimited first, then the largest value, ties by group ID.
      .sort((a, b) => a.value === b.value ? a.scopeId.localeCompare(b.scopeId) : a.value === null ? -1 : b.value === null ? 1 : b.value - a.value)
    if (groupRows.length > 0) { out[name] = { value: groupRows[0]!.value, source: `group:${groupRows[0]!.scopeId}` }; continue }
    const global = rows.find(row => row.name === name && row.scopeType === 'global')
    out[name] = { value: global === undefined ? DEFAULT_LIMITS[name] : global.value, source: 'global' }
  }
  return out
}

/** True when `used` is at or above a limit (null is never reached). */
export const atLimit = (limit: EffectiveLimit, used: number) => limit.value !== null && used >= limit.value
/** True when `used` is strictly above a limit. */
export const overLimit = (limit: EffectiveLimit, used: number) => limit.value !== null && used > limit.value
