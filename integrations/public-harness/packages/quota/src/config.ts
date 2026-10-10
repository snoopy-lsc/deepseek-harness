/** Durable quota limits required before the model proxy admits calls. */
import { isAbsolute } from 'node:path'

/** Daily token and in-flight request limits for one quota database. */
export interface QuotaConfig {
  readonly databasePath: string
  readonly personalDailyTokens: number
  readonly siteDailyTokens: number
  readonly personalConcurrency: number
  readonly siteConcurrency: number
  readonly busyTimeoutMs: number
}

/** Reject missing or unsafe quota limits before opening the ledger. */
export function validateQuotaConfig(config: QuotaConfig): void {
  if (!isAbsolute(config.databasePath) || config.databasePath.includes('\0')) {
    throw new Error('quota database path must be absolute')
  }
  for (const [name, value] of Object.entries(config).filter(([name]) => name !== 'databasePath')) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive safe integer`)
  }
}
