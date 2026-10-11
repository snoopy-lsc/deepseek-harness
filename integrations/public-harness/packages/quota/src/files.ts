/** Private file ownership and bounded DeepSeek Files forwarding. */
import { randomUUID } from 'node:crypto'
import { chmodSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UserId } from '@public-harness/contracts'

/** Limits and pinned upstream for one platform-funded Files service. */
export interface FilesProxyConfig {
  readonly databasePath: string
  readonly upstreamRoot: string
  readonly platformKey: string
  readonly maxUploadBytes: number
  readonly maxFilesPerUser: number
  readonly maxMetadataBytes: number
  readonly maxListLimit: number
  readonly fetcher?: typeof fetch
}

/** User-scoped Files operations used by the quota HTTP server. */
export interface FilesProxy {
  handle(userId: UserId, request: Request): Promise<Response>
  owns(userId: UserId, fileId: string): boolean
  close(): void
}

interface FileMetadata {
  id: string
  type: 'file'
  mime_type: string
  size_bytes: number
  filename: string
  created_at: string
}

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
}

async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('body exceeds limit')
      chunks.push(value)
    }
    return Buffer.concat(chunks, total)
  } finally { reader.releaseLock() }
}

function metadata(value: unknown): FileMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid upstream file metadata')
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)
    || row.type !== 'file' || typeof row.mime_type !== 'string'
    || typeof row.size_bytes !== 'number' || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0
    || typeof row.filename !== 'string' || !row.filename || typeof row.created_at !== 'string'
    || !Number.isFinite(Date.parse(row.created_at))) throw new Error('invalid upstream file metadata')
  return { id: row.id, type: 'file', mime_type: row.mime_type, size_bytes: row.size_bytes,
    filename: row.filename, created_at: row.created_at }
}

/** Create a proxy that never forwards caller-selected origins or another user's file ID. */
export function createFilesProxy(config: FilesProxyConfig): FilesProxy {
  for (const [name, value] of Object.entries(config)) {
    if (name.startsWith('max')) positive(name, Number(value))
  }
  const root = new URL(config.upstreamRoot)
  if (!((root.protocol === 'https:') || (root.protocol === 'http:' && root.hostname === '127.0.0.1'))
    || !root.pathname.endsWith('/v1') || root.search || root.hash || root.username || root.password || !config.platformKey) {
    throw new Error('invalid pinned Files upstream configuration')
  }
  if (!isAbsolute(config.databasePath) || config.databasePath.includes('\0')) throw new Error('Files database path must be absolute')
  if (process.platform !== 'win32' && (statSync(dirname(config.databasePath)).mode & 0o077) !== 0) {
    throw new Error('Files database parent must be private')
  }
  const database = new DatabaseSync(config.databasePath)
  if (process.platform !== 'win32') chmodSync(config.databasePath, 0o600)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
    mime_type TEXT, size_bytes INTEGER, filename TEXT, created_at TEXT
  ) STRICT`)
  database.exec('CREATE INDEX IF NOT EXISTS files_user ON files(user_id, state, id)')
  database.prepare("DELETE FROM files WHERE state = 'pending'").run()
  const fetcher = config.fetcher ?? fetch
  let closed = false
  const checkOpen = (): void => { if (closed) throw new Error('Files proxy is closed') }
  const owned = (userId: UserId, id: string): FileMetadata | undefined => {
    const row = database.prepare("SELECT id, mime_type, size_bytes, filename, created_at FROM files WHERE id = ? AND user_id = ? AND state = 'live'").get(id, userId)
    if (row === undefined) return undefined
    return metadata({ ...row, type: 'file' })
  }
  const reserve = (userId: UserId): string | undefined => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const count = database.prepare('SELECT COUNT(*) AS value FROM files WHERE user_id = ?').get(userId)?.['value']
      if (typeof count !== 'number') throw new Error('invalid Files database count')
      if (count >= config.maxFilesPerUser) { database.exec('ROLLBACK'); return undefined }
      const id = `pending_${randomUUID()}`
      database.prepare("INSERT INTO files (id, user_id, state) VALUES (?, ?, 'pending')").run(id, userId)
      database.exec('COMMIT')
      return id
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  const upstream = async (path: string, request: Request, body?: Buffer): Promise<Response> => {
    const headers: Record<string, string> = { 'x-api-key': config.platformKey }
    for (const key of ['content-type', 'anthropic-version', 'anthropic-beta']) {
      const value = request.headers.get(key)
      if (value !== null) headers[key] = value
    }
    return await fetcher(`${root.href.replace(/\/$/, '')}${path}`, { method: request.method,
      ...body === undefined ? {} : { body: Uint8Array.from(body) }, headers, redirect: 'manual', signal: request.signal })
  }
  return {
    async handle(userId, request) {
      checkOpen()
      const url = new URL(request.url)
      const pathname = url.pathname
      if (pathname === '/v1/files' && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'after_id' && key !== 'limit')) return new Response(null, { status: 400 })
        const after = url.searchParams.get('after_id')
        const limitText = url.searchParams.get('limit')
        const limit = limitText === null ? config.maxListLimit : Number(limitText)
        if ((after !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(after))
          || !Number.isSafeInteger(limit) || limit < 1 || limit > config.maxListLimit) return new Response(null, { status: 400 })
        if (after !== null && owned(userId, after) === undefined) return new Response(null, { status: 404 })
        const rows = database.prepare("SELECT id, mime_type, size_bytes, filename, created_at FROM files WHERE user_id = ? AND state = 'live' AND id > ? ORDER BY id LIMIT ?")
          .all(userId, after ?? '', limit + 1)
        const data = rows.slice(0, limit).map(row => metadata({ ...row, type: 'file' }))
        return Response.json({ data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null,
          has_more: rows.length > limit })
      }
      if (pathname === '/v1/files' && request.method === 'POST') {
        let body: Buffer
        try { body = await boundedBody(request.body, config.maxUploadBytes) }
        catch { return new Response(null, { status: 413 }) }
        const pending = reserve(userId)
        if (pending === undefined) return new Response(null, { status: 429 })
        try {
          const response = await upstream('/files', request, body)
          if (!response.ok || response.status >= 300) return new Response(null, { status: 502 })
          const value = metadata(JSON.parse((await boundedBody(response.body, config.maxMetadataBytes)).toString('utf8')))
          database.prepare("UPDATE files SET id = ?, state = 'live', mime_type = ?, size_bytes = ?, filename = ?, created_at = ? WHERE id = ? AND user_id = ?")
            .run(value.id, value.mime_type, value.size_bytes, value.filename, value.created_at, pending, userId)
          return Response.json(value)
        } catch { return new Response(null, { status: 502 }) }
        finally { database.prepare("DELETE FROM files WHERE id = ? AND state = 'pending'").run(pending) }
      }
      const match = /^\/v1\/files\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)
      if (match === null || url.search || !['GET', 'DELETE'].includes(request.method)) return new Response(null, { status: 404 })
      const id = match[1]!
      const value = owned(userId, id)
      if (value === undefined) return new Response(null, { status: 404 })
      if (request.method === 'GET') return Response.json(value)
      try {
        const response = await upstream(`/files/${encodeURIComponent(id)}`, request)
        if (!response.ok || response.status >= 300) return new Response(null, { status: 502 })
        database.prepare("DELETE FROM files WHERE id = ? AND user_id = ? AND state = 'live'").run(id, userId)
        return Response.json({ id, type: 'file_deleted' })
      } catch { return new Response(null, { status: 502 }) }
    },
    owns(userId, fileId) { checkOpen(); return owned(userId, fileId) !== undefined },
    close() { if (closed) return; closed = true; database.close() },
  }
}
