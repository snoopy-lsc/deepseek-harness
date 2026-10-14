/** Private account channel from the identity service to the quota ledger: a user's own usage for the personal center, and the
 * daily allowances administrators edit. Identity is the only client; it has already checked the session and, for writes, the admin role. */
import { parseUserId, startLineServer, type SocketAccess } from '@public-harness/contracts'
import type { OverLimitMode, QuotaLedger, PersonalUsage, QuotaLimits } from './ledger.ts'

/** Ledger operations the account channel exposes. */
export type QuotaAccountLedger = Pick<QuotaLedger & {
  usage(userId: ReturnType<typeof parseUserId>): Promise<PersonalUsage>
  limits(): Promise<QuotaLimits>
  setDefaultLimit(dailyTokens: number | null): Promise<void>
  setUserLimit(userId: ReturnType<typeof parseUserId>, dailyTokens: number | null): Promise<void>
  setOverLimit(mode: OverLimitMode, gracePercent: number): Promise<void>
}, 'usage' | 'limits' | 'setDefaultLimit' | 'setUserLimit' | 'setOverLimit'>

type Request = { op: 'usage'; userId: string } | { op: 'limits' } | { op: 'set-default'; dailyTokens: number | null } | { op: 'set-user'; userId: string; dailyTokens: number | null } | { op: 'set-over-limit'; mode: OverLimitMode; gracePercent: number }

const tokens = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)

/** Validate one request exactly; anything else is refused before the ledger is touched. */
export function parseAccountRequest(raw: unknown): Request {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid request')
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.op === 'limits' && keys === 'op') return { op: 'limits' }
  if (record.op === 'usage' && keys === 'op,userId' && typeof record.userId === 'string') return { op: 'usage', userId: parseUserId(record.userId) }
  if (record.op === 'set-default' && keys === 'dailyTokens,op' && tokens(record.dailyTokens)) return { op: 'set-default', dailyTokens: record.dailyTokens }
  if (record.op === 'set-user' && keys === 'dailyTokens,op,userId' && typeof record.userId === 'string' && tokens(record.dailyTokens)) {
    return { op: 'set-user', userId: parseUserId(record.userId), dailyTokens: record.dailyTokens }
  }
  if (record.op === 'set-over-limit' && keys === 'gracePercent,mode,op' && (record.mode === 'block' || record.mode === 'grace' || record.mode === 'warn')
    && typeof record.gracePercent === 'number' && Number.isSafeInteger(record.gracePercent) && record.gracePercent >= 1 && record.gracePercent <= 100) {
    return { op: 'set-over-limit', mode: record.mode, gracePercent: record.gracePercent }
  }
  throw new Error('invalid request')
}

/** Serve the account channel on a private Unix socket (owner plus, with `access`, the identity service's group).
 * @param path Socket path in a private directory.
 * @param ledger The quota ledger.
 * @param access Optional group allowed to connect.
 * @returns Handle that closes the socket.
 */
export function startQuotaAccountServer(path: string, ledger: QuotaAccountLedger, access?: SocketAccess): ReturnType<typeof startLineServer> {
  return startLineServer(path, async raw => {
    const request = parseAccountRequest(raw)
    switch (request.op) {
      case 'usage': return await ledger.usage(parseUserId(request.userId))
      case 'limits': return await ledger.limits()
      case 'set-default': await ledger.setDefaultLimit(request.dailyTokens); return await ledger.limits()
      case 'set-user': await ledger.setUserLimit(parseUserId(request.userId), request.dailyTokens); return await ledger.limits()
      case 'set-over-limit': await ledger.setOverLimit(request.mode, request.gracePercent); return await ledger.limits()
    }
  }, access)
}
