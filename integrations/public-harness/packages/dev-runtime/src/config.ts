/** Configuration checks that run before a development child can start. */
import { isAbsolute } from 'node:path'
import type { UserId } from '@public-harness/contracts'

/** Local development settings; the runtime never listens on a public address. */
export interface DevRuntimeConfig {
  mode: string
  host: string
  storageRoot: string
  users: readonly UserId[]
  command: string
  args: readonly string[]
  /** One patch for every user, or a resolver returning each user's absolute patch path. */
  webPatch: string | ((userId: UserId) => string)
  /** Most users that may hold a starting or running Web child at once; defaults to the number of users. */
  maxActive?: number
  startupTimeoutMs: number
  stopTimeoutMs: number
  /** Knowledge base root of a local `dsh-kb`; when set, `<home>/kb/mine` and `<home>/kb/shared` link to the user's KB tree and view.
   * Development has no mount isolation: these are plain symbolic links and nothing is enforced. */
  kbRoot?: string
}

/** Validate a complete local runtime configuration before any filesystem or process work. */
export function validateDevRuntimeConfig(config: DevRuntimeConfig): void {
  if (config.mode !== 'development') throw new Error('development runtime requires development mode')
  if (config.host !== '127.0.0.1') throw new Error('development runtime requires a loopback bind')
  if (!isAbsolute(config.storageRoot) || !isAbsolute(config.command)
    || (typeof config.webPatch === 'string' && !isAbsolute(config.webPatch)) || (config.kbRoot !== undefined && !isAbsolute(config.kbRoot))) {
    throw new Error('development runtime paths must be absolute')
  }
  if (config.users.length > 0) validateDevUsers(config.users)
  else if (config.maxActive === undefined) throw new Error('empty development users require an explicit active-instance cap')
  if (config.maxActive !== undefined && (!Number.isSafeInteger(config.maxActive) || config.maxActive <= 0)) {
    throw new Error('development runtime active-instance cap must be positive')
  }
  for (const value of [config.startupTimeoutMs, config.stopTimeoutMs]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('development runtime timeouts must be positive')
  }
}

/** Require fixed identities with distinct portable directory names.
 * @param users - canonical IDs configured for a local development server.
 */
export function validateDevUsers(users: readonly UserId[]): void {
  if (!users.length || new Set(users.map(user => user.toLowerCase())).size !== users.length
    || users.some(user => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(user))) {
    throw new Error('development runtime requires distinct fixed test users')
  }
}

/** Resolve and re-validate one user's Web patch path. */
export function webPatchFor(config: DevRuntimeConfig, userId: UserId): string {
  const path = typeof config.webPatch === 'string' ? config.webPatch : config.webPatch(userId)
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('development runtime paths must be absolute')
  return path
}
