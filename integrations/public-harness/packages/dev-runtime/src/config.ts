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
  webPatch: string
  startupTimeoutMs: number
  stopTimeoutMs: number
}

/** Validate a complete local runtime configuration before any filesystem or process work. */
export function validateDevRuntimeConfig(config: DevRuntimeConfig): void {
  if (config.mode !== 'development') throw new Error('development runtime requires development mode')
  if (config.host !== '127.0.0.1') throw new Error('development runtime requires a loopback bind')
  if (!isAbsolute(config.storageRoot) || !isAbsolute(config.command) || !isAbsolute(config.webPatch)) {
    throw new Error('development runtime paths must be absolute')
  }
  if (!config.users.length || new Set(config.users).size !== config.users.length) {
    throw new Error('development runtime requires distinct fixed test users')
  }
  for (const value of [config.startupTimeoutMs, config.stopTimeoutMs]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('development runtime timeouts must be positive')
  }
}
