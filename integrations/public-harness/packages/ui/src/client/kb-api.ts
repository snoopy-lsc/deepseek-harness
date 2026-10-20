/** Personal knowledge base client for the identity service's `/account/api/me/kb*` endpoints (forwarded to the KB service). */
import { AccountApiError, ME_PATH } from './me.ts'

export type KbLimitName = 'max_kbs' | 'max_bytes' | 'max_pages'
export interface KbLimit { readonly value: number | null; readonly source: string }
export type KbJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'over-limit' | 'cancelled'
export interface KbJob {
  readonly id: string; readonly kbId: string; readonly op: 'ingest' | 'lint' | 'rebuild'; readonly state: KbJobState; readonly requestedBy: string; readonly chargedTo: string
  readonly queuedAt: number; readonly startedAt: number | null; readonly finishedAt: number | null; readonly inputTokens: number; readonly outputTokens: number; readonly error: string | null
  readonly report: { readonly changed: readonly string[]; readonly lint: readonly string[]; readonly log: readonly string[]; readonly branch?: string
    readonly limit?: { readonly name: KbLimitName; readonly value: number; readonly allowed: number } } | null
}
export type KbShare =
  | { readonly state: 'private' }
  | { readonly state: 'pending'; readonly requestId: string; readonly submittedAt: number }
  | { readonly state: 'published'; readonly publishedAt: number; readonly scope: ReadonlyArray<{ readonly kind: 'company' | 'group' | 'user'; readonly target: string }> }
  | { readonly state: 'revoked'; readonly revokedAt: number | null }
  | { readonly state: 'converted'; readonly convertedAt: number }
  | { readonly state: 'rejected'; readonly reason: string | null; readonly decidedAt: number | null }
export interface KbItem {
  readonly id: string; readonly kind: 'personal' | 'org'; readonly title: string; readonly description: string; readonly slug: string
  readonly bytes: number; readonly pages: number; readonly sources: number; readonly createdAt: number; readonly archivedAt: number | null
  readonly share: KbShare; readonly lastJob: KbJob | null
}
export interface KbOverview {
  readonly kbs: readonly KbItem[]
  readonly limits: Record<KbLimitName, KbLimit>
  readonly usage: { readonly kbs: number; readonly maxBytes: number; readonly maxPages: number }
  readonly over: ReadonlyArray<{ readonly limit: KbLimitName; readonly kbId?: string; readonly value: number; readonly allowed: number }>
}
export interface KbShared { readonly id: string; readonly title: string; readonly kind: 'personal' | 'org'; readonly owner: string | null; readonly publishedAt: number; readonly path: string }

/** Authenticated directory listing of the current private or published KB revision. */
export interface KbContent {
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }>
  readonly revision: string
  readonly readOnly: boolean
}
/** Safe read-only text preview; null text identifies a format without a preview. */
export interface KbFile { readonly path: string; readonly bytes: number; readonly text: string | null; readonly truncated: boolean }

export interface KbApi {
  /** List files in an owned KB or an authorized active publication.
   * @param kbId - Knowledge-base identifier.
   * @returns The available files and their revision and read-only policy.
   */
  content(kbId: string): Promise<KbContent>
  /** Read a file without executing markup or loading remote content.
   * @param kbId - Knowledge-base identifier.
   * @param path - Server-listed relative file path.
   * @returns A bounded plain-text preview, or null text for an unsupported format.
   */
  file(kbId: string, path: string): Promise<KbFile>
  overview(): Promise<KbOverview>
  create(title: string, description: string): Promise<KbItem>
  upload(kbId: string, file: { name: string; data: Blob }): Promise<void>
  compile(kbId: string, op: KbJob['op']): Promise<KbJob>
  jobs(kbId: string): Promise<readonly KbJob[]>
  share(kbId: string, note: string): Promise<void>
  withdraw(kbId: string): Promise<void>
  archive(kbId: string): Promise<void>
  /** Undefined when the server has no shared list. */
  shared(): Promise<readonly KbShared[]>
}

/** Create the client.
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The client.
 */
export function createKbApi(fetcher?: typeof fetch): KbApi {
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const reply = await (fetcher ?? globalThis.fetch)(`${ME_PATH}${path}`, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...init.headers } })
    let parsed: unknown
    try { parsed = await reply.json() } catch { parsed = undefined }
    if (!reply.ok) {
      const code = (parsed as { code?: unknown } | undefined)?.code
      throw new AccountApiError(reply.status, typeof code === 'string' ? code : String(reply.status))
    }
    return parsed
  }
  const post = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return {
    content: async kbId => await request(`/kb/content?kb=${encodeURIComponent(kbId)}`) as KbContent,
    file: async (kbId, path) => await request(`/kb/content?kb=${encodeURIComponent(kbId)}&path=${encodeURIComponent(path)}`) as KbFile,
    overview: async () => await request('/kb') as KbOverview,
    create: async (title, description) => (await post('/kb', { title, description }) as { kb: KbItem }).kb,
    upload: async (kbId, file) => {
      await request(`/kb/sources?kb=${encodeURIComponent(kbId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file.data })
    },
    compile: async (kbId, op) => (await post('/kb/compile', { kb: kbId, op }) as { job: KbJob }).job,
    jobs: async kbId => (await request(`/kb/jobs?kb=${encodeURIComponent(kbId)}`) as { jobs: KbJob[] }).jobs,
    share: async (kbId, note) => { await post('/kb/share', { kb: kbId, note }) },
    withdraw: async kbId => { await post('/kb/share/withdraw', { kb: kbId }) },
    archive: async kbId => { await post('/kb/archive', { kb: kbId }) },
    shared: async () => (await request('/kb/shared') as { kbs: KbShared[] }).kbs,
  }
}
