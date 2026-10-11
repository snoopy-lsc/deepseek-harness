/** Private aggregate quota health reporting and sanitized diagnostics. */
import type { QuotaAggregate } from './ledger.ts'

/** Why a model request was refused; categories only, never identities or content. */
export type RejectionCategory = 'personal-daily' | 'site-daily' | 'concurrency' | 'unauthenticated' | 'invalid-request' | 'unavailable'

/** Counts of refusals per category since the process started. */
export type RejectionCounts = Readonly<Record<RejectionCategory, number>>

/** No user data or detailed storage errors reach the health response. */
export type QuotaHealth = ({ readonly available: true; readonly rejections?: RejectionCounts } & QuotaAggregate) | { readonly available: false }

/** In-memory counters fed by the HTTP server; resetting on restart is intentional (they are signals, not accounting). */
export interface RejectionCounter {
  record(category: RejectionCategory): void
  snapshot(): RejectionCounts
}

/** Create a counter with every category present at zero. */
export function createRejectionCounter(): RejectionCounter {
  const counts: Record<RejectionCategory, number> = { 'personal-daily': 0, 'site-daily': 0, concurrency: 0,
    unauthenticated: 0, 'invalid-request': 0, unavailable: 0 }
  return { record(category) { counts[category] += 1 }, snapshot: () => ({ ...counts }) }
}

/** Convert ledger status to an aggregate, redacted health response. */
export async function inspectQuotaHealth(ledger: { status(): Promise<QuotaAggregate> }, counter?: RejectionCounter): Promise<QuotaHealth> {
  try { return { available: true, ...await ledger.status(), ...counter === undefined ? {} : { rejections: counter.snapshot() } } }
  catch { return { available: false } }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b(?:sk|pk|key)-[A-Za-z0-9_-]{8,}/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /(?:authorization|x-api-key|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
  /(?:\/[A-Za-z0-9._-]+){2,}/g,
]

/** Redact secrets and filesystem paths from a diagnostic before it is logged; never log the original. */
export function sanitizeDiagnostic(value: unknown, maxLength = 200): string {
  let output = value instanceof Error ? value.message : typeof value === 'string' ? value : 'unknown failure'
  output = output.replace(SECRET_PATTERNS[0]!, '[redacted]')
  output = output.replace(SECRET_PATTERNS[3]!, (_match, separator: string, offset: number, whole: string) => {
    const name = /^[^:="']*/.exec(whole.slice(offset))![0]
    return `${name}${separator}[redacted]`
  })
  for (const pattern of SECRET_PATTERNS.filter((_p, index) => index !== 3 && index !== 0)) output = output.replace(pattern, '[redacted]')
  return output.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, maxLength)
}
