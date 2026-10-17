/** Phase 1: the store, limits, the archive validator, the user helper through the development runner, personal create, upload and
 * archive over the private socket, and the production helper argv. */
import { execFileSync } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveLimits } from '../src/limits.ts'
import { systemdRunArgv } from '../src/runner.ts'
import { sourceName } from '../src/service.ts'
import type { LimitRow } from '../src/store.ts'
import { readTar, TarError, writeTar } from '../src/tar.ts'
import { site, type Site } from './fixture.ts'

const open: Site[] = []
afterEach(async () => { for (const s of open.splice(0)) await s.close() })
const start = async () => { const s = await site(); open.push(s); return s }

describe('limits', () => {
  const row = (scopeType: LimitRow['scopeType'], scopeId: string, name: LimitRow['name'], value: number | null): LimitRow => ({ scopeType, scopeId, name, value, updatedBy: 't', updatedAt: 0 })
  const global = [row('global', '*', 'max_kbs', 10), row('global', '*', 'max_bytes', 100), row('global', '*', 'max_pages', 5)]
  it('user_beats_group_beats_global_and_the_most_permissive_group_wins', () => {
    const rows = [...global, row('group', 'wecom:1', 'max_kbs', 3), row('group', 'wecom:2', 'max_kbs', 20), row('group', 'wecom:3', 'max_bytes', null),
      row('group', 'wecom:2', 'max_bytes', 500), row('user', 'u1', 'max_pages', 2)]
    expect(effectiveLimits(rows, 'u1', ['wecom:1', 'wecom:2', 'wecom:3'])).toEqual({
      max_kbs: { value: 20, source: 'group:wecom:2' }, max_bytes: { value: null, source: 'group:wecom:3' }, max_pages: { value: 2, source: 'user' } })
    expect(effectiveLimits(rows, 'u2', ['wecom:1'])).toEqual({ max_kbs: { value: 3, source: 'group:wecom:1' }, max_bytes: { value: 100, source: 'global' }, max_pages: { value: 5, source: 'global' } })
    // Order of groups does not matter, and a NULL global is unlimited.
    expect(effectiveLimits([...rows.slice(1), row('global', '*', 'max_kbs', null)], 'u3', [])).toMatchObject({ max_kbs: { value: null, source: 'global' } })
  })
})

describe('archive validation', () => {
  const tarWith = (name: string, type: string, data = Buffer.alloc(0)) => {
    const archive = writeTar([{ path: 'x.md', data }])
    archive.write(name.padEnd(100, '\0'), 0, 'utf8')
    archive.write(type, 156, 'ascii')
    archive.fill(0x20, 148, 156)
    let sum = 0; for (let i = 0; i < 512; i++) sum += archive[i]!
    archive.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    return archive
  }
  it('round_trips_and_refuses_links_devices_absolute_and_parent_paths', () => {
    const long = `wiki/${'deep/'.repeat(30)}页面.md`
    const read = readTar(writeTar([{ path: 'index.md', data: Buffer.from('# x') }, { path: long, data: Buffer.from('y') }, { path: 'raw/photo.png', data: Buffer.from('p') }]))
    expect(read.files.map(file => file.path)).toEqual(['index.md', long])
    expect(read.skipped).toEqual(['raw/photo.png'])
    for (const [name, type, code] of [['link.md', '2', 'entry-type'], ['hard.md', '1', 'entry-type'], ['dev', '3', 'entry-type'], ['fifo', '6', 'entry-type'],
      ['/etc/passwd.md', '0', 'path'], ['a/../../b.md', '0', 'path'], ['a/./b.md', '0', 'path'], ['bad\u0001.md', '0', 'path']] as const) {
      expect(() => readTar(tarWith(name, type)), name).toThrow(new TarError(code))
    }
    expect(() => readTar(writeTar([{ path: 'a.md', data: Buffer.alloc(10) }]), { maxFiles: 10, maxFileBytes: 5, maxTotalBytes: 100, extensions: ['.md'] })).toThrow(new TarError('file-too-large'))
    expect(() => readTar(writeTar([{ path: 'a.md', data: Buffer.alloc(1) }, { path: 'b.md', data: Buffer.alloc(1) }]), { maxFiles: 1, maxFileBytes: 5, maxTotalBytes: 100, extensions: ['.md'] })).toThrow(new TarError('too-many-files'))
  })
  it('reads_what_git_archive_writes', async () => {
    const s = await start()
    const created = await s.as('alice').post('/me/kb', { title: 'Team handbook' })
    const dir = join(s.storage, 'users', 'alice', 'kb', created.body.kb.id)
    const tar = execFileSync('git', ['-C', dir, 'archive', '--format=tar', 'HEAD'])
    expect(readTar(tar).files.map(file => file.path).sort()).toEqual(['index.md', 'log.md', 'raw/.gitkeep', 'schema.md', 'wiki/.gitkeep'])
  })
})

describe('personal knowledge bases', () => {
  it('create_lists_uploads_and_archives_with_audit_and_git_history', async () => {
    const s = await start(), alice = s.as('alice')
    const created = await alice.post('/me/kb', { title: '  产品 FAQ  ', description: 'Support answers' })
    expect(created.status).toBe(200)
    const kb = created.body.kb
    expect(kb).toMatchObject({ kind: 'personal', ownerUserId: 'alice', title: '产品 FAQ', slug: 'faq', pages: 0, sources: 0 })
    expect(kb.id).toMatch(/^kb_[a-z2-7]{16}$/)
    const dir = join(s.storage, 'users', 'alice', 'kb', kb.id)
    expect((await lstat(join(s.storage, 'users', 'alice', 'kb'))).mode & 0o777).toBe(0o700)
    expect(await readFile(join(dir, 'index.md'), 'utf8')).toContain('# 产品 FAQ')
    const up = await alice.upload(`/me/kb/sources?kb=${kb.id}&name=${encodeURIComponent('Release notes.md')}`, Buffer.from('# v1\n\nFirst release.\n'))
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ path: 'raw/Release notes.md', changed: true, kb: { sources: 1 } })
    expect(execFileSync('git', ['-C', dir, 'log', '--format=%s']).toString().trim().split('\n')).toEqual(['Add source raw/Release notes.md', 'Create knowledge base'])
    // Same name, same bytes: no new commit.
    expect((await alice.upload(`/me/kb/sources?kb=${kb.id}&name=${encodeURIComponent('Release notes.md')}`, Buffer.from('# v1\n\nFirst release.\n'))).body.changed).toBe(false)
    const listed = await alice.get('/me/kb')
    expect(listed.body.kbs).toHaveLength(1)
    expect(listed.body.kbs[0]).toMatchObject({ id: kb.id, share: { state: 'private' }, lastJob: null })
    expect(listed.body.limits.max_kbs).toEqual({ value: 10, source: 'global' })
    expect(listed.body.usage.kbs).toBe(1)
    // Nobody else sees or touches it.
    expect((await s.as('bob').get('/me/kb')).body.kbs).toEqual([])
    expect((await s.as('bob').post('/me/kb/archive', { kb: kb.id })).status).toBe(404)
    expect((await s.as('bob').upload(`/me/kb/sources?kb=${kb.id}&name=a.md`, Buffer.from('x'))).status).toBe(404)
    expect((await alice.post('/me/kb/archive', { kb: kb.id })).body.kb.archivedAt).toBeTypeOf('number')
    expect((await alice.upload(`/me/kb/sources?kb=${kb.id}&name=a.md`, Buffer.from('x'))).status).toBe(409)
    const events = (await s.internal('/internal/audit/drain', {})).body.events
    expect(events.map((e: { event: string; actor: string; detail: string }) => `${e.event} ${e.actor} ${e.detail}`)).toEqual([
      `kb-create alice@example.test kb=${kb.id}`, `kb-archive alice@example.test kb=${kb.id}`])
    await s.internal('/internal/audit/ack', { upTo: events.at(-1).id })
    expect((await s.internal('/internal/audit/drain', {})).body.events).toEqual([])
  })

  it('refuses_bad_names_types_and_sizes_and_unknown_actors', async () => {
    const s = await start(), alice = s.as('alice')
    const kb = (await alice.post('/me/kb', { title: 'X' })).body.kb
    for (const name of ['../escape.md', 'a/b.md', '.hidden.md', 'photo.png', 'noext', 'x'.repeat(200) + '.md']) {
      expect((await alice.upload(`/me/kb/sources?kb=${kb.id}&name=${encodeURIComponent(name)}`, Buffer.from('x'))).status, name).toBe(400)
    }
    expect(() => sourceName('报告 2026.PDF')).not.toThrow()
    expect((await alice.post('/me/kb', { title: '' })).status).toBe(400)
    expect((await alice.post('/me/kb', { title: 'a\u0000b' })).status).toBe(400)
    const { call } = await import('./fixture.ts')
    expect((await call(s.socket, 'GET', '/me/kb', {})).status).toBe(401)
    expect((await call(s.socket, 'GET', '/me/kb', { 'x-dsh-user': '../x' })).status).toBe(401)
  })

  it('max_kbs_and_max_bytes_refuse_growth_with_kb_limit', async () => {
    const s = await start(), alice = s.as('alice')
    s.service.core.store.limits.set('user', 'alice', 'max_kbs', 1, 'test', 1)
    s.service.core.store.limits.set('user', 'alice', 'max_bytes', 2000, 'test', 1)
    const kb = (await alice.post('/me/kb', { title: 'One' })).body.kb
    const second = await alice.post('/me/kb', { title: 'Two' })
    expect(second.status).toBe(409)
    expect(second.body).toEqual({ code: 'kb-limit', limit: 'max_kbs', value: 1, allowed: 1 })
    const big = await alice.upload(`/me/kb/sources?kb=${kb.id}&name=big.txt`, Buffer.alloc(3000, 0x61))
    expect(big.status).toBe(409)
    expect(big.body).toMatchObject({ code: 'kb-limit', limit: 'max_bytes', allowed: 2000 })
    // Archiving frees a slot; nothing is deleted.
    await alice.post('/me/kb/archive', { kb: kb.id })
    expect((await alice.post('/me/kb', { title: 'Two' })).status).toBe(200)
  })

  it('principals_projection_records_changes_only', async () => {
    const s = await start()
    expect((await s.internal('/internal/principals', { users: [{ userId: 'alice', groups: ['wecom:2', 'wecom:1'] }, { userId: 'bob', groups: [] }] })).body.changed).toBe(2)
    expect((await s.internal('/internal/principals', { users: [{ userId: 'alice', groups: ['wecom:1', 'wecom:2'] }] })).body.changed).toBe(0)
    expect(s.service.core.store.principals.get('alice')!.groups).toEqual(['wecom:1', 'wecom:2'])
    expect((await s.internal('/internal/principals', { users: [{ userId: '../x', groups: [] }] })).status).toBe(400)
  })

  it('a_hostile_repository_config_hook_never_runs', async () => {
    const s = await start(), alice = s.as('alice')
    const kb = (await alice.post('/me/kb', { title: 'Hooks' })).body.kb
    const dir = join(s.storage, 'users', 'alice', 'kb', kb.id), marker = join(s.dir, 'pwned')
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    await writeFile(join(dir, '.git', 'config'), `${await readFile(join(dir, '.git', 'config'), 'utf8')}\n[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = .git/hooks\n`)
    expect((await alice.upload(`/me/kb/sources?kb=${kb.id}&name=a.md`, Buffer.from('# a'))).status).toBe(200)
    await expect(lstat(marker)).rejects.toThrow()
  })
})

describe('production helper argv', () => {
  it('runs_as_the_user_without_network_and_writes_only_the_kb_directory', () => {
    const argv = systemdRunArgv({ systemdRun: '/usr/bin/systemd-run', node: '/opt/node/bin/node', entry: '/opt/kb/lib/helper.js', inaccessible: ['/srv/dsh-public/kb', '/var/lib/dsh'] },
      { userId: 'u1', account: 'dsh-abc', kbDir: '/srv/dsh/users/dsh-abc/kb', uid: 2001, gid: 2001 }, 'archive', { kb: 'kb_aaaaaaaaaaaaaaaa', rev: 'f'.repeat(40) })
    expect(argv).toContain('--uid=2001'); expect(argv).toContain('--gid=2001'); expect(argv).toContain('--pipe'); expect(argv).toContain('--wait')
    for (const property of ['PrivateNetwork=yes', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ReadWritePaths=/srv/dsh/users/dsh-abc/kb',
      'InaccessiblePaths=/srv/dsh-public/kb /var/lib/dsh', 'CapabilityBoundingSet=']) expect(argv).toContain(`--property=${property}`)
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/opt/node/bin/node', '/opt/kb/lib/helper.js', '/srv/dsh/users/dsh-abc/kb', 'archive', JSON.stringify({ kb: 'kb_aaaaaaaaaaaaaaaa', rev: 'f'.repeat(40) })])
    expect(() => systemdRunArgv({ systemdRun: 's', node: 'n', inaccessible: [] }, { userId: 'r', account: 'root', kbDir: '/x', uid: 0, gid: 0 }, 'head', {})).toThrow()
  })
})
