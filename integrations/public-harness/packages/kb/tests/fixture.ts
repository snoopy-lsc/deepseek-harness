/** Test fixture: a temporary KB root and storage root, the development helper runner, and a socket client that plays identity. */
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectRunner, devUserTrees, startKbService, type JobOptions, type KbService } from '../src/index.ts'
import type { KbCore } from '../src/service.ts'
import type { KbRoutes } from '../src/server.ts'

export interface Reply { status: number; body: any }
export interface Site {
  dir: string; root: string; storage: string; socket: string; service: KbService
  as(userId: string, role?: 'admin' | 'member'): {
    get(path: string): Promise<Reply>
    post(path: string, body?: unknown): Promise<Reply>
    put(path: string, body?: unknown): Promise<Reply>
    del(path: string, body?: unknown): Promise<Reply>
    upload(path: string, data: Buffer): Promise<Reply>
  }
  internal(path: string, body: unknown): Promise<Reply>
  close(): Promise<void>
}

export function call(socketPath: string, method: string, path: string, headers: Record<string, string>, payload?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: payload === undefined ? headers : { ...headers, 'content-length': String(payload.length) } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try { body = JSON.parse(text) } catch { /* raw */ }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.once('error', reject); req.end(payload)
  })
}

export async function site(options: { clock?: () => number; extra?: Array<(core: KbCore) => KbRoutes>; jobs?: JobOptions } = {}): Promise<Site> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kb-'))
  const root = join(dir, 'kb'), storage = join(dir, 'storage'), socket = join(dir, 'kb.sock')
  const service = await startKbService({ root, socket, users: devUserTrees(storage), runner: createDirectRunner(), ...options.clock ? { clock: options.clock } : {}, ...options.jobs ? { jobs: options.jobs } : {} }, options.extra ?? [])
  const json = (body: unknown) => body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    dir, root, storage, socket, service,
    as(userId, role = 'member') {
      const headers = { 'x-dsh-user': userId, 'x-dsh-email': `${userId}@example.test`, 'x-dsh-role': role }
      const write = (method: string) => (path: string, body?: unknown) => call(socket, method, path, { ...headers, 'content-type': 'application/json' }, json(body ?? {}))
      return { get: path => call(socket, 'GET', path, headers), post: write('POST'), put: write('PUT'), del: write('DELETE'),
        upload: (path, data) => call(socket, 'POST', path, { ...headers, 'content-type': 'application/octet-stream' }, data) }
    },
    internal: (path, body) => call(socket, 'POST', path, { 'content-type': 'application/json' }, json(body)),
    async close() { await service.close(); await rm(dir, { recursive: true, force: true }) },
  }
}
