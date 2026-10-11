/** Typed refusals that cross the router, provisioner, and instance-manager boundaries. */

/** The site-wide active-instance cap is reached; no runtime or account was created. */
export class CapacityError extends Error {
  override readonly name = 'CapacityError'
  constructor() { super('capacity') }
}

/** The account is deactivated or awaiting deletion; no runtime may start. */
export class AccountSuspendedError extends Error {
  override readonly name = 'AccountSuspendedError'
  constructor() { super('suspended') }
}

/** Wire-safe error messages: the only provisioner failures a caller may distinguish. */
export const WIRE_ERRORS = ['invalid request', 'invalid user ID', 'message too large', 'response too large',
  'capacity', 'suspended'] as const

/** Map a thrown value to one of the fixed wire messages, hiding every other detail. */
export function toWireError(error: unknown): string {
  if (error instanceof CapacityError) return 'capacity'
  if (error instanceof AccountSuspendedError) return 'suspended'
  if (error instanceof Error && (WIRE_ERRORS as readonly string[]).includes(error.message)) return error.message
  return 'request failed'
}

/** Rebuild a typed error from a fixed wire message. */
export function fromWireError(message: string): Error {
  if (message === 'capacity') return new CapacityError()
  if (message === 'suspended') return new AccountSuspendedError()
  return new Error(message)
}
