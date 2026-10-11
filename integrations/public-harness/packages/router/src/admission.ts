/** Site-wide active-instance ceiling used as the router's pre-check before an instance is started. */
import type { UserId } from '@public-harness/contracts'

/** Inputs for `createAdmission`. */
export interface AdmissionConfig {
  /** Configured ceiling of simultaneously active instances (positive). */
  readonly maxActive: number
  /** Users with an active (starting or running) instance right now. */
  readonly active: () => Iterable<UserId> | Promise<Iterable<UserId>>
}

/** A user may proceed when they already hold a slot or a free slot exists; otherwise a capacity response is returned. */
export function createAdmission(config: AdmissionConfig): { hasCapacity(userId: UserId): Promise<boolean> } {
  if (!Number.isSafeInteger(config.maxActive) || config.maxActive <= 0) throw new Error('active-instance cap must be positive')
  return {
    async hasCapacity(userId) {
      const active = new Set(await config.active())
      return active.has(userId) || active.size < config.maxActive
    },
  }
}
