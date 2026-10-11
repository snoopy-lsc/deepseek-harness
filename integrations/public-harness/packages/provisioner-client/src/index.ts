/** Linux `InstanceManager` provider: the router's view of the privileged provisioner. */
import { type InstanceManager, type UserId } from '@public-harness/contracts'
import { ProvisionerClient } from '@public-harness/provisioner'

export { ProvisionerClient } from '@public-harness/provisioner'

/** The four fixed provisioner operations the router may use. */
export interface ProvisionerOperations {
  ensure: ProvisionerClient['ensure']
  launchGrant: ProvisionerClient['launchGrant']
  stop: ProvisionerClient['stop']
  status: ProvisionerClient['status']
}

/** Adapt the provisioner to the `InstanceManager` service the router consumes. */
export function createLinuxInstanceManager(client: Pick<ProvisionerOperations, 'ensure' | 'launchGrant' | 'stop'>): InstanceManager {
  return {
    ensure: userId => client.ensure(userId),
    launchGrant: userId => client.launchGrant(userId),
    stop: userId => client.stop(userId),
  }
}

/** Lifecycle states in which an account may not be routed. */
const BLOCKED = new Set(['suspended', 'pending-deletion'])

/**
 * Account-status lookup shared by the router and the production identity verifier.
 * An unreachable provisioner throws, so callers fail closed; a never-seen user is active (first login provisions them).
 */
export function createAccountStatusLookup(client: Pick<ProvisionerOperations, 'status'>): (userId: UserId) => Promise<boolean> {
  return async userId => !BLOCKED.has(await client.status(userId))
}

/** A provisioner client for a socket path, with the router-side adapters. */
export function connectProvisioner(path: string): { manager: InstanceManager; isActive: (userId: UserId) => Promise<boolean>; client: ProvisionerClient } {
  const client = new ProvisionerClient(path)
  return { client, manager: createLinuxInstanceManager(client), isActive: createAccountStatusLookup(client) }
}
