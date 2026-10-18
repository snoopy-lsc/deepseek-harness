/** Private control channel between the provisioner and the quota service; the router never reaches it. */
import { parseUserId, requestLine, startLineServer, type SocketAccess } from '@public-harness/contracts'
import type { QuotaService } from './service.ts'

const OPS = ['health', 'open', 'issue', 'close', 'open-job', 'close-job'] as const

function parse(raw: unknown): { op: typeof OPS[number]; userId?: ReturnType<typeof parseUserId>; instanceId?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid request')
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (record.op === 'health' && keys === 'op') return { op: 'health' }
  if (record.op === 'close' && keys === 'op,userId' && typeof record.userId === 'string') return { op: 'close', userId: parseUserId(record.userId) }
  if (record.op === 'close-job' && keys === 'instanceId,op' && typeof record.instanceId === 'string' && /^kbjob-[A-Za-z0-9_-]{1,120}$/.test(record.instanceId)) {
    return { op: 'close-job', instanceId: record.instanceId }
  }
  if ((record.op === 'open' || record.op === 'issue' || record.op === 'open-job') && keys === 'instanceId,op,userId' && typeof record.userId === 'string'
    && typeof record.instanceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(record.instanceId)) {
    return { op: record.op, userId: parseUserId(record.userId), instanceId: record.instanceId }
  }
  throw new Error('invalid request')
}

/** Serve `health`, `open`, `issue`, and `close` on an owner-only Unix socket. */
export function startQuotaControlServer(path: string, service: Pick<QuotaService, 'healthy' | 'open' | 'issue' | 'close'> & Partial<Pick<QuotaService, 'openJob' | 'closeJob'>>,
  access?: SocketAccess): ReturnType<typeof startLineServer> {
  return startLineServer(path, async raw => {
    const request = parse(raw)
    switch (request.op) {
      case 'health': return await service.healthy()
      case 'open': return service.open(request.userId!, request.instanceId!)
      case 'issue': return service.issue(request.userId!, request.instanceId!)
      case 'close': await service.close(request.userId!); return null
      case 'open-job':
        if (service.openJob === undefined || !request.instanceId!.startsWith('kbjob-')) throw new Error('invalid request')
        return service.openJob(request.userId!, request.instanceId!)
      case 'close-job': if (service.closeJob === undefined) throw new Error('invalid request'); await service.closeJob(request.instanceId!); return null
    }
  }, access)
}

/** Serve the knowledge base service's job socket: only `open-job`, `issue`, and `close-job`, and only for `kbjob-` channels.
 * A user's harness listener, its tokens, health, and closing a user stay on the provisioner's control socket. */
export function startQuotaJobServer(path: string, service: Pick<QuotaService, 'issue' | 'openJob' | 'closeJob'>, access?: SocketAccess): ReturnType<typeof startLineServer> {
  return startLineServer(path, async raw => {
    const request = parse(raw)
    if (!request.instanceId?.startsWith('kbjob-')) throw new Error('invalid request')
    switch (request.op) {
      case 'open-job': return service.openJob(request.userId!, request.instanceId)
      case 'issue': return service.issue(request.userId!, request.instanceId)
      case 'close-job': await service.closeJob(request.instanceId); return null
      default: throw new Error('invalid request')
    }
  }, access)
}

/** Client used by the provisioner (control socket) and the knowledge base service (job socket); satisfies the provisioner's `QuotaBridge` shape. */
export function createQuotaControlClient(path: string): {
  healthy(): Promise<boolean>
  open(userId: ReturnType<typeof parseUserId>, instanceId: string): Promise<{ readonly port: number }>
  issue(userId: ReturnType<typeof parseUserId>, instanceId: string): Promise<{ readonly token: string; readonly expiresAt: number }>
  close(userId: ReturnType<typeof parseUserId>): Promise<void>
  openJob(principal: ReturnType<typeof parseUserId>, instanceId: string): Promise<{ readonly port: number }>
  closeJob(instanceId: string): Promise<void>
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
    async openJob(userId, instanceId) {
      const result = await requestLine(path, { op: 'open-job', userId, instanceId }) as { port?: unknown }
      if (typeof result?.port !== 'number' || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('invalid quota response')
      return { port: result.port }
    },
    async closeJob(instanceId) { await requestLine(path, { op: 'close-job', instanceId }) },
  }
}
