/** Compile jobs: a serial queue per knowledge base, a site-wide worker cap and a per-user hourly cap. A job exports the KB at a fixed
 * commit, compiles it with the model charged to `chargedTo` through a quota job channel, then applies the result: fast-forward when
 * HEAD has not moved and the work tree is clean, otherwise a `kb/compile/<job>` branch (`conflict`). A result that would exceed
 * max_bytes or max_pages is kept on its branch (`over-limit`). Lint runs even when the KB is over a limit; ingest and rebuild do not. */
import { KbError } from './errors.ts'
import { compileTree } from './compile.ts'
import { newId } from './ids.ts'
import { overLimit } from './limits.ts'
import { createMessagesModel, ModelError, type KbModel } from './model.ts'
import type { UserTree } from './runner.ts'
import type { Actor, KbCore } from './service.ts'
import type { JobOp, JobReport, JobRow, JobState, KbRow } from './store.ts'
import { readTar, SOURCE_EXTENSIONS, writeTar } from './tar.ts'

/** Gives each job a model and releases it afterwards. */
export interface ModelSource { open(chargedTo: string, jobId: string): Promise<{ model: KbModel; close(): Promise<void> }> }

/** The quota control calls the KB service uses (the quota package's control client satisfies it). */
export interface QuotaJobBridge {
  openJob(principal: string, instanceId: string): Promise<{ readonly port: number }>
  issue(principal: string, instanceId: string): Promise<{ readonly token: string; readonly expiresAt: number }>
  closeJob(instanceId: string): Promise<void>
}

/** Models through the quota service: one loopback channel per job, tokens charged to the job's principal.
 * @param bridge Quota control client.
 * @param modelId Platform model ID.
 * @param fetcher Optional fetch (tests).
 * @returns Model source.
 */
export function quotaModelSource(bridge: QuotaJobBridge, modelId: string, fetcher?: typeof fetch): ModelSource {
  return {
    async open(chargedTo, jobId) {
      const instanceId = `kbjob-${jobId}`
      const { port } = await bridge.openJob(chargedTo, instanceId)
      let cached: { token: string; expiresAt: number } | undefined
      const credential = async () => {
        if (cached === undefined || cached.expiresAt - Date.now() < 60_000) cached = await bridge.issue(chargedTo, instanceId)
        return cached.token
      }
      return { model: createMessagesModel({ baseUrl: `http://127.0.0.1:${port}/v1`, credential, model: modelId, ...fetcher ? { fetcher } : {} }),
        close: () => bridge.closeJob(instanceId) }
    },
  }
}
/** The same model for every job (tests and the demo mock). */
export const staticModelSource = (model: KbModel): ModelSource => ({ async open() { return { model, async close() {} } } })

export interface JobOptions {
  readonly models: ModelSource
  /** Jobs running at once across the site (default 2). */
  readonly siteWorkers?: number
  /** Jobs a user may queue per hour (default 20). */
  readonly perUserPerHour?: number
  /** Where a KB lives (default `core.kbTree`). */
  readonly locate?: (kb: KbRow) => Promise<UserTree>
}

const OPS: readonly JobOp[] = ['ingest', 'lint', 'rebuild']
const EXPORT_LIMITS = { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, extensions: SOURCE_EXTENSIONS }

/** What the author sees of a job. */
export const jobView = (job: JobRow) => ({ id: job.id, kbId: job.kbId, op: job.op, state: job.state, requestedBy: job.requestedBy, chargedTo: job.chargedTo,
  queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt, inputTokens: job.inputTokens, outputTokens: job.outputTokens, error: job.error,
  report: job.report === null ? null : { changed: job.report.changed, lint: job.report.lint, log: job.report.log, branch: job.report.branch, limit: job.report.limit } })

/** Build the job runner.
 * @param core Service core.
 * @param options Model source and caps.
 * @returns Operations.
 */
export function compileJobs(core: KbCore, options: JobOptions) {
  const { store, clock } = core
  const siteWorkers = options.siteWorkers ?? 2, perUserPerHour = options.perUserPerHour ?? 20
  const locate = options.locate ?? ((kb: KbRow) => core.kbTree(kb))
  const running = new Set<string>()
  let idle: Array<() => void> = []

  const finish = (job: JobRow, state: JobState, fields: Parameters<typeof store.jobs.finish>[2]) => {
    store.jobs.finish(job.id, state, fields, clock())
    core.audit('kb-compile', store.principals.get(job.requestedBy)?.email ?? job.requestedBy, `kb=${job.kbId} job=${job.id} op=${job.op} state=${state} charged=${job.chargedTo} tokens=${fields.inputTokens ?? 0}/${fields.outputTokens ?? 0}`,
      { userId: job.requestedBy, outcome: state === 'failed' ? 'error' : 'ok' })
  }

  async function run(job: JobRow): Promise<void> {
    let tokens = { inputTokens: 0, outputTokens: 0 }
    try {
      const kb = store.kb.get(job.kbId)!
      const tree = await locate(kb)
      const exported = readTar(await core.helper(tree, 'archive', { kb: kb.id, rev: job.baseCommit }), EXPORT_LIMITS)
      const files = new Map(exported.files.map(file => [file.path, file.data]))
      const previous = store.jobs.lastSucceeded(kb.id)?.report?.sources ?? {}
      const { model, close } = await options.models.open(job.chargedTo, job.id)
      let output: Awaited<ReturnType<typeof compileTree>>
      try { output = await compileTree({ op: job.op, jobId: job.id, files, previous, model, now: new Date(clock()) }) } finally { await close().catch(() => {}) }
      tokens = { inputTokens: output.inputTokens, outputTokens: output.outputTokens }
      const report: JobReport = { changed: output.changed, lint: output.lint, log: output.log, sources: output.sources }
      // Size the result before applying it: the export minus what the compile replaces, plus what it writes.
      let limit: JobReport['limit']
      if (job.op !== 'lint' && kb.kind === 'personal') {
        const limits = core.limitsOf(kb.ownerUserId!)
        const replaced = exported.files.filter(f => f.path.startsWith('wiki/') || f.path === 'index.md' || f.path === 'log.md').reduce((n, f) => n + f.data.length, 0)
        const bytes = kb.bytes - replaced + output.files.reduce((n, f) => n + f.data.length, 0)
        const pages = output.files.filter(f => f.path.startsWith('wiki/')).length
        if (overLimit(limits.max_pages, pages)) limit = { name: 'max_pages', value: pages, allowed: limits.max_pages.value! }
        else if (overLimit(limits.max_bytes, bytes)) limit = { name: 'max_bytes', value: bytes, allowed: limits.max_bytes.value! }
      }
      const applied = await core.helperJson<{ commit: string; applied: 'head' | 'branch' }>(tree, 'apply',
        { kb: kb.id, base: job.baseCommit, job: job.id, mode: limit === undefined ? 'auto' : 'branch', message: `Compile ${job.op} (${job.id})` },
        writeTar(output.files))
      const branch = applied.applied === 'branch' ? `kb/compile/${job.id}` : undefined
      const state: JobState = limit !== undefined ? 'over-limit' : applied.applied === 'head' ? 'succeeded' : 'conflict'
      finish(job, state, { ...tokens, resultCommit: applied.commit, report: { ...report, ...branch ? { branch } : {}, ...limit ? { limit } : {} } })
      await core.refreshStats(store.kb.get(kb.id)!).catch(() => {})
    } catch (error) {
      const code = error instanceof ModelError ? (error.status === 402 || error.status === 429 ? 'allowance' : 'model') : error instanceof KbError ? error.code : 'internal'
      core.log(`kb: job ${job.id} failed: ${(error as Error).message.slice(0, 200)}`)
      finish(job, 'failed', { ...tokens, error: code })
    }
  }

  function pump(): void {
    for (const job of store.jobs.queued()) {
      if (running.size >= siteWorkers) break
      if ([...running].some(id => store.jobs.get(id)?.kbId === job.kbId)) continue
      if (store.jobs.start(clock(), job.id) === 0) continue
      running.add(job.id)
      void run(store.jobs.get(job.id)!).finally(() => { running.delete(job.id); pump() })
    }
    if (running.size === 0 && store.jobs.queued().length === 0) { const waiters = idle; idle = []; for (const resolve of waiters) resolve() }
  }

  return {
    /** Queue a job on a KB the actor may compile. */
    async request(actor: Actor, kb: KbRow, body: Record<string, unknown>, chargedTo: string = actor.userId) {
      const op = body.op as JobOp
      if (!OPS.includes(op)) throw new KbError(400, 'op')
      if (kb.archivedAt !== null) throw new KbError(409, 'archived')
      if (store.jobs.active(kb.id) !== undefined) throw new KbError(409, 'job-active')
      if (store.jobs.recentByUser(actor.userId, clock() - 3_600_000) >= perUserPerHour) throw new KbError(429, 'rate-limited')
      const tree = await locate(kb)
      if (op !== 'lint') core.assertGrowth(await core.refreshStats(kb))
      const head = await core.helperJson<{ head: string }>(tree, 'head', { kb: kb.id })
      const id = newId('job')
      store.jobs.insert({ id, kbId: kb.id, op, requestedBy: actor.userId, chargedTo, baseCommit: head.head }, clock())
      pump()
      return store.jobs.get(id)!
    },
    list: (kbId: string) => store.jobs.byKb(kbId),
    /** Resolves when no job is queued or running (tests and shutdown). */
    settled: () => new Promise<void>(resolve => { idle.push(resolve); pump() }),
    /** After a restart: jobs that were running are failed, queued ones start. */
    recover() {
      for (const job of store.jobs.running()) finish(job, 'failed', { error: 'interrupted' })
      pump()
    },
  }
}
