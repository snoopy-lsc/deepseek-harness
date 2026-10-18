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

/** Quota budget principals of org knowledge bases (`org-kb-<kbId>`), which are not login users. */
export const isBudgetPrincipal = (id: string) => id.startsWith('org-kb-')
/** One org KB with the daily allowance its compiles are charged against (the default when it has no override). */
export interface BudgetRow { kbId: string; title: string; archived: boolean; principal: string; dailyTokens: number; inherited: boolean }
/** Pair every org KB with its budget principal's allowance. */
export function budgetRows(kbs: ReadonlyArray<{ id: string; kind: string; title: string; archivedAt: number | null; chargedTo: string | null }>,
  quota: { defaultDailyTokens: number; overrides: ReadonlyArray<{ userId: string; dailyTokens: number }> }): BudgetRow[] {
  return kbs.filter(kb => kb.kind === 'org' && kb.chargedTo !== null).map(kb => {
    const override = quota.overrides.find(o => o.userId === kb.chargedTo)
    return { kbId: kb.id, title: kb.title, archived: kb.archivedAt !== null, principal: kb.chargedTo!, dailyTokens: override?.dailyTokens ?? quota.defaultDailyTokens, inherited: override === undefined }
  })
}
/** Overrides of login users only; budget principals are shown with their knowledge base instead. */
export const userOverrides = <O extends { userId: string }>(overrides: readonly O[]) => overrides.filter(o => !isBudgetPrincipal(o.userId))
