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

/** Client for the four provisioner operations. */
export class ProvisionerClient {
  constructor(readonly path: string) {}

  /** Send one raw request; the server still rejects unknown fields and tags. */
  requestRaw(request: unknown): Promise<unknown> { return requestLine(this.path, request) }

  /** Ensure one user runtime exists and return its private address. */
  async ensure(userId: UserId): Promise<InstanceEndpoint> {
    return parseInstanceEndpoint(await this.requestRaw({ op: 'ensure', userId }))
  }

  /** Fetch the current one-use Web launch grant without logging it. */
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
