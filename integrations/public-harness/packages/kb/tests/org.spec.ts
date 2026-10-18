/** Phase 4: org knowledge bases (create, upload, page edit, compile charged to the org principal, history, publish and rollback),
 * conversion of a published personal KB with the author notified, the inventory with over-limit flags and filters, the effective
 * preview, and the limits API with overrides, precedence, validation and audit. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { staticModelSource } from '../src/jobs.ts'
import { createMockModel } from '../src/model.ts'
import { site, type Site } from './fixture.ts'

const open: Site[] = []
afterEach(async () => { for (const s of open.splice(0)) await s.close() })
const start = async () => { const s = await site({ jobs: { models: staticModelSource(createMockModel({ demo: true })) } }); open.push(s); return s }
async function people(s: Site) {
  await s.internal('/internal/principals', { users: [
    { userId: 'alice', groups: [], email: 'alice@example.test' }, { userId: 'bob', groups: ['wecom:7', 'wecom:1'], email: 'bob@example.test' },
    { userId: 'carol', groups: ['wecom:9'], email: 'carol@example.test' }, { userId: 'root', groups: [], email: 'root@example.test' }] })
}
const audit = async (s: Site) => (await s.internal('/internal/audit/drain', {})).body.events.map((e: { event: string; detail: string }) => `${e.event} ${e.detail}`) as string[]

describe('org knowledge bases', () => {
  it('creates_uploads_edits_compiles_on_the_org_principal_publishes_and_rolls_back', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    expect((await s.as('bob').post('/admin/kb/org', { title: 'Handbook' })).status).toBe(403)
    const kb = (await admin.post('/admin/kb/org', { title: 'Company handbook' })).body.kb
    expect(kb).toMatchObject({ kind: 'org', ownerUserId: null, chargedTo: `org-kb-${kb.id}` })
    expect((await admin.upload(`/admin/kb/org/sources?kb=${kb.id}&name=leave.md`, Buffer.from('# Leave\nTwenty days.'))).body).toMatchObject({ path: 'raw/leave.md', changed: true })
    expect((await admin.post('/admin/kb/org/edit', { kb: kb.id, path: '../x.md', text: 'x' })).body.code).toBe('path')
    expect((await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'raw/leave.md', text: 'x' })).body.code).toBe('path')
    await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'wiki/welcome.md', text: '# Welcome\n\nFirst version.', message: 'Welcome page' })
    const job = (await admin.post('/admin/kb/org/compile', { kb: kb.id, op: 'ingest' })).body.job
    expect(job).toMatchObject({ chargedTo: `org-kb-${kb.id}`, requestedBy: 'root' })
    await s.service.jobs!.settled()
    expect(s.service.core.store.jobs.get(job.id)!.state).toBe('succeeded')

    // Publish HEAD to group wecom:7, then edit and roll back to the first published commit.
    expect((await admin.post('/admin/kb/org/rollback', { kb: kb.id })).body.code).toBe('scope')
    const first = (await admin.post('/admin/kb/org/rollback', { kb: kb.id, scope: [{ kind: 'group', target: 'wecom:7' }] })).body
    expect(await readdir(join(s.root, 'views', 'bob'))).toEqual(['company-handbook'])
    expect(await readdir(join(s.root, 'views', 'carol'))).toEqual([])
    await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'wiki/welcome.md', text: '# Welcome\n\nSecond version.' })
    await admin.post('/admin/kb/org/rollback', { kb: kb.id })
    expect(await readFile(join(s.root, 'views', 'bob', 'company-handbook', 'wiki', 'welcome.md'), 'utf8')).toContain('Second version.')
    const content = (await admin.get(`/admin/kb/content?kb=${kb.id}`)).body
    expect(content.files.map((f: { path: string }) => f.path)).toContain('raw/leave.md')
    expect(content.history[0]).toMatchObject({ published: true })
    expect(content.history.length).toBeGreaterThanOrEqual(5)
    expect((await admin.get(`/admin/kb/content?kb=${kb.id}&path=wiki/welcome.md&rev=${first.commit}`)).body.text).toContain('First version.')
    await admin.post('/admin/kb/org/rollback', { kb: kb.id, commit: first.commit })
    expect(await readFile(join(s.root, 'views', 'bob', 'company-handbook', 'wiki', 'welcome.md'), 'utf8')).toContain('First version.')
    expect((await admin.post('/admin/kb/org/rollback', { kb: kb.id, commit: 'f'.repeat(40) })).body.code).toBe('commit-not-found')
    const events = await audit(s)
    expect(events.filter(e => e.startsWith('admin-kb-')).map(e => e.split(' ')[0])).toEqual(['admin-kb-org-create', 'admin-kb-org-edit', 'admin-kb-org-edit',
      'admin-kb-org-compile', 'admin-kb-rollback', 'admin-kb-org-edit', 'admin-kb-rollback', 'admin-kb-rollback'])
    expect(events.find(e => e.startsWith('kb-compile'))).toContain(`charged=org-kb-${kb.id}`)
  })

  it('converts_a_published_personal_kb_and_tells_the_author', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin'), me = s.as('alice')
    const kb = (await me.post('/me/kb', { title: 'Runbooks' })).body.kb
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=deploy.md`, Buffer.from('# Deploy'))
    expect((await admin.post('/admin/kb/convert', { kb: kb.id })).body.code).toBe('not-published')
    // An unshared personal KB shows metadata only.
    expect((await admin.get(`/admin/kb/content?kb=${kb.id}`)).body.files).toBeNull()
    const req = (await me.post('/me/kb/share', { kb: kb.id })).body.request
    await admin.post('/admin/kb/requests/approve', { id: req.id, scope: [{ kind: 'user', target: 'carol' }] })
    const converted = (await admin.post('/admin/kb/convert', { kb: kb.id })).body
    expect(converted.kb).toMatchObject({ kind: 'org', title: 'Runbooks', convertedFrom: kb.id, share: { state: 'published', scope: [{ kind: 'user', target: 'carol' }] } })
    expect((await me.get('/me/kb')).body.kbs[0].share).toMatchObject({ state: 'converted' })
    expect(await readdir(join(s.root, 'views', 'carol'))).toEqual(['runbooks'])
    expect((await admin.get(`/admin/kb/content?kb=${converted.kb.id}`)).body.files.map((f: { path: string }) => f.path)).toContain('index.md')
    expect((await audit(s)).find(e => e.startsWith('admin-kb-convert'))).toBe(`admin-kb-convert kb=${kb.id} org=${converted.kb.id} snap=${converted.kb.share.snapshot.id} scope=groups:0,users:1`)
  })
})

describe('inventory, preview and limits', () => {
  it('lists_with_over_limit_flags_filters_and_previews_a_users_set', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    const a = (await s.as('alice').post('/me/kb', { title: 'One' })).body.kb
    await s.as('bob').post('/me/kb', { title: 'Two' })
    await admin.put('/admin/kb/limits', { scope: { type: 'user', id: 'alice' }, name: 'max_pages', value: 1 })
    // Page count above the limit (set directly; a real compile would have written the pages).
    s.service.core.store.kb.setStats(a.bytes, 5, 0, Date.now(), a.id)
    const all = (await admin.get('/admin/kb')).body
    expect(all.totals).toEqual({ all: 2, over: 1, archived: 0 })
    const over = (await admin.get('/admin/kb?filter=over')).body.kbs
    expect(over.map((k: { id: string }) => k.id)).toEqual([a.id])
    expect(over[0]).toMatchObject({ ownerEmail: 'alice@example.test', over: [{ limit: 'max_pages', value: 5, allowed: 1 }], share: { state: 'private' } })
    expect((await admin.get('/admin/kb?filter=nope')).status).toBe(400)
    const org = (await admin.post('/admin/kb/org', { title: 'Policies' })).body.kb
    await admin.post('/admin/kb/org/rollback', { kb: org.id, scope: [{ kind: 'company' }] })
    expect((await admin.get('/admin/kb/preview?user=bob')).body.kbs.map((k: { name: string }) => k.name)).toEqual(['policies'])
    expect((await admin.get('/admin/kb/preview?user=nobody')).status).toBe(404)
  })

  it('sets_and_deletes_overrides_with_precedence_validation_and_audit', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    const initial = (await admin.get('/admin/kb/limits')).body
    expect(initial.global).toEqual({ max_kbs: 10, max_bytes: 209_715_200, max_pages: 2000 })
    await admin.put('/admin/kb/limits', { scope: { type: 'group', id: 'wecom:7' }, name: 'max_kbs', value: 3 })
    await admin.put('/admin/kb/limits', { scope: { type: 'group', id: 'wecom:1' }, name: 'max_kbs', value: null })
    await admin.put('/admin/kb/limits', { scope: { type: 'global' }, name: 'max_pages', value: null })
    expect((await admin.get('/admin/kb/limits/effective?user=bob')).body.limits).toMatchObject({ max_kbs: { value: null, source: 'group:wecom:1' }, max_pages: { value: null, source: 'global' } })
    await admin.put('/admin/kb/limits', { scope: { type: 'user', id: 'bob' }, name: 'max_kbs', value: 2 })
    const effective = (await admin.get('/admin/kb/limits/effective?user=bob')).body
    expect(effective).toMatchObject({ user: { email: 'bob@example.test' }, limits: { max_kbs: { value: 2, source: 'user' } }, usage: { kbs: 0 } })
    const listed = (await admin.get('/admin/kb/limits')).body
    expect(listed.overrides).toHaveLength(3)
    expect(listed.overrides.find((o: { scope: { id: string } }) => o.scope.id === 'bob')).toMatchObject({ scope: { type: 'user', email: 'bob@example.test' }, values: { max_kbs: 2 } })
    for (const bad of [{ scope: { type: 'user', id: 'ghost' }, name: 'max_kbs', value: 1 }, { scope: { type: 'group', id: 'x' }, name: 'max_kbs', value: 1 },
      { scope: { type: 'global' }, name: 'max_users', value: 1 }, { scope: { type: 'global' }, name: 'max_kbs', value: 0 }, { scope: { type: 'global' }, name: 'max_bytes', value: 10 },
      { scope: { type: 'global' }, name: 'max_kbs', value: 1.5 }]) expect((await admin.put('/admin/kb/limits', bad)).status).toBe(400)
    expect((await admin.del('/admin/kb/limits', { scope: { type: 'global' }, name: 'max_kbs' })).body.code).toBe('global-scope')
    expect((await admin.del('/admin/kb/limits', { scope: { type: 'user', id: 'carol' }, name: 'max_kbs' })).status).toBe(404)
    await admin.del('/admin/kb/limits', { scope: { type: 'user', id: 'bob' }, name: 'max_kbs' })
    expect((await admin.get('/admin/kb/limits/effective?user=bob')).body.limits.max_kbs.source).toBe('group:wecom:1')
    expect((await s.as('bob').put('/admin/kb/limits', { scope: { type: 'global' }, name: 'max_kbs', value: 1 })).status).toBe(403)
    expect((await audit(s)).filter(e => e.startsWith('admin-kb-limit'))).toEqual([
      'admin-kb-limit-change scope=group:wecom:7 limit=max_kbs old=inherit new=3', 'admin-kb-limit-change scope=group:wecom:1 limit=max_kbs old=inherit new=unlimited',
      'admin-kb-limit-change scope=global:* limit=max_pages old=2000 new=unlimited', 'admin-kb-limit-change scope=user:bob limit=max_kbs old=inherit new=2',
      'admin-kb-limit-delete scope=user:bob limit=max_kbs old=2 new=inherit'])
  })
})

describe('org knowledge base archive', () => {
  it('archives_and_restores_an_org_kb_removing_and_returning_it_in_reader_views_with_audit', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    const kb = (await admin.post('/admin/kb/org', { title: 'Old handbook' })).body.kb
    await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'wiki/a.md', text: '# A' })
    await admin.post('/admin/kb/org/rollback', { kb: kb.id, scope: [{ kind: 'group', target: 'wecom:7' }] })
    expect(await readdir(join(s.root, 'views', 'bob'))).toEqual(['old-handbook'])

    expect((await s.as('bob').post('/admin/kb/org/archive', { kb: kb.id })).status).toBe(403)
    expect((await admin.post('/admin/kb/org/archive', { kb: 'kb_nope' })).body.code).toBe('kb-not-found')
    const archived = (await admin.post('/admin/kb/org/archive', { kb: kb.id })).body.kb
    expect(archived.archivedAt).not.toBeNull()
    expect(await readdir(join(s.root, 'views', 'bob'))).toEqual([])
    expect((await s.as('bob').get('/me/kb/shared')).body.kbs).toEqual([])
    // Archived org KBs refuse edits, compiles, publishing and a second archive; they are filterable in the inventory.
    expect((await admin.post('/admin/kb/org/edit', { kb: kb.id, path: 'wiki/a.md', text: 'x' })).body.code).toBe('archived')
    expect((await admin.post('/admin/kb/org/rollback', { kb: kb.id })).body.code).toBe('archived')
    expect((await admin.post('/admin/kb/org/archive', { kb: kb.id })).body.code).toBe('archived')
    const inv = (await admin.get('/admin/kb?filter=archived')).body
    expect(inv.kbs.map((k: { id: string }) => k.id)).toEqual([kb.id])
    expect(inv.totals.archived).toBe(1)
    expect((await admin.get('/admin/kb?filter=all')).body.kbs.map((k: { id: string }) => k.id)).toContain(kb.id)

    expect((await admin.post('/admin/kb/org/restore', { kb: kb.id })).body.kb.archivedAt).toBeNull()
    expect(await readdir(join(s.root, 'views', 'bob'))).toEqual(['old-handbook'])
    expect((await admin.post('/admin/kb/org/restore', { kb: kb.id })).body.code).toBe('not-archived')
    expect((await audit(s)).filter(e => /^admin-kb-org-(archive|restore) /.test(e))).toEqual([`admin-kb-org-archive kb=${kb.id}`, `admin-kb-org-restore kb=${kb.id}`])

    // Personal KBs are archived by their owner, not through the org routes.
    const personal = (await s.as('alice').post('/me/kb', { title: 'Mine' })).body.kb
    expect((await admin.post('/admin/kb/org/archive', { kb: personal.id })).body.code).toBe('not-org')
  })
})

describe('org knowledge base budget principals', () => {
  it('resolves_an_org_kb_budget_principal_for_identity_and_nothing_else', async () => {
    const s = await start(); await people(s)
    const admin = s.as('root', 'admin')
    const kb = (await admin.post('/admin/kb/org', { title: 'Budgeted' })).body.kb
    expect((await admin.get(`/admin/kb/principal?id=org-kb-${kb.id}`)).body).toMatchObject({ principal: `org-kb-${kb.id}`, kb: { id: kb.id, title: 'Budgeted', archivedAt: null } })
    const personal = (await s.as('alice').post('/me/kb', { title: 'Mine' })).body.kb
    for (const id of [`org-kb-${personal.id}`, 'org-kb-kb_bbbbbbbbbbbbbbbb', 'alice', `org-kb-${kb.id}x`, '']) expect((await admin.get(`/admin/kb/principal?id=${encodeURIComponent(id)}`)).body.code).toBe('principal-not-found')
    expect((await s.as('bob').get(`/admin/kb/principal?id=org-kb-${kb.id}`)).status).toBe(403)
  })
})
