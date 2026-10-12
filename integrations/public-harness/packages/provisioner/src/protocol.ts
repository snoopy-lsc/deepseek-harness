/** Fixed, bounded Unix-socket protocol for the Linux provisioner. */
import type { InstanceEndpoint, UserId } from '@public-harness/contracts'
import { parseInstanceEndpoint, parseUserId, requestLine, startLineServer, type SocketAccess } from '@public-harness/contracts'

export { MAX_MESSAGE_BYTES, readLine, sendLine, startLineServer, type SocketAccess } from '@public-harness/contracts'

const OPERATIONS = ['ensure', 'launch-grant', 'stop', 'status'] as const

/** Only these operations can cross the router-to-provisioner socket. */
export type ProvisionerRequest = { op: typeof OPERATIONS[number]; userId: UserId }

/** The provisioner owns the operation and returns its result. */
export type ProvisionerHandler = (request: ProvisionerRequest) => Promise<InstanceEndpoint | string | null>

function parseRequest(value: unknown): ProvisionerRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid request')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'op,userId' || typeof record.op !== 'string'
    || !OPERATIONS.some(op => op === record.op) || typeof record.userId !== 'string') {
    throw new Error('invalid request')
  }
  return { op: record.op as ProvisionerRequest['op'], userId: parseUserId(record.userId) }
}

/** Start the router-facing control socket; only the four fixed operations are accepted. */
export async function startProvisionerServer(path: string, handler: ProvisionerHandler,
  access?: SocketAccess): Promise<{ close(): Promise<void> }> {
  return startLineServer(path, async raw => handler(parseRequest(raw)), access)
}

/**
 * Default wait for `ensure`. A cold start can load the image archive into the account's store (the provisioner allows
 * that up to 15 minutes) and then wait twice `readyTimeoutMs`, so the client must not give up after the 10 s used for
 * the quick operations; the router keeps its own short `routeWaitMs` page bound on top of this.
 */
export const DEFAULT_ENSURE_TIMEOUT_MS = 1_200_000

/** Client options; only `ensure` waits for a start, every other operation keeps the short default. */
export interface ProvisionerClientOptions { readonly ensureTimeoutMs?: number }

/** Client for the four provisioner operations. */
export class ProvisionerClient {
  readonly ensureTimeoutMs: number
  constructor(readonly path: string, options: ProvisionerClientOptions = {}) {
    this.ensureTimeoutMs = options.ensureTimeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.ensureTimeoutMs) || this.ensureTimeoutMs <= 0) throw new Error('ensure timeout must be a positive integer')
  }

  /** Send one raw request; the server still rejects unknown fields and tags. */
  requestRaw(request: unknown, timeoutMs?: number): Promise<unknown> { return requestLine(this.path, request, timeoutMs) }

  /** Ensure one user runtime exists and return its private address; waits up to `ensureTimeoutMs` for a start. */
  async ensure(userId: UserId): Promise<InstanceEndpoint> {
    return parseInstanceEndpoint(await this.requestRaw({ op: 'ensure', userId }, this.ensureTimeoutMs))
  }

  /**
   * Fetch the instance's Web launch grant without logging it. The grant is not one-use: it is the instance's own launch
   * token, so it stays valid and repeated calls return the same value until the instance stops or restarts (a restart
   * issues a new one). It never reaches a browser; the router exchanges it for a session cookie.
   */
  async launchGrant(userId: UserId): Promise<string> {
    const result = await this.requestRaw({ op: 'launch-grant', userId })
    if (typeof result !== 'string' || !result) throw new Error('invalid launch grant')
    return result
  }

  /** Stop a user's runtime while retaining its stored data. */
  async stop(userId: UserId): Promise<void> {
    if (await this.requestRaw({ op: 'stop', userId }) !== null) throw new Error('invalid stop response')
  }

  /** Read the user's lifecycle status (`absent`, `running`, `suspended`, ...). */
  async status(userId: UserId): Promise<string> {
    const result = await this.requestRaw({ op: 'status', userId })
    if (typeof result !== 'string') throw new Error('invalid status response')
    return result
  }
}
