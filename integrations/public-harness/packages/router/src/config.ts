/** Shared authenticated identity interface for browser routing. */
import type { IncomingHttpHeaders } from 'node:http'
import type { UserId } from '@public-harness/contracts'

/** Every HTTP request and upgrade obtains one checked platform user. */
export interface IdentityVerifier {
  verify(headers: IncomingHttpHeaders): Promise<UserId>
}

/** Identity lookup could not answer (timeout, unavailable store or socket, invalid response); the router answers 503
 * and never reuses an earlier positive result. Invalid credentials stay a plain error and 401. */
export class IdentityUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError'
}

/** Reject missing, duplicated, or comma-joined identity header values. */
export function singleHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  if (typeof value !== 'string' || !value || value.includes(',')) throw new Error(`missing or duplicate ${name}`)
  return value
}
