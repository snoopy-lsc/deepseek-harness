/** Browser content reads use the owner's committed tree or the current in-scope publication. */
import { execFileSync } from 'node:child_process'
import { chmod, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { site, type Site } from './fixture.ts'

const open: Site[] = []
afterEach(async () => { for (const s of open.splice(0)) await s.close() })
async function start() {
  const s = await site(); open.push(s)
  await s.internal('/internal/principals', { users: [{ userId: 'alice', groups: [] }, { userId: 'bob', groups: ['local:readers'] }, { userId: 'root', groups: [] }] })
  return s
}
const content = (kb: string, path?: string) => `/me/kb/content?kb=${kb}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`
const repository = (s: Site, kb: string) => join(s.storage, 'users', 'alice', 'kb', kb)
function commit(s: Site, kb: string) {
  const dir = repository(s, kb)
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Update pages'])
}
async function personal(s: Site) {
  const kb = (await s.as('alice').post('/me/kb', { title: 'Team knowledge' })).body.kb
  await s.as('alice').upload(`/me/kb/sources?kb=${kb.id}&name=notes.txt`, Buffer.from('private source'))
  return kb
}
async function publish(s: Site, kb: string, includeRaw = false) {
  const request = (await s.as('alice').post('/me/kb/share', { kb })).body.request
  const reply = await s.as('root', 'admin').post('/admin/kb/requests/approve', { id: request.id, scope: [{ kind: 'group', target: 'local:readers' }], includeRaw })
  expect(reply.status).toBe(200)
  return reply.body
}

describe('personal knowledge content', () => {
  it('lists approved file paths at a pinned HEAD and previews only committed owner bytes', async () => {
    const s = await start(), kb = await personal(s), me = s.as('alice')
    const listing = await me.get(content(kb.id))
    expect(listing.status).toBe(200)
    expect(listing.body).toMatchObject({ readOnly: false, revision: expect.stringMatching(/^[a-f0-9]{40,64}$/), files: expect.arrayContaining([{ path: 'raw/notes.txt', bytes: 14 }]) })
    expect(Object.keys(listing.body).sort()).toEqual(['files', 'readOnly', 'revision'])
    expect((await me.get(content(kb.id, 'raw/notes.txt'))).body).toMatchInlineSnapshot(`
      {
        "bytes": 14,
        "path": "raw/notes.txt",
        "text": "private source",
        "truncated": false,
      }
    `)
    await writeFile(join(repository(s, kb.id), 'raw', 'notes.txt'), 'uncommitted secret')
    expect((await me.get(content(kb.id, 'raw/notes.txt'))).body.text).toBe('private source')
    expect((await me.get(content(kb.id))).body.revision).toBe(listing.body.revision)
    commit(s, kb.id)
    expect((await me.get(content(kb.id, 'raw/notes.txt'))).body.text).toBe('uncommitted secret')
    expect((await me.get(content(kb.id))).body.revision).not.toBe(listing.body.revision)
  })

  it('never lets another member or administrator read unpublished personal content', async () => {
    const s = await start(), kb = await personal(s)
    for (const user of [s.as('bob'), s.as('root', 'admin')]) for (const path of [content(kb.id), content(kb.id, 'raw/notes.txt')]) expect((await user.get(path)).status).toBe(404)
    expect((await s.as('alice').get(content('kb_aaaaaaaaaaaaaaaa'))).status).toBe(404)
  })

  it('reads only current publications, never pending drafts or a caller selected revision', async () => {
    const s = await start(), kb = await personal(s), me = s.as('alice'), bob = s.as('bob')
    const published = await publish(s, kb.id)
    const listing = await bob.get(content(kb.id))
    expect(listing.body).toMatchObject({ readOnly: true, revision: published.snapshotId })
    expect(listing.body.files.some((f: { path: string }) => f.path.startsWith('raw/'))).toBe(false)
    const original = (await bob.get(content(kb.id, 'index.md'))).body.text
    await writeFile(join(repository(s, kb.id), 'index.md'), '# Draft replacement')
    const pending = (await me.post('/me/kb/share', { kb: kb.id })).body.request
    expect((await bob.get(content(kb.id, 'index.md'))).body.text).toBe(original)
    expect((await bob.get(content(kb.id, 'raw/notes.txt'))).status).toBe(404)
    for (const revision of [pending.commitSha, 'HEAD', published.snapshotId]) expect((await bob.get(`${content(kb.id, 'index.md')}&rev=${revision}`)).status).toBe(400)
    await s.as('root', 'admin').post('/admin/kb/requests/approve', { id: pending.id, scope: [{ kind: 'group', target: 'local:readers' }], includeRaw: true })
    expect((await bob.get(content(kb.id, 'index.md'))).body.text).toBe('# Draft replacement')
    expect((await bob.get(content(kb.id, 'raw/notes.txt'))).body.text).toBe('private source')
    expect((await bob.get(content(kb.id))).body.revision).not.toBe(published.snapshotId)
    expect((await me.get(content(kb.id))).body.readOnly).toBe(false)
  })

  it('applies revoke, scope changes and disabled principals on every content request', async () => {
    const s = await start(), kb = await personal(s), bob = s.as('bob'), admin = s.as('root', 'admin')
    await publish(s, kb.id)
    expect((await bob.get(content(kb.id, 'index.md'))).status).toBe(200)
    s.service.core.store.principals.upsert({ userId: 'bob', groups: [], disabled: false, email: 'bob@example.test' }, Date.now())
    expect((await bob.get(content(kb.id))).status).toBe(404)
    s.service.core.store.principals.upsert({ userId: 'bob', groups: ['local:readers'], disabled: true, email: 'bob@example.test' }, Date.now())
    expect((await bob.get(content(kb.id, 'index.md'))).status).toBe(404)
    s.service.core.store.principals.upsert({ userId: 'bob', groups: ['local:readers'], disabled: false, email: 'bob@example.test' }, Date.now())
    await admin.post('/admin/kb/scope', { kb: kb.id, scope: [{ kind: 'user', target: 'alice' }] })
    expect((await bob.get(content(kb.id, 'index.md'))).status).toBe(404)
    await admin.post('/admin/kb/scope', { kb: kb.id, scope: [{ kind: 'company' }] })
    expect((await bob.get(content(kb.id, 'index.md'))).status).toBe(200)
    await admin.post('/admin/kb/revoke', { kb: kb.id })
    expect((await bob.get(content(kb.id, 'index.md'))).status).toBe(404)
    expect((await s.as('alice').get(content(kb.id, 'index.md'))).status).toBe(200)
  })

  it('gives org readers published bytes and never exposes their draft HEAD even to an admin', async () => {
    const s = await start(), admin = s.as('root', 'admin'), bob = s.as('bob')
    const kb = (await admin.post('/admin/kb/org', { title: 'Handbook' })).body.kb
    expect((await admin.get(content(kb.id))).status).toBe(404)
    await admin.post('/admin/kb/org/rollback', { kb: kb.id, scope: [{ kind: 'company' }] })
    const original = (await bob.get(content(kb.id, 'index.md'))).body.text
    await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'index.md', text: '# Unpublished handbook' })
    expect((await admin.get(content(kb.id, 'index.md'))).body).toEqual({ path: 'index.md', bytes: Buffer.byteLength(original), text: original, truncated: false })
    expect((await bob.get(content(kb.id))).body.readOnly).toBe(true)
    await admin.post('/admin/kb/org/archive', { kb: kb.id })
    expect((await bob.get(content(kb.id))).status).toBe(404)
  })

  it('validates paths before helpers, returns binary as null and caps text previews', async () => {
    const s = await start(), kb = await personal(s), me = s.as('alice')
    for (const path of ['../kb.sqlite', '/etc/passwd', 'raw/../../index.md', 'raw\\notes.txt', 'raw//notes.txt', 'raw/./notes.txt', 'raw/a\u0000.md', 'raw/notes.txt/', '.git/config']) expect([400, 404]).toContain((await me.get(content(kb.id, path))).status)
    expect((await me.get(`${content(kb.id)}&path=%252e%252e%252fkb.sqlite`)).status).toBe(404)
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=large.txt`, Buffer.alloc(256 * 1024 + 5, 'A'))
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=source.pdf`, Buffer.from('%PDF-1.7 binary'))
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=fake.md`, Buffer.from([0, 255, 254]))
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=source.html`, Buffer.from('<script>alert(1)</script><p>Hello</p>'))
    const large = await me.get(content(kb.id, 'raw/large.txt'))
    expect(large.body).toMatchObject({ bytes: 256 * 1024 + 5, truncated: true }); expect(Buffer.byteLength(large.body.text)).toBeLessThanOrEqual(256 * 1024)
    expect((await me.get(content(kb.id, 'raw/source.pdf'))).body).toMatchObject({ text: null, truncated: false })
    expect((await me.get(content(kb.id, 'raw/fake.md'))).body).toMatchObject({ text: null, truncated: false })
    expect((await me.get(content(kb.id, 'raw/source.html'))).body).toMatchObject({ text: '<script>alert(1)</script><p>Hello</p>', truncated: false })
    expect((await me.get(content(kb.id, 'missing.md'))).status).toBe(404)
  })

  it('never follows a committed personal symlink or a published tree symlink', async () => {
    const s = await start(), kb = await personal(s), me = s.as('alice')
    const published = await publish(s, kb.id, true)
    await symlink('/etc/passwd', join(repository(s, kb.id), 'raw', 'escape.md')); commit(s, kb.id)
    const own = await me.get(content(kb.id, 'raw/escape.md'))
    expect(own.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(own.body)).not.toContain('root:')
    const publishedRaw = join(s.root, 'published', kb.id, published.snapshotId, 'raw')
    await chmod(publishedRaw, 0o755)
    await symlink('/etc/passwd', join(publishedRaw, 'escape.md'))
    expect((await s.as('bob').get(content(kb.id, 'raw/escape.md'))).status).toBe(404)
    const files = (await s.as('bob').get(content(kb.id))).body.files
    expect(files.some((f: { path: string }) => f.path === 'raw/escape.md')).toBe(false)
  })

  it('audits successful reads without recording any file text or requested path', async () => {
    const s = await start(), kb = await personal(s)
    await s.as('alice').get(content(kb.id, 'raw/notes.txt'))
    const events = s.service.core.store.audit.pending().filter(e => e.event === 'kb-content-read')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ userId: 'alice', actor: 'alice@example.test', outcome: 'ok' })
    expect(events[0]!.detail).toContain(kb.id)
    expect(events[0]!.detail).not.toContain('private source'); expect(events[0]!.detail).not.toContain('notes.txt')
  })
})
