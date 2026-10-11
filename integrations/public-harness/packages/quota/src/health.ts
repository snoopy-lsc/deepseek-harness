/** Private aggregate quota health reporting. */
import type { QuotaAggregate } from './ledger.ts'

/** No user data or detailed storage errors reach the health response. */
export type QuotaHealth = ({ readonly available: true } & QuotaAggregate) | { readonly available: false }

/** Convert ledger status to an aggregate, redacted health response. */
export async function inspectQuotaHealth(ledger: { status(): Promise<QuotaAggregate> }): Promise<QuotaHealth> {
  try { return { available: true, ...await ledger.status() } }
  catch { return { available: false } }
}
