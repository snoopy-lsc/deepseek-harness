/** Private control channel between the provisioner and the quota service; the router never reaches it. */
import { parseUserId, requestLine, startLineServer, type SocketAccess } from '@public-harness/contracts'
import type { QuotaService } from './service.ts'

const OPS = ['health', 'open', 'issue', 'close'] as const

function parse(raw: unknown): { op: typeof OPS[number]; userId?: ReturnType<typeof parseUserId>; instanceId?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid request')
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.op === 'health' && keys === 'op') return { op: 'health' }
  if (record.op === 'close' && keys === 'op,userId' && typeof record.userId === 'string') return { op: 'close', userId: parseUserId(record.userId) }
  if ((record.op === 'open' || record.op === 'issue') && keys === 'instanceId,op,userId' && typeof record.userId === 'string'
    && typeof record.instanceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(record.instanceId)) {
    return { op: record.op, userId: parseUserId(record.userId), instanceId: record.instanceId }
  }
  throw new Error('invalid request')
}

/** Serve `health`, `open`, `issue`, and `close` on an owner-only Unix socket. */
export function startQuotaControlServer(path: string, service: Pick<QuotaService, 'healthy' | 'open' | 'issue' | 'close'>,
  access?: SocketAccess): ReturnType<typeof startLineServer> {
  return startLineServer(path, async raw => {
    const request = parse(raw)
    switch (request.op) {
      case 'health': return await service.healthy()
      case 'open': return service.open(request.userId!, request.instanceId!)
      case 'issue': return service.issue(request.userId!, request.instanceId!)
      case 'close': await service.close(request.userId!); return null
    }
  }, access)
}

/** Client used by the provisioner; satisfies its `QuotaBridge` shape. */
export function createQuotaControlClient(path: string): {
  healthy(): Promise<boolean>
  open(userId: ReturnType<typeof parseUserId>, instanceId: string): Promise<{ readonly port: number }>
  issue(userId: ReturnType<typeof parseUserId>, instanceId: string): Promise<{ readonly token: string; readonly expiresAt: number }>
  close(userId: ReturnType<typeof parseUserId>): Promise<void>
} {
  return {
    async healthy() { return await requestLine(path, { op: 'health' }) === true },
    async open(userId, instanceId) {
      const result = await requestLine(path, { op: 'open', userId, instanceId }) as { port?: unknown }
      if (typeof result?.port !== 'number' || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('invalid quota response')
      return { port: result.port }
    },
    async issue(userId, instanceId) {
      const result = await requestLine(path, { op: 'issue', userId, instanceId }) as { token?: unknown; expiresAt?: unknown }
      if (typeof result?.token !== 'string' || typeof result.expiresAt !== 'number') throw new Error('invalid quota response')
      return { token: result.token, expiresAt: result.expiresAt }
    },
    async close(userId) { await requestLine(path, { op: 'close', userId }) },
  }
}
