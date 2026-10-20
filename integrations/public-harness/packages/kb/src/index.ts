/** `dsh-kb`: the knowledge base host service. Start it with `startKbService`; identity reaches it with `createKbClient`-style HTTP
 * requests over the private socket. */
import { join } from 'node:path'
import { KbError } from './errors.ts'
import type { HelperRunner, UserTrees } from './runner.ts'
import { listenKbSocket, kbHandler, type KbRoutes } from './server.ts'
import { createCore, MAX_SOURCE_BYTES, personalOps, prepareRoot, usageOf, type KbCore } from './service.ts'
import { openKbStore } from './store.ts'
import { compileJobs, jobView, type JobOptions } from './jobs.ts'
import { shareModule } from './share.ts'
import { reconcileViews } from './views.ts'
import { orgModule } from './org.ts'
import { contentModule } from './content.ts'
import { limitsModule } from './limits-admin.ts'

export { createDirectRunner, createSystemdRunner, devUserTrees, systemdRunArgv, type HelperRunner, type UserTree, type UserTrees } from './runner.ts'
export { canonicalKbDir, createRootHelperRunner, parseRootRequest, ROOT_VERBS, RootHelperError, serveRootConnection, type RootHelperDeps, type RootRequest } from './root-helper.ts'
export { KbError } from './errors.ts'
export { compileJobs, jobView, quotaModelSource, staticModelSource, type JobOptions, type ModelSource, type QuotaJobBridge } from './jobs.ts'
export { parseScope, publishSnapshot, REQUEST_TTL_MS, shareModule } from './share.ts'
export { applyView, reconcileViews, visibleEntries, type ViewEntry } from './views.ts'
export { orgModule, orgPrincipal } from './org.ts'
export { limitsModule, LIMIT_RANGE } from './limits-admin.ts'
export { createMessagesModel, createMockModel, ModelError, type KbModel } from './model.ts'

/** Service settings. */
export interface KbServiceConfig {
  /** `<kbRoot>`, for example /srv/dsh-public/kb. */
  readonly root: string
  /** Private Unix socket identity connects to. */
  readonly socket: string
  readonly socketMode?: number
  readonly socketGid?: number
  readonly users: UserTrees
  readonly runner: HelperRunner
  /** Runner for the service-owned org tree (default `runner`; production passes a direct runner as the service account). */
  readonly orgRunner?: HelperRunner
  readonly clock?: () => number
  readonly log?: (line: string) => void
  /** Compile settings; without them compile requests answer 503 `compile-unavailable`. */
  readonly jobs?: JobOptions
  /** Pending share requests expire after this long (default 30 days). */
  readonly requestTtlMs?: number
  /** How often views are reconciled and old requests swept (default ten minutes; 0 turns the timer off). */
  readonly sweepIntervalMs?: number
}

/** A running service. */
export interface KbService {
  readonly core: KbCore
  readonly jobs: ReturnType<typeof compileJobs> | undefined
  close(): Promise<void>
}

const principalsBody = (body: Record<string, unknown>) => {
  if (!Array.isArray(body.users) || body.users.length > 100_000) throw new KbError(400, 'body')
  return body.users.map(raw => {
    const user = raw as Record<string, unknown>
    if (typeof user.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.userId) || !Array.isArray(user.groups)
      || user.groups.some(group => typeof group !== 'string' || group.length > 600)) throw new KbError(400, 'body')
    return { userId: user.userId, groups: user.groups as string[], disabled: user.disabled === true, email: typeof user.email === 'string' ? user.email.slice(0, 320) : null }
  })
}

/** Personal and internal routes; later modules add their own.
 * @param core Service core.
 * @returns Route table.
 */
export function baseRoutes(core: KbCore, hooks: { principalsChanged?: (userIds: readonly string[]) => Promise<void> } = {}): KbRoutes {
  const personal = personalOps(core)
  const { store } = core
  return {
    'GET /me/kb': async ({ actor }) => {
      void reconcileViews(core, [actor.userId])
      const kbs = store.kb.byOwner(actor.userId).map(kb => ({ ...kb, ...personalState(core, kb.id) }))
      return { kbs, ...usageOf(core, actor.userId) }
    },
    'POST /me/kb': async request => ({ kb: await personal.create(request.actor, await request.json()) }),
    'POST /me/kb/archive': async request => ({ kb: await personal.archive(request.actor, await request.json()) }),
    'POST /me/kb/sources': async request => personal.upload(request.actor, request.query.get('kb'), request.query.get('name'), await request.bytes(MAX_SOURCE_BYTES)),
    'POST /internal/principals': async request => {
      const users = principalsBody(await request.json())
      const changed: string[] = []
      store.tx(() => {
        for (const user of users) {
          const before = store.principals.get(user.userId)
          const same = before !== undefined && before.disabled === user.disabled && JSON.stringify(before.groups) === JSON.stringify([...user.groups].sort())
          store.principals.upsert(user, core.clock())
          if (!same) changed.push(user.userId)
        }
      })
      if (changed.length > 0) await hooks.principalsChanged?.(changed)
      return { changed: changed.length }
    },
    'POST /internal/audit/drain': async () => ({ events: store.audit.pending() }),
    'POST /internal/audit/ack': async request => {
      const upTo = (await request.json()).upTo
      if (typeof upTo !== 'number' || !Number.isSafeInteger(upTo) || upTo < 0) throw new KbError(400, 'body')
      return { removed: store.audit.ack(upTo) }
    },
  }
}

/** Compile routes for personal KBs.
 * @param core Service core.
 * @param jobs Job runner, when compile is configured.
 * @returns Route table.
 */
export function compileRoutes(core: KbCore, jobs: ReturnType<typeof compileJobs> | undefined): KbRoutes {
  const runner = () => { if (jobs === undefined) throw new KbError(503, 'compile-unavailable'); return jobs }
  return {
    'POST /me/kb/compile': async request => {
      const body = await request.json()
      return { job: jobView(await runner().request(request.actor, core.ownKb(request.actor.userId, body.kb), body)) }
    },
    'GET /me/kb/jobs': async ({ actor, query }) => ({ jobs: core.store.jobs.byKb(core.ownKb(actor.userId, query.get('kb')).id).map(jobView) }),
  }
}

/** Share and publication state of one KB as its author sees it. */
export function personalState(core: KbCore, kbId: string) {
  const pending = core.store.requests.pendingOf(kbId)
  const publication = core.store.publications.get(kbId)
  const last = core.store.requests.byKb(kbId)[0]
  const job = core.store.jobs.byKb(kbId)[0]
  const conversion = core.store.conversions.from(kbId)
  const share = pending !== undefined ? { state: 'pending' as const, requestId: pending.id, submittedAt: pending.submittedAt }
    : publication?.state === 'active' ? { state: 'published' as const, publishedAt: publication.publishedAt, scope: core.store.scopes.get(kbId) }
      : publication?.state === 'revoked' ? { state: 'revoked' as const, revokedAt: publication.revokedAt }
        : conversion !== undefined && (last === undefined || last.submittedAt <= conversion.at) ? { state: 'converted' as const, convertedAt: conversion.at }
          : last?.state === 'rejected' ? { state: 'rejected' as const, reason: last.reason, decidedAt: last.decidedAt }
            : { state: 'private' as const }
  return { share, lastJob: job === undefined ? null : jobView(job) }
}

/** Start the service.
 * @param config Settings.
 * @param extra Route modules added by later phases.
 * @returns Handle.
 */
export async function startKbService(config: KbServiceConfig, extra: Array<(core: KbCore) => KbRoutes> = []): Promise<KbService> {
  await prepareRoot(config.root)
  const store = openKbStore(join(config.root, 'kb.sqlite'))
  const core = createCore({ store, root: config.root, users: config.users, runner: config.runner, ...config.orgRunner ? { orgRunner: config.orgRunner } : {}, ...config.clock ? { clock: config.clock } : {}, ...config.log ? { log: config.log } : {} })
  const jobs = config.jobs === undefined ? undefined : compileJobs(core, config.jobs)
  const share = shareModule(core, config.requestTtlMs === undefined ? {} : { requestTtlMs: config.requestTtlMs })
  const routes: KbRoutes = { ...baseRoutes(core, { principalsChanged: async ids => { await reconcileViews(core, ids) } }), ...compileRoutes(core, jobs), ...contentModule(core), ...share.routes, ...orgModule(core, jobs), ...limitsModule(core) }
  for (const module of extra) Object.assign(routes, module(core))
  const server = await listenKbSocket(kbHandler(routes, config.log), config.socket, config.socketMode ?? 0o600, config.socketGid)
  jobs?.recover()
  const sweep = async () => { try { await share.sweep(); await reconcileViews(core) } catch (error) { core.log(`kb: sweep failed: ${(error as Error).message}`) } }
  const interval = config.sweepIntervalMs ?? 600_000
  const timer = interval > 0 ? setInterval(() => { void sweep() }, interval) : undefined
  timer?.unref()
  return {
    core, jobs,
    async close() {
      if (timer !== undefined) clearInterval(timer)
      await jobs?.settled()
      await reconcileViews(core, [])
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    },
  }
}
