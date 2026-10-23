/** B2: plugins control-socket HTTP — admin / me / internal / provisioner verbs. */
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openPluginsDb, type PluginsDb } from '../src/db.ts'
import { COMPANY_SCOPE_PREFIX } from '../src/schema.ts'
import { seedPluginLimits } from '../src/limits.ts'
import {
  buildPluginsControlRoutes,
  pluginsControlHandler,
  startPluginsControlServer,
  type PluginsControlServer,
} from '../src/control-server.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'

const roots: string[] = []
const opened: PluginsDb[] = []
const servers: Array<PluginsControlServer | { close(): Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of opened.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; db: PluginsDb; storeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-ctrl-'))
  roots.push(root)
  const db = openPluginsDb(join(root, 'plugins.sqlite'))
  opened.push(db)
  seedPluginLimits(db)
  return { root, db, storeDir: join(root, 'store') }
}

function writeUstar(files: { path: string; data: Buffer | string }[]): Buffer {
  const parts: Buffer[] = []
  const pad = (data: Buffer) => (data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))]))
  for (const file of files) {
    const data = typeof file.data === 'string' ? Buffer.from(file.data) : file.data
    const name = file.path.slice(0, 99)
    const block = Buffer.alloc(512)
    block.write(name, 0, 'utf8')
    block.write('0000644\0', 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    block.write('00000000000\0', 136, 'ascii')
    block.fill(0x20, 148, 156)
    block.write('0', 156, 'ascii')
    block.write('ustar\0', 257, 'ascii')
    block.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    parts.push(block, pad(data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function npmTgz(manifest: object): Buffer {
  return gzipSync(writeUstar([{ path: 'package/package.json', data: Buffer.from(JSON.stringify(manifest)) }]))
}

async function callUnix(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const reqHeaders: Record<string, string | number> = {
    host: 'plugins.invalid',
    ...headers,
  }
  if (payload !== undefined) {
    reqHeaders['content-type'] = 'application/json'
    reqHeaders['content-length'] = payload.byteLength
  }
  const req = httpRequest({
    socketPath,
    path,
    method,
    headers: reqHeaders,
  })
  const responsePromise = once(req, 'response') as Promise<[IncomingMessage]>
  if (payload !== undefined) req.write(payload)
  req.end()
  const [res] = await responsePromise
  const chunks: Buffer[] = []
  for await (const chunk of res) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown = text
  try { parsed = text === '' ? null : JSON.parse(text) } catch { /* keep text */ }
  return { status: res.statusCode ?? 0, body: parsed }
}

const ports = { min: 31_100, max: 31_109 }
const adminHeaders = {
  'x-dsh-user': 'admin-1',
  'x-dsh-email': 'admin@corp.example',
  'x-dsh-role': 'admin',
}
const memberHeaders = {
  'x-dsh-user': 'user-1',
  'x-dsh-email': 'user@corp.example',
  'x-dsh-role': 'member',
}

describe('plugins control route table', () => {
  it('exposes_admin_me_internal_and_control_keys', () => {
    const { db, storeDir } = fixture()
    const routes = buildPluginsControlRoutes({ db, storeDir, ports })
    const keys = Object.keys(routes).sort()
    for (const expected of [
      'POST /internal/audit/drain',
      'POST /internal/audit/ack',
      'POST /internal/principals',
      'POST /control/open',
      'POST /control/close',
      'POST /control/reconcile-plan',
      'GET /admin/plugins',
      'POST /admin/plugins/upload',
      'POST /admin/plugins/requests/approve',
      'POST /admin/plugins/requests/reject',
      'GET /admin/plugins/policy',
      'PUT /admin/plugins/policy',
      'GET /admin/plugins/limits',
      'PUT /admin/plugins/limits',
      'DELETE /admin/plugins/limits',
      'GET /me/plugins',
      'POST /me/plugins/submit',
      'POST /me/plugins/withdraw',
      'POST /me/plugins/defaults/reenable',
    ]) {
      expect(keys).toContain(expected)
    }
  })
})

describe('startPluginsControlServer endpoints', () => {
  it('open_close_upload_list_me_audit_policy_limits', async () => {
    const { root, db, storeDir } = fixture()
    const socketPath = join(root, 'control.sock')
    const control = await startPluginsControlServer(
      { db, storeDir, ports, hostAddress: '127.0.0.1' },
      { path: socketPath },
    )
    servers.push(control)

    const opened = await callUnix(socketPath, 'POST', '/control/open', {
      userId: 'user-1',
      instanceId: 'inst-1',
      accountUid: 2300,
    })
    expect(opened.status).toBe(200)
    const openBody = opened.body as { port: number; token: string }
    expect(openBody.port).toBeGreaterThanOrEqual(ports.min)
    expect(openBody.token.length).toBeGreaterThanOrEqual(32)

    const name = `${COMPANY_SCOPE_PREFIX}ctrl-demo`
    const tarball = npmTgz({ name, version: '1.0.0' }).toString('base64')
    const upload = await callUnix(socketPath, 'POST', '/admin/plugins/upload', {
      scope: { kind: 'company', target: '*' },
      tarball,
      closure: [],
      allowedBuilds: [],
    }, adminHeaders)
    expect(upload.status).toBe(200)
    const uploaded = upload.body as { packageId: string; versionId: string; name: string }
    expect(uploaded.name).toBe(name)

    const list = await callUnix(socketPath, 'GET', '/admin/plugins', undefined, adminHeaders)
    expect(list.status).toBe(200)
    const packages = (list.body as { packages: Array<{ name: string }> }).packages
    expect(packages.some(p => p.name === name)).toBe(true)

    const me = await callUnix(socketPath, 'GET', '/me/plugins', undefined, memberHeaders)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ submissions: expect.any(Array), defaults: expect.any(Array) })

    const policyGet = await callUnix(socketPath, 'GET', '/admin/plugins/policy', undefined, adminHeaders)
    expect(policyGet.status).toBe(200)

    const limitsGet = await callUnix(socketPath, 'GET', '/admin/plugins/limits', undefined, adminHeaders)
    expect(limitsGet.status).toBe(200)

    const drain = await callUnix(socketPath, 'POST', '/internal/audit/drain', {})
    expect(drain.status).toBe(200)
    const events = (drain.body as { events: Array<{ id: number }> }).events
    expect(events.length).toBeGreaterThan(0)
    const ack = await callUnix(socketPath, 'POST', '/internal/audit/ack', { upTo: events.at(-1)!.id })
    expect(ack.status).toBe(200)

    const closed = await callUnix(socketPath, 'POST', '/control/close', { instanceId: 'inst-1' })
    expect(closed.status).toBe(200)

    const memberAdmin = await callUnix(socketPath, 'GET', '/admin/plugins', undefined, memberHeaders)
    expect(memberAdmin.status).toBe(403)

    const missing = await callUnix(socketPath, 'GET', '/admin/plugins/nope', undefined, adminHeaders)
    expect(missing.status).toBe(404)
  })

  it('handler_requires_actor_headers_on_me_routes', async () => {
    const { db, storeDir } = fixture()
    const routes = buildPluginsControlRoutes({ db, storeDir, ports })
    const handler = pluginsControlHandler(routes)
    const server: Server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push({
      async close() {
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
      },
    })
    const address = server.address() as { port: number }
    const noActor = await fetch(`http://127.0.0.1:${address.port}/me/plugins`)
    expect(noActor.status).toBe(401)
  })
})
