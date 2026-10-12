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
        const personalUsed = scalar(personalTokens, day, userId)
        if (personalUsed > config.personalDailyTokens - maximumTokens) throw daily('personal daily', personalUsed, config.personalDailyTokens)
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
