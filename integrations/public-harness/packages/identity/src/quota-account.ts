/** Identity's client for the quota service's private account socket (`DSH_QUOTA_ACCOUNT_SOCKET`): a user's own usage for the personal
 * center and the daily allowances administrators edit. Replies are validated here; identity does not depend on the quota package. */
import { requestLine } from '@public-harness/contracts'
import type { OverLimitMode, PersonalUsage, UsageSource } from './me.ts'

/** Daily allowances as the quota ledger reports them. */
export interface QuotaLimits {
  readonly configuredDailyTokens: number
  readonly defaultDailyTokens: number
  readonly defaultOverride?: number
  readonly overrides: ReadonlyArray<{ readonly userId: string; readonly dailyTokens: number }>
  readonly overLimit: { readonly mode: OverLimitMode; readonly gracePercent: number }
}
/** Allowance reads and edits; `null` removes an override. */
export interface QuotaAdmin {
  limits(): Promise<QuotaLimits>
  setDefault(dailyTokens: number | null): Promise<QuotaLimits>
  setUser(userId: string, dailyTokens: number | null): Promise<QuotaLimits>
  setOverLimit(mode: OverLimitMode, gracePercent: number): Promise<QuotaLimits>
}
/** A reply that does not match the account protocol. */
export class QuotaAccountReplyError extends Error { constructor() { super('quota account reply') } }

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new QuotaAccountReplyError()
  return value as Record<string, unknown>
}
const whole = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new QuotaAccountReplyError(); return value }
const mode = (value: unknown): OverLimitMode => { if (value !== 'block' && value !== 'grace' && value !== 'warn') throw new QuotaAccountReplyError(); return value }
const STATES = ['ok', 'grace', 'over', 'blocked'] as const
const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 64) throw new QuotaAccountReplyError(); return value }

/** Validate a usage reply. */
export function parseUsage(raw: unknown): PersonalUsage {
  const r = record(raw)
  if (!Array.isArray(r.history) || r.history.length > 31) throw new QuotaAccountReplyError()
  return { day: text(r.day), usedTokens: whole(r.usedTokens), limitTokens: whole(r.limitTokens), resetAt: text(r.resetAt),
    history: r.history.map(item => { const h = record(item); return { day: text(h.day), tokens: whole(h.tokens) } }),
    ...r.overLimit === undefined ? {} : { overLimit: mode(r.overLimit) },
    ...r.state === undefined ? {} : { state: STATES.find(s => s === r.state) ?? (() => { throw new QuotaAccountReplyError() })() },
    ...r.hardLimitTokens === undefined ? {} : { hardLimitTokens: r.hardLimitTokens === null ? null : whole(r.hardLimitTokens) } }
}
/** Validate a limits reply. */
export function parseLimits(raw: unknown): QuotaLimits {
  const r = record(raw)
  if (!Array.isArray(r.overrides) || r.overrides.length > 100_000) throw new QuotaAccountReplyError()
  return { configuredDailyTokens: whole(r.configuredDailyTokens), defaultDailyTokens: whole(r.defaultDailyTokens),
    ...r.defaultOverride === undefined ? {} : { defaultOverride: whole(r.defaultOverride) },
    overrides: r.overrides.map(item => { const o = record(item); return { userId: text(o.userId), dailyTokens: whole(o.dailyTokens) } }),
    overLimit: (() => { const o = r.overLimit === undefined ? { mode: 'block', gracePercent: 10 } : record(r.overLimit); return { mode: mode(o.mode), gracePercent: whole(o.gracePercent) } })() }
}

/** Connect to the account socket; each call is one request on a fresh connection, so the quota service may start after identity.
 * @param socketPath Absolute socket path.
 * @param timeoutMs Per-request timeout.
 * @returns Usage source and allowance editor.
 */
export function createQuotaAccountClient(socketPath: string, timeoutMs = 5000): { usage: UsageSource } & QuotaAdmin {
  const ask = (request: unknown) => requestLine(socketPath, request, timeoutMs)
  return {
    usage: async userId => parseUsage(await ask({ op: 'usage', userId })),
    limits: async () => parseLimits(await ask({ op: 'limits' })),
    setDefault: async dailyTokens => parseLimits(await ask({ op: 'set-default', dailyTokens })),
    setUser: async (userId, dailyTokens) => parseLimits(await ask({ op: 'set-user', userId, dailyTokens })),
    setOverLimit: async (overLimit, gracePercent) => parseLimits(await ask({ op: 'set-over-limit', mode: overLimit, gracePercent })),
  }
}
