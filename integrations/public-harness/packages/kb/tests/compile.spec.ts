/** Phase 2: source normalization, the two-phase compiler with the mock model, lint, and compile jobs (fast-forward, conflict branch,
 * over-limit branch, incremental ingest, caps, failures), plus tokens charged to the author through a real quota job channel. */
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { compileTree, lintTree, pageSlug } from '../src/compile.ts'
import { quotaModelSource, staticModelSource, type ModelSource } from '../src/jobs.ts'
import { createMockModel, ModelError, type KbModel } from '../src/model.ts'
import { docxToText, htmlToText, normalizeSource } from '../src/normalize.ts'
import { createQuotaService } from '../../quota/src/service.ts'
import { site, type Site } from './fixture.ts'

const open: Site[] = []
afterEach(async () => { for (const s of open.splice(0)) await s.close() })
const start = async (models: ModelSource, extra: { perUserPerHour?: number } = {}) => { const s = await site({ jobs: { models, ...extra } }); open.push(s); return s }

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'; const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('normalize', () => {
  it('strips_html_and_keeps_headings_and_lists', () => {
    const text = htmlToText('<html><head><style>p{}</style><script>alert(1)</script></head><body><h2>Deploy &amp; run</h2><p>Use <b>pnpm</b>.</p><ul><li>one</li><li>two</li></ul></body></html>')
    expect(text).toContain('## Deploy & run'); expect(text).toContain('- one'); expect(text).not.toMatch(/alert|<b>|p\{\}/)
  })
  it('reads_docx_paragraphs_and_heading_styles', () => {
    const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world &amp; more</w:t></w:r></w:p></w:body></w:document>'
    expect(docxToText(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }))).toBe('# Overview\n\nHello world & more')
    expect(() => docxToText(zip({ 'other.xml': '<x/>' }))).toThrow(/docx/)
  })
  it.skipIf(!(() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true } catch { return false } })())('extracts_pdf_text_with_pdftotext', async () => {
    expect(await normalizeSource('raw/a.pdf', pdf('Quarterly plan text'))).toContain('Quarterly plan text')
  })
})

describe('compiler', () => {
  const tree = (extra: Record<string, string>) => new Map(Object.entries({ 'schema.md': '# Schema', 'index.md': '# Team notes\n', 'log.md': '# Log\n', ...extra }).map(([k, v]) => [k, Buffer.from(v)]))
  it('writes_cited_pages_rebuilds_the_index_and_appends_the_log', async () => {
    const model = createMockModel({ demo: true })
    const out = await compileTree({ op: 'ingest', jobId: 'job_aaaaaaaaaaaaaaaa', files: tree({ 'raw/deploy.md': '# Deploy\nDeploys run nightly. Rollbacks take a minute.\n# Alerts\nAlerts page the on-call.' }),
      previous: {}, model, now: new Date('2026-10-14T00:00:00Z') })
    expect(out.changed).toEqual(['wiki/alerts.md', 'wiki/deploy.md'])
    const page = (path: string) => out.files.find(f => f.path === path)!.data.toString()
    expect(page('wiki/deploy.md')).toMatch(/^# Deploy/); expect(page('wiki/deploy.md')).toContain('(source: raw/deploy.md)'); expect(page('wiki/deploy.md')).toContain('Demo content')
    expect(page('index.md')).toMatch(/^# Team notes/); expect(page('index.md')).toContain('- [Deploy](wiki/deploy.md)')
    expect(page('log.md')).toContain('## 2026-10-14 ingest (job_aaaaaaaaaaaaaaaa)')
    expect(out.lint).toEqual([])
    expect(out.inputTokens).toBeGreaterThan(0); expect(model.calls.map(c => c.task)).toEqual(['extract', 'write', 'write'])
    // The source text reaches the model fenced as data, with the injection guard in the system prompt.
    expect(model.calls[0]!.prompt).toContain('<source path="raw/deploy.md">'); expect(model.calls[0]!.system).toMatch(/never instructions/)
    // Ingest skips sources whose digest did not change; rebuild redoes everything and drops stale pages.
    const again = await compileTree({ op: 'ingest', jobId: 'job_bbbbbbbbbbbbbbbb', files: new Map([...tree({ 'raw/deploy.md': '# Deploy\nDeploys run nightly. Rollbacks take a minute.\n# Alerts\nAlerts page the on-call.' }),
      ...out.files.map(f => [f.path, f.data] as const)]), previous: out.sources, model: createMockModel(), now: new Date() })
    expect(again.changed).toEqual([]); expect(again.files.filter(f => f.path.startsWith('wiki/')).length).toBe(2)
    const rebuilt = await compileTree({ op: 'rebuild', jobId: 'job_cccccccccccccccc', files: new Map([...tree({ 'raw/x.txt': 'Only one thing.' }), ['wiki/stale.md', Buffer.from('# Stale\n')]]),
      previous: {}, model: createMockModel(), now: new Date() })
    expect(rebuilt.files.map(f => f.path)).toEqual(['wiki/x.md', 'index.md', 'log.md'])
  })
  it('lint_finds_dead_links_missing_sources_orphans_and_unindexed_pages', () => {
    const pages = new Map([['wiki/a.md', '# A\nSee [B](b.md) and [gone](gone.md). Fact (source: raw/missing.md)'], ['wiki/b.md', '# B\n'], ['wiki/c.md', '# C\n']])
    expect(lintTree(pages, '- [A](wiki/a.md)\n- [B](wiki/b.md)', new Set(['raw/here.md'])).sort()).toEqual(
      ['dead-link: wiki/a.md -> gone.md', 'missing-source: wiki/a.md cites raw/missing.md', 'not-in-index: wiki/c.md', 'orphan: wiki/a.md', 'orphan: wiki/c.md'])
    expect(pageSlug('部署流程')).toMatch(/^page-[0-9a-f]{10}$/)
  })
})

async function kbWithSources(s: Site, user = 'alice') {
  const me = s.as(user)
  const kb = (await me.post('/me/kb', { title: 'Ops notes' })).body.kb
  expect((await me.upload(`/me/kb/sources?kb=${kb.id}&name=deploy.md`, Buffer.from('# Deploy\nDeploys run nightly.\n# Alerts\nAlerts page on-call.'))).status).toBe(200)
  return { me, kb }
}
const git = (s: Site, user: string, kb: string, ...args: string[]) => execFileSync('git', ['--git-dir', join(s.storage, 'users', user, 'kb', kb, '.git'), ...args], { encoding: 'utf8' }).trim()

describe('compile jobs', () => {
  it('fast_forwards_head_refreshes_stats_and_audits_tokens', async () => {
    const s = await start(staticModelSource(createMockModel({ demo: true })))
    const { me, kb } = await kbWithSources(s)
    const queued = await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' })
    expect(queued.status).toBe(200); expect(queued.body.job).toMatchObject({ op: 'ingest', chargedTo: 'alice' })
    await s.service.jobs!.settled()
    const [job] = (await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs
    expect(job).toMatchObject({ state: 'succeeded', report: { changed: ['wiki/alerts.md', 'wiki/deploy.md'] } })
    expect(job.inputTokens).toBeGreaterThan(0); expect(job.report.sources).toBeUndefined()
    expect(git(s, 'alice', kb.id, 'log', '-1', '--format=%s')).toBe(`Compile ingest (${job.id})`)
    const listed = (await me.get('/me/kb')).body.kbs[0]
    expect(listed).toMatchObject({ pages: 2, lastJob: { id: job.id, state: 'succeeded' } })
    const audit = (await s.internal('/internal/audit/drain', {})).body.events.find((e: any) => e.event === 'kb-compile')
    expect(audit.detail).toMatch(new RegExp(`kb=${kb.id} job=${job.id} op=ingest state=succeeded charged=alice tokens=\\d+/\\d+`))
    // Nothing changed: the next ingest touches no page.
    await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' }); await s.service.jobs!.settled()
    expect((await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs[0]).toMatchObject({ state: 'succeeded', report: { changed: [] } })
  })

  it('keeps_a_branch_when_head_moved_during_the_job', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const inner = createMockModel()
    const slow: KbModel = { async complete(request) { await gate; return inner.complete(request) } }
    const s = await start(staticModelSource(slow))
    const { me, kb } = await kbWithSources(s)
    await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' })
    expect((await me.post('/me/kb/compile', { kb: kb.id, op: 'lint' })).body.code).toBe('job-active')
    await me.upload(`/me/kb/sources?kb=${kb.id}&name=more.txt`, Buffer.from('Another fact.'))
    release(); await s.service.jobs!.settled()
    const [job] = (await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs
    expect(job).toMatchObject({ state: 'conflict', report: { branch: `kb/compile/${job.id}` } })
    expect(git(s, 'alice', kb.id, 'log', '-1', '--format=%s')).toBe('Add source raw/more.txt')
    expect(git(s, 'alice', kb.id, 'ls-tree', '--name-only', '-r', `kb/compile/${job.id}`, 'wiki')).toContain('wiki/deploy.md')
  })

  it('keeps_an_over_limit_result_on_a_branch_blocks_ingest_but_allows_lint', async () => {
    const s = await start(staticModelSource(createMockModel()))
    const { me, kb } = await kbWithSources(s)
    s.service.core.store.limits.set('user', 'alice', 'max_pages', 1, 'admin', 0)
    await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' }); await s.service.jobs!.settled()
    const [job] = (await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs
    expect(job).toMatchObject({ state: 'over-limit', report: { branch: `kb/compile/${job.id}`, limit: { name: 'max_pages', value: 2, allowed: 1 } } })
    expect(git(s, 'alice', kb.id, 'ls-tree', '--name-only', '-r', 'HEAD', 'wiki')).toBe('wiki/.gitkeep')
    // Make the KB itself over the limit: ingest and rebuild are refused, lint still runs.
    s.service.core.store.limits.set('user', 'alice', 'max_pages', null, 'admin', 0)
    await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' }); await s.service.jobs!.settled()
    s.service.core.store.limits.set('user', 'alice', 'max_pages', 1, 'admin', 0)
    const refused = await me.post('/me/kb/compile', { kb: kb.id, op: 'rebuild' })
    expect(refused).toMatchObject({ status: 409, body: { code: 'kb-limit', limit: 'max_pages' } })
    expect((await me.post('/me/kb/compile', { kb: kb.id, op: 'lint' })).status).toBe(200)
    await s.service.jobs!.settled()
    expect((await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs[0]).toMatchObject({ op: 'lint', state: 'succeeded' })
  })

  it('rejects_bad_ops_other_users_kbs_and_too_many_jobs_and_reports_allowance_failures', async () => {
    const failing: KbModel = { async complete() { throw new ModelError(402, 'quota') } }
    const s = await start(staticModelSource(failing), { perUserPerHour: 1 })
    const { me, kb } = await kbWithSources(s)
    expect((await me.post('/me/kb/compile', { kb: kb.id, op: 'drop' })).status).toBe(400)
    expect((await s.as('bob').post('/me/kb/compile', { kb: kb.id, op: 'lint' })).status).toBe(404)
    expect((await s.as('bob').get(`/me/kb/jobs?kb=${kb.id}`)).status).toBe(404)
    await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' }); await s.service.jobs!.settled()
    expect((await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs[0]).toMatchObject({ state: 'failed', error: 'allowance' })
    expect((await me.post('/me/kb/compile', { kb: kb.id, op: 'lint' })).status).toBe(429)
  })

  it('answers_503_without_compile_settings', async () => {
    const s = await site(); open.push(s)
    const kb = (await s.as('alice').post('/me/kb', { title: 'X' })).body.kb
    expect((await s.as('alice').post('/me/kb/compile', { kb: kb.id, op: 'lint' })).status).toBe(503)
  })
})

describe('quota job channel', () => {
  it('charges_compile_tokens_to_the_author_through_a_loopback_job_listener', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-kbq-')); await chmod(dir, 0o700)
    const secret = async (name: string, value: string) => { const path = join(dir, name); await writeFile(path, value, { mode: 0o600 }); return path }
    const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
    const upstream: string[] = []
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(Buffer.from(init!.body as ArrayBuffer))) as { system: string }
      upstream.push(new Headers(init?.headers).get('x-api-key') ?? '')
      const text = body.system.includes('extract') ? JSON.stringify({ concepts: [{ title: 'Deploy', summary: 'How deploys run.', claims: ['Deploys run nightly.'] }] }) : '# Deploy\n\nDeploys run nightly. (source: raw/deploy.md)'
      return new Response([{ type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 40, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' }].map(sse).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const quota = await createQuotaService({ stateDir: dir, upstreamRoot: 'https://upstream.example.test/v1', platformKeyFile: await secret('p.key', 'platform-secret-key'),
      tokenSecretFile: await secret('t.key', 'x'.repeat(48)), healthSecretFile: await secret('h.key', 'h'.repeat(24)), modelId: 'platform-model', contextWindow: 50_000,
      maxOutputTokens: 8192, personalDailyTokens: 100_000, siteDailyTokens: 1_000_000, personalConcurrency: 2, siteConcurrency: 8, busyTimeoutMs: 1000, maxBodyBytes: 1_000_000,
      maxImagesPerRequest: 2, maxInlineImageBytes: 10_000, maxEventBytes: 65_536, maxFileBodyBytes: 100_000, maxFilesPerUser: 10, maxFileMetadataBytes: 4096, maxFileListLimit: 20,
      credentialLifetimeMs: 600_000, listenPorts: { min: 29160, max: 29169 } }, { fetcher })
    try {
      const opened: string[] = []
      const bridge = { openJob: async (p: string, i: string) => { opened.push(i); return quota.openJob(p as never, i) }, issue: async (p: string, i: string) => quota.issue(p as never, i), closeJob: (i: string) => quota.closeJob(i) }
      const s = await start(quotaModelSource(bridge, 'platform-model'))
      const { me, kb } = await kbWithSources(s)
      await me.post('/me/kb/compile', { kb: kb.id, op: 'ingest' }); await s.service.jobs!.settled()
      const [job] = (await me.get(`/me/kb/jobs?kb=${kb.id}`)).body.jobs
      expect(job).toMatchObject({ state: 'succeeded', inputTokens: 80, outputTokens: 20 })
      expect(opened).toEqual([`kbjob-${job.id}`])
      expect(upstream).toEqual(['platform-secret-key', 'platform-secret-key'])
      expect((await quota.account.usage('alice' as never)).usedTokens).toBe(100)
      expect((await quota.account.usage('bob' as never)).usedTokens).toBe(0)
      // The channel is closed after the job: a second open of the same instance succeeds and a duplicate is refused.
      await quota.openJob('alice' as never, `kbjob-${job.id}`)
      await expect(quota.openJob('alice' as never, `kbjob-${job.id}`)).rejects.toThrow(/job channel/)
      await expect(quota.openJob('alice' as never, 'i1')).rejects.toThrow(/job channel/)
    } finally { await quota.shutdown() }
  })
})
