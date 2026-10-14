/** SQLite reservations charged against personal and site token budgets. */
import { randomUUID } from 'node:crypto'
import { chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { UserId } from '@public-harness/contracts'
import { validateQuotaConfig, type QuotaConfig } from './config.ts'

/** Opaque identity for one durable model reservation. */
export type ReservationId = Branded<'PublicHarnessReservationId'>

/** A reservation's upper bound; an interrupted call is settled from what was actually received instead. */
export interface Reservation {
  readonly id: ReservationId
  readonly userId: UserId
  readonly day: string
  readonly maximumTokens: number
  /** Admission's input-size estimate, used to settle a call that ended before upstream reported usage. */
  readonly estimatedInputTokens?: number
}

/** Durable personal and site quota operations. */
export interface QuotaLedger {
  reserve(userId: UserId, maximumTokens: number): Promise<Reservation>
  settle(id: ReservationId, actualTokens?: number): Promise<void>
  close(): void
}

/** Aggregate quota counters without individual users or requests. */
export interface QuotaAggregate {
  readonly siteTokensUsed: number
  readonly siteTokensLimit: number
  readonly siteInFlight: number
  readonly siteConcurrencyLimit: number
}

/** One user's own token use: today against the personal limit, and the charged total of each recent day that had any. */
export interface PersonalUsage {
  readonly day: string
  readonly usedTokens: number
  readonly limitTokens: number
  /** Start of the next UTC quota day. */
  readonly resetAt: string
  /** Oldest first, at most seven days ending today. */
  readonly history: ReadonlyArray<{ readonly day: string; readonly tokens: number }>
}

/** Daily personal allowances: the configured value, an optional site-wide override, and per-user overrides. */
export interface QuotaLimits {
  readonly configuredDailyTokens: number
  /** What a user without an override gets: the default override when set, else the configured value. */
  readonly defaultDailyTokens: number
  readonly defaultOverride?: number
  readonly overrides: ReadonlyArray<{ readonly userId: string; readonly dailyTokens: number }>
}

/** A specific capacity limit rejected admission before upstream access. */
export class QuotaExceededError extends Error {
  /**
   * @param reason Which limit refused the call.
   * @param detail For daily limits: tokens still available today, tokens this call needed, and when the day resets (UTC).
   */
  constructor(readonly reason: 'personal daily' | 'site daily' | 'personal concurrency' | 'site concurrency',
    readonly detail?: { readonly remainingTokens: number; readonly requestedTokens: number; readonly resetAt: string }) {
    super(`quota ${reason} limit exceeded`)
  }
}

/** Start of the next UTC quota day. */
export function quotaResetAt(now: Date): string {
  const next = new Date(now.valueOf())
  next.setUTCHours(24, 0, 0, 0)
  return next.toISOString()
}

function scalar(statement: StatementSync, ...values: (string | number)[]): number {
  const row = statement.get(...values)
  const value = row?.['value']
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid quota database count')
  return value
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const value = operation()
    database.exec('COMMIT')
    return value
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** Open the ledger and charge unfinished reservations from an earlier process. */
export function createQuotaLedger(config: QuotaConfig, clock: () => Date = () => new Date()): QuotaLedger & {
  status(): Promise<QuotaAggregate>
  /** Read-only usage of one user; pending reservations count at their upper bound, as admission does. */
  usage(userId: UserId): Promise<PersonalUsage>
  /** Current allowances. */
  limits(): Promise<QuotaLimits>
  /** Set (or with null clear) the site-wide default personal allowance; at most the site daily limit. */
  setDefaultLimit(dailyTokens: number | null): Promise<void>
  /** Set (or with null clear) one user's personal allowance; at most the site daily limit. */
  setUserLimit(userId: UserId, dailyTokens: number | null): Promise<void>
} {
  validateQuotaConfig(config)
  if (process.platform !== 'win32' && (statSync(dirname(config.databasePath)).mode & 0o077) !== 0) {
    throw new Error('quota database parent must be private')
  }
  const database = new DatabaseSync(config.databasePath)
  let closed = false
  try {
    if (process.platform !== 'win32') chmodSync(config.databasePath, 0o600)
    database.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      maximum_tokens INTEGER NOT NULL CHECK (maximum_tokens > 0),
      charged_tokens INTEGER CHECK (charged_tokens >= 0)
    ) STRICT`)
    database.exec('CREATE INDEX IF NOT EXISTS reservations_day_user ON reservations(day, user_id)')
    database.exec('CREATE TABLE IF NOT EXISTS personal_limits (user_id TEXT PRIMARY KEY, daily_tokens INTEGER NOT NULL CHECK (daily_tokens > 0)) STRICT')
    database.exec("CREATE TABLE IF NOT EXISTS limit_settings (name TEXT PRIMARY KEY CHECK (name = 'default'), daily_tokens INTEGER NOT NULL CHECK (daily_tokens > 0)) STRICT")
    database.exec('CREATE INDEX IF NOT EXISTS reservations_pending ON reservations(charged_tokens, user_id)')
    transaction(database, () => {
      database.prepare('UPDATE reservations SET charged_tokens = maximum_tokens WHERE charged_tokens IS NULL').run()
    })
  } catch (error) {
    database.close()
    throw error
  }
  const personalTokens = database.prepare('SELECT COALESCE(SUM(COALESCE(charged_tokens, maximum_tokens)), 0) AS value FROM reservations WHERE day = ? AND user_id = ?')
  const siteTokens = database.prepare('SELECT COALESCE(SUM(COALESCE(charged_tokens, maximum_tokens)), 0) AS value FROM reservations WHERE day = ?')
  const personalPending = database.prepare('SELECT COUNT(*) AS value FROM reservations WHERE charged_tokens IS NULL AND user_id = ?')
  const sitePending = database.prepare('SELECT COUNT(*) AS value FROM reservations WHERE charged_tokens IS NULL')
  const insertion = database.prepare('INSERT INTO reservations (id, user_id, day, maximum_tokens) VALUES (?, ?, ?, ?)')
  const selection = database.prepare('SELECT charged_tokens FROM reservations WHERE id = ?')
  const settlement = database.prepare('UPDATE reservations SET charged_tokens = ? WHERE id = ? AND charged_tokens IS NULL')
  const personalHistory = database.prepare('SELECT day, SUM(COALESCE(charged_tokens, maximum_tokens)) AS tokens FROM reservations WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day')
  const userLimit = database.prepare('SELECT daily_tokens AS value FROM personal_limits WHERE user_id = ?')
  const defaultLimit = database.prepare("SELECT daily_tokens AS value FROM limit_settings WHERE name = 'default'")
  const allOverrides = database.prepare('SELECT user_id, daily_tokens FROM personal_limits ORDER BY user_id')
  const putUser = database.prepare('INSERT INTO personal_limits (user_id, daily_tokens) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET daily_tokens = excluded.daily_tokens')
  const dropUser = database.prepare('DELETE FROM personal_limits WHERE user_id = ?')
  const putDefault = database.prepare("INSERT INTO limit_settings (name, daily_tokens) VALUES ('default', ?) ON CONFLICT(name) DO UPDATE SET daily_tokens = excluded.daily_tokens")
  const dropDefault = database.prepare("DELETE FROM limit_settings WHERE name = 'default'")
  const fallback = (): number => (defaultLimit.get()?.['value'] as number | undefined) ?? config.personalDailyTokens
  const personalLimit = (userId: string): number => (userLimit.get(userId)?.['value'] as number | undefined) ?? fallback()
  const checkLimit = (value: number): void => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('daily limit must be a positive safe integer')
    if (value > config.siteDailyTokens) throw new Error('daily limit cannot exceed the site daily limit')
  }
  const requireOpen = (): void => { if (closed) throw new Error('quota ledger is closed') }
  return {
    async status() {
      requireOpen()
      const now = clock()
      if (!Number.isFinite(now.valueOf())) throw new Error('quota clock is invalid')
      const day = now.toISOString().slice(0, 10)
      return { siteTokensUsed: scalar(siteTokens, day), siteTokensLimit: config.siteDailyTokens,
        siteInFlight: scalar(sitePending), siteConcurrencyLimit: config.siteConcurrency }
    },
    async usage(userId) {
      requireOpen()
      const now = clock()
      if (!Number.isFinite(now.valueOf())) throw new Error('quota clock is invalid')
      const day = now.toISOString().slice(0, 10)
      const first = new Date(now.valueOf() - 6 * 86_400_000).toISOString().slice(0, 10)
      const history = (personalHistory.all(userId, first, day) as Array<{ day: string; tokens: number }>).map(row => ({ day: String(row.day), tokens: Number(row.tokens) }))
      return { day, usedTokens: scalar(personalTokens, day, userId), limitTokens: personalLimit(userId), resetAt: quotaResetAt(now), history }
    },
    async limits() {
      requireOpen()
      const override = defaultLimit.get()?.['value'] as number | undefined
      return { configuredDailyTokens: config.personalDailyTokens, defaultDailyTokens: override ?? config.personalDailyTokens,
        ...override === undefined ? {} : { defaultOverride: override },
        overrides: (allOverrides.all() as Array<{ user_id: string; daily_tokens: number }>).map(row => ({ userId: String(row.user_id), dailyTokens: Number(row.daily_tokens) })) }
    },
    async setDefaultLimit(dailyTokens) {
      requireOpen()
      if (dailyTokens === null) { dropDefault.run(); return }
      checkLimit(dailyTokens); putDefault.run(dailyTokens)
    },
    async setUserLimit(userId, dailyTokens) {
      requireOpen()
      if (dailyTokens === null) { dropUser.run(userId); return }
      checkLimit(dailyTokens); putUser.run(userId, dailyTokens)
    },
    async reserve(userId, maximumTokens) {
      requireOpen()
      if (!Number.isSafeInteger(maximumTokens) || maximumTokens <= 0) throw new Error('maximumTokens must be a positive safe integer')
      const now = clock()
      if (!Number.isFinite(now.valueOf())) throw new Error('quota clock is invalid')
      const day = now.toISOString().slice(0, 10)
      return transaction(database, () => {
        if (scalar(personalPending, userId) >= config.personalConcurrency) throw new QuotaExceededError('personal concurrency')
        if (scalar(sitePending) >= config.siteConcurrency) throw new QuotaExceededError('site concurrency')
        const daily = (reason: 'personal daily' | 'site daily', used: number, limit: number): QuotaExceededError =>
          new QuotaExceededError(reason, { remainingTokens: Math.max(0, limit - used), requestedTokens: maximumTokens, resetAt: quotaResetAt(now) })
        const personalUsed = scalar(personalTokens, day, userId), personalDaily = personalLimit(userId)
        if (personalUsed > personalDaily - maximumTokens) throw daily('personal daily', personalUsed, personalDaily)
        const siteUsed = scalar(siteTokens, day)
        if (siteUsed > config.siteDailyTokens - maximumTokens) throw daily('site daily', siteUsed, config.siteDailyTokens)
        const id = randomUUID() as ReservationId
        insertion.run(id, userId, day, maximumTokens)
        return { id, userId, day, maximumTokens }
      })
    },
    async settle(id, actualTokens) {
      requireOpen()
      if (actualTokens !== undefined && (!Number.isSafeInteger(actualTokens) || actualTokens < 0)) {
        throw new Error('actualTokens must be a nonnegative safe integer')
      }
      transaction(database, () => {
        const row = selection.get(id)
        if (row === undefined) throw new Error('unknown quota reservation')
        if (row['charged_tokens'] !== null) return
        const charge = actualTokens ?? scalar(database.prepare('SELECT maximum_tokens AS value FROM reservations WHERE id = ?'), id)
        settlement.run(charge, id)
      })
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
