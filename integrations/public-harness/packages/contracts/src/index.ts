import { isAbsolute } from 'node:path'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque platform user identifier. */
export type UserId = Branded<'PublicHarnessUserId'>

/** An address owned by a single Harness process. */
export type InstanceEndpoint = { kind: 'unix'; path: string } | { kind: 'tcp'; host: '127.0.0.1'; port: number }

/** Validate a platform user ID received across a process or wire boundary. */
export function parseUserId(value: string): UserId {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid user ID')
  return value as UserId
}

/** Validate an instance endpoint received across a process or wire boundary. */
export function parseInstanceEndpoint(value: unknown): InstanceEndpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid endpoint')
  const record = value as Record<string, unknown>
  if (record.kind === 'unix' && Object.keys(record).sort().join(',') === 'kind,path'
    && typeof record.path === 'string' && isAbsolute(record.path) && !record.path.includes('\0')) {
    return { kind: 'unix', path: record.path }
  }
  if (record.kind === 'tcp' && Object.keys(record).sort().join(',') === 'host,kind,port'
    && record.host === '127.0.0.1' && typeof record.port === 'number'
    && Number.isInteger(record.port) && record.port >= 1 && record.port <= 65535) {
    return { kind: 'tcp', host: '127.0.0.1', port: record.port }
  }
  throw new Error('invalid endpoint')
}

/** Instance lifecycle capability consumed by the router. */
export interface InstanceManager {
  ensure(userId: UserId): Promise<InstanceEndpoint>
  /** The instance's current Web launch grant: reusable until the instance restarts, and never sent to a browser. */
  launchGrant(userId: UserId): Promise<string>
  stop(userId: UserId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context extends InstanceType<typeof CordisContext> {
    instanceManager: InstanceManager
  }
}

export * from './errors.ts'
export * from './git-workspace.ts'
export * from './idle.ts'
export * from './line-protocol.ts'
export * from './ports.ts'
export * from './runtime.ts'
