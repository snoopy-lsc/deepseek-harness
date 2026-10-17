/** Phase 3: share requests (pinned commit, replacement, withdraw, expiry), the admin queue with content and diff, approve with scope and
 * the raw option, reject with a reason, scope change, revoke, and per-user hard-link views following scopes and group changes. */
import { execFileSync } from 'node:child_process'
import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { site, type Site } from './fixture.ts'

const open: Site[] = []
afterEach(async () => { for (const s of open.splice(0)) await s.close() })
let now = 1_800_000_000_000
const start = async () => { const s = await site({ clock: () => now }); open.push(s); return s }
const git = (s: Site, user: string, kb: string, ...args: string[]) => execFileSync('git', ['--git-dir', join(s.storage, 'users', user, 'kb', kb, '.git'), '--work-tree', join(s.storage, 'users', user, 'kb', kb), ...args], { encoding: 'utf8' }).trim()

async function people(s: Site) {
  await s.internal('/internal/principals', { users: [
    { userId: 'alice', groups: [], email: 'alice@example.test' }, { userId: 'bob', groups: ['wecom:7', 'wecom:1'], email: 'bob@example.test' },
    { userId: 'carol', groups: ['wecom:9'], email: 'carol@example.test' }, { userId: 'root', groups: [], email: 'root@example.test' }] })
}
async function sharedKb(s: Site, title = 'Ops notes', user = 'alice') {
  const me = s.as(user)
  const kb = (await me.post('/me/kb', { title })).body.kb
  await me.upload(`/me/kb/sources?kb=${kb.id}&name=deploy.md`, Buffer.from('# Deploy\nNightly.'))
  return { me, kb }
}
const viewOf = (s: Site, user: string) => join(s.root, 'views', user)

describe('share requests', () => {
  it('pins_head_committing_a_dirty_tree_and_a_new_request_replaces_the_pending_one', async () => {
    const s = await start(); await people(s)
    const { me, kb } = await sharedKb(s)
    await writeFile(join(s.storage, 'users', 'alice', 'kb', kb.id, 'wiki', 'manual.md'), '# Manual\nWritten by hand.\n')
    const first = (await me.post('/me/kb/share', { kb: kb.id, note: 'please review' })).body.request
    expect(first).toMatchObject({ state: 'pending', note: 'please review', commitSha: git(s, 'alice', kb.id, 'rev-parse', 'HEAD') })
    expect(git(s, 'alice', kb.id, 'log', '-1', '--format=%s')).toBe('Commit before share request')
    const sub = join(s.root, 'submissions', first.id)
    expect((await stat(join(sub, 'wiki', 'manual.md'))).mode & 0o777).toBe(0o444)
    expect((await stat(join(sub, 'wiki'))).mode & 0o777).toBe(0o555)
    expect((await me.get('/me/kb')).body.kbs[0].share).toMatchObject({ state: 'pending', requestId: first.id })
    const second = (await me.post('/me/kb/share', { kb: kb.id })).body.request
    expect(s.service.core.store.requests.get(first.id)!.state).toBe('withdrawn')
    expect(await lstat(sub).catch(() => undefined)).toBeUndefined()
    expect((await me.post('/me/kb/share/withdraw', { kb: kb.id })).body).toEqual({ withdrawn: second.id })
    expect((await me.post('/me/kb/share/withdraw', { kb: kb.id })).status).toBe(409)
    expect((await s.as('bob').post('/me/kb/share', { kb: kb.id })).status).toBe(404)
    const events = (await s.internal('/internal/audit/drain', {})).body.events.map((e: any) => e.event)
    expect(events.filter((e: string) => e.startsWith('kb-share'))).toEqual(['kb-share-request', 'kb-share-request', 'kb-share-withdraw'])
  })

  it('expires_old_pending_requests_and_purges_their_submissions', async () => {
    const s = await start(); await people(s)
    const { me, kb } = await sharedKb(s)
    const req = (await me.post('/me/kb/share', { kb: kb.id })).body.request
    now += 31 * 24 * 3_600_000
    expect((await s.as('root', 'admin').get('/admin/kb/requests')).body.requests).toEqual([])
    expect(s.service.core.store.requests.get(req.id)!.state).toBe('expired')
    expect(await lstat(join(s.root, 'submissions', req.id)).catch(() => undefined)).toBeUndefined()
  })
})

describe('approval and views', () => {
  it('lists_reviews_and_approves_into_an_immutable_snapshot_and_hard_link_views_by_scope', async () => {
    const s = await start(); await people(s)
    const { me, kb } = await sharedKb(s)
    const admin = s.as('root', 'admin')
    expect((await s.as('bob').get('/admin/kb/requests')).status).toBe(403)
    const req = (await me.post('/me/kb/share', { kb: kb.id, note: 'v1' })).body.request
    const queue = (await admin.get('/admin/kb/requests')).body.requests
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ id: req.id, kb: { id: kb.id, title: 'Ops notes', ownerEmail: 'alice@example.test' }, submittedByEmail: 'alice@example.test', current: null })
    expect(queue[0].files).toBeGreaterThan(3)
    const content = (await admin.get(`/admin/kb/requests/content?id=${req.id}`)).body
    expect(content.files.find((f: any) => f.path === 'raw/deploy.md')).toMatchObject({ status: 'added' })
    expect(content.log).toContain('# Log')
    const file = (await admin.get(`/admin/kb/requests/content?id=${req.id}&path=raw/deploy.md`)).body
    expect(file).toMatchObject({ path: 'raw/deploy.md', text: '# Deploy\nNightly.', previous: null, binary: false })
    expect((await admin.get(`/admin/kb/requests/content?id=${req.id}&path=../kb.sqlite`)).status).toBe(404)

    expect((await admin.post('/admin/kb/requests/approve', { id: req.id, scope: [{ kind: 'group', target: 'nope' }] })).status).toBe(400)
    expect((await admin.post('/admin/kb/requests/approve', { id: req.id, scope: [{ kind: 'user', target: 'ghost' }] })).status).toBe(400)
    const approved = (await admin.post('/admin/kb/requests/approve', { id: req.id, scope: [{ kind: 'group', target: 'wecom:7' }], includeRaw: false })).body
    expect(approved.scope).toEqual([{ kind: 'group', target: 'wecom:7' }])
    const snap = join(s.root, 'published', kb.id, approved.snapshotId)
    expect(await lstat(join(snap, 'raw')).catch(() => undefined)).toBeUndefined()
    expect((await stat(join(snap, 'index.md'))).mode & 0o777).toBe(0o444)
    // Bob is in wecom:7 and sees it as hard links to the snapshot; Carol and Alice do not.
    const bobIndex = join(viewOf(s, 'bob'), 'ops-notes', 'index.md')
    expect((await stat(bobIndex)).ino).toBe((await stat(join(snap, 'index.md'))).ino)
    expect(await readdir(viewOf(s, 'carol')).catch(() => [])).toEqual([])
    expect((await s.as('bob').get('/me/kb/shared')).body.kbs).toEqual([{ id: kb.id, title: 'Ops notes', kind: 'personal', owner: 'alice@example.test', publishedAt: now, path: '~/kb/shared/ops-notes' }])
    expect((await me.get('/me/kb')).body.kbs[0].share).toMatchObject({ state: 'published', scope: [{ kind: 'group', target: 'wecom:7' }] })

    // Later author edits do not reach readers; a newer request keeps the publication active until approved.
    await writeFile(join(s.storage, 'users', 'alice', 'kb', kb.id, 'index.md'), '# Changed\n')
    const req2 = (await me.post('/me/kb/share', { kb: kb.id })).body.request
    expect(await readFile(bobIndex, 'utf8')).not.toContain('# Changed')
    const diff = (await admin.get(`/admin/kb/requests/content?id=${req2.id}`)).body
    expect(diff.files.find((f: any) => f.path === 'index.md').status).toBe('changed')
    expect(diff.files.find((f: any) => f.path === 'raw/deploy.md').status).toBe('added')
    expect(diff.request.current.snapshotId).toBe(approved.snapshotId)
    const text = (await admin.get(`/admin/kb/requests/content?id=${req2.id}&path=index.md`)).body
    expect(text.text).toBe('# Changed\n'); expect(text.previous).toContain('# Ops notes')
    expect((await admin.post('/admin/kb/requests/reject', { id: req2.id, reason: '' })).status).toBe(400)
    await admin.post('/admin/kb/requests/reject', { id: req2.id, reason: 'Index is empty' })
    expect((await me.get('/me/kb')).body.kbs[0].share).toMatchObject({ state: 'published' })
    expect(s.service.core.store.requests.get(req2.id)).toMatchObject({ state: 'rejected', reason: 'Index is empty' })

    // Scope change moves the view from Bob to Carol; revoke removes it.
    await admin.post('/admin/kb/scope', { kb: kb.id, scope: [{ kind: 'user', target: 'carol' }] })
    expect(await readdir(viewOf(s, 'bob'))).toEqual([])
    expect(await readdir(viewOf(s, 'carol'))).toEqual(['ops-notes'])
    await admin.post('/admin/kb/revoke', { kb: kb.id })
    expect(await readdir(viewOf(s, 'carol'))).toEqual([])
    expect((await me.get('/me/kb')).body.kbs[0].share).toMatchObject({ state: 'revoked' })
    expect((await admin.post('/admin/kb/revoke', { kb: kb.id })).status).toBe(409)
    const events = (await s.internal('/internal/audit/drain', {})).body.events
    const admins = events.filter((e: any) => e.event.startsWith('admin-kb')).map((e: any) => `${e.event} ${e.detail.replace(/(req|snap)_[a-z2-7]+/g, '$1').replace(kb.id, 'kb')}`)
    expect(admins).toEqual(['admin-kb-content-read kb=kb req=req path=raw/deploy.md', 'admin-kb-approve kb=kb req=req snap=snap scope=groups:1,users:0 raw=0',
      'admin-kb-content-read kb=kb req=req path=index.md', 'admin-kb-reject kb=kb req=req', 'admin-kb-scope-change kb=kb scope=groups:0,users:1', 'admin-kb-revoke kb=kb'])
    expect(events.filter((e: any) => e.event === 'kb-view-apply').length).toBeGreaterThanOrEqual(4)
  })

  it('follows_group_changes_disabled_users_raw_option_and_name_collisions', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    const a = await sharedKb(s, 'Runbooks', 'alice'), b = await sharedKb(s, 'Runbooks', 'bob')
    for (const { me, kb } of [a, b]) {
      const req = (await me.post('/me/kb/share', { kb: kb.id })).body.request
      await admin.post('/admin/kb/requests/approve', { id: req.id, scope: [{ kind: 'company' }], includeRaw: true })
    }
    const names = await readdir(viewOf(s, 'carol'))
    expect(names).toHaveLength(2); expect(names).toContain('runbooks')
    expect(names.find(n => n !== 'runbooks')).toMatch(/^runbooks-[a-z2-7]{6}$/)
    expect(await readFile(join(viewOf(s, 'carol'), 'runbooks', 'raw', 'deploy.md'), 'utf8')).toBe('# Deploy\nNightly.')
    // Narrow to a group; Carol joins it later through a principal push; disabling her empties the view.
    await admin.post('/admin/kb/scope', { kb: a.kb.id, scope: [{ kind: 'group', target: 'wecom:42' }] })
    await admin.post('/admin/kb/scope', { kb: b.kb.id, scope: [{ kind: 'group', target: 'wecom:42' }] })
    expect(await readdir(viewOf(s, 'carol'))).toEqual([])
    await s.internal('/internal/principals', { users: [{ userId: 'carol', groups: ['wecom:9', 'wecom:42'], email: 'carol@example.test' }] })
    expect((await readdir(viewOf(s, 'carol'))).length).toBe(2)
    await s.internal('/internal/principals', { users: [{ userId: 'carol', groups: ['wecom:9', 'wecom:42'], disabled: true }] })
    expect(await readdir(viewOf(s, 'carol'))).toEqual([])
  })
})
