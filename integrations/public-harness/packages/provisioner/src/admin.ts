/** Administrative control socket: never reachable by the router, only by root-owned operators. */
import { parseUserId, type UserId } from '@public-harness/contracts'
import { ProvisionerClient, startLineServer } from './protocol.ts'
import type { Lifecycle } from './reconcile.ts'

const USER_OPS = ['suspend', 'reactivate', 'request-deletion', 'confirm-deletion', 'delete'] as const
const GLOBAL_OPS = ['reconcile', 'idle-stop', 'status'] as const

/** One fixed administrative request. */
export type AdminRequest = { op: typeof USER_OPS[number]; userId: UserId } | { op: typeof GLOBAL_OPS[number] }

function parseAdmin(raw: unknown): AdminRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid request')
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if ((USER_OPS as readonly unknown[]).includes(record.op) && keys === 'op,userId' && typeof record.userId === 'string') {
    return { op: record.op as typeof USER_OPS[number], userId: parseUserId(record.userId) }
  }
  if ((GLOBAL_OPS as readonly unknown[]).includes(record.op) && keys === 'op') return { op: record.op as typeof GLOBAL_OPS[number] }
  throw new Error('invalid request')
}

/** Serve administrative operations on an owner-only Unix socket (root-only in production). */
export function startAdminServer(path: string, lifecycle: Lifecycle): ReturnType<typeof startLineServer> {
  return startLineServer(path, async raw => {
    const request = parseAdmin(raw)
    switch (request.op) {
      case 'suspend': await lifecycle.suspend(request.userId); return null
      case 'reactivate': await lifecycle.reactivate(request.userId); return null
      case 'request-deletion': await lifecycle.requestDeletion(request.userId); return null
      case 'confirm-deletion': await lifecycle.confirmDeletion(request.userId); return null
      case 'delete': await lifecycle.deleteUser(request.userId); return null
      case 'reconcile': return lifecycle.reconcile()
      case 'idle-stop': return (await lifecycle.idleStop()).length
      case 'status': return 'ok'
    }
  })
}

/** Client for the administrative socket (used by the operator CLI). */
export class AdminClient extends ProvisionerClient {
  async userOperation(op: typeof USER_OPS[number], userId: UserId): Promise<void> {
    if (await this.requestRaw({ op, userId }) !== null) throw new Error('invalid admin response')
  }
  reconcile(): Promise<unknown> { return this.requestRaw({ op: 'reconcile' }) }
}
