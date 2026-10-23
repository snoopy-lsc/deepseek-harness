/** Personal plugin market client for `/account/api/me/plugins*` (forwarded to dsh-plugins). */
import { AccountApiError, ME_PATH } from './me.ts'

export type PluginSource =
  | { readonly type: 'npm'; readonly registry: string; readonly name: string; readonly version: string }
  | { readonly type: 'git'; readonly url: string; readonly commit: string; readonly name: string; readonly version: string; readonly path?: string }
  | { readonly type: 'upload'; readonly name: string; readonly version: string }

export type PluginSubmissionState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'revoked'

export interface PluginSubmission {
  readonly versionId: string; readonly packageId: string; readonly name: string; readonly version: string
  readonly state: PluginSubmissionState; readonly mirrorState?: string; readonly submittedAt?: number
  readonly reason?: string | null; readonly note?: string | null
}

export interface PluginDefault {
  readonly packageId: string; readonly name?: string; readonly state: string; readonly optedOut?: boolean
}

export interface PluginSnapshot {
  readonly id: string; readonly savedAt: number; readonly label?: string | null
}

export interface PluginsOverview {
  readonly submissions: readonly PluginSubmission[]
  readonly defaults: readonly PluginDefault[]
  readonly revoked?: boolean
  readonly restartRequired?: boolean
}

export interface PluginsApi {
  overview(): Promise<PluginsOverview>
  submit(input: { name: string; version: string; source: PluginSource; note?: string }): Promise<void>
  withdraw(versionId: string): Promise<void>
  delistRequest(packageId: string): Promise<void>
  reenableDefault(packageId: string): Promise<void>
  snapshots(): Promise<readonly PluginSnapshot[]>
  restore(snapshotId: string): Promise<void>
}

/** Create the personal plugins client.
 * @param fetcher - `fetch`, injectable for tests.
 * @returns The client.
 */
export function createPluginsApi(fetcher?: typeof fetch): PluginsApi {
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
    overview: async () => {
      const body = await request('/plugins') as Partial<PluginsOverview> & { plugins?: readonly PluginSubmission[] }
      return {
        submissions: body.submissions ?? body.plugins ?? [],
        defaults: body.defaults ?? [],
        revoked: body.revoked,
        restartRequired: body.restartRequired,
      }
    },
    submit: async input => { await post('/plugins/submit', input) },
    withdraw: async versionId => { await post('/plugins/withdraw', { versionId }) },
    delistRequest: async packageId => { await post('/plugins/delist-request', { packageId }) },
    reenableDefault: async packageId => { await post('/plugins/defaults/reenable', { packageId }) },
    snapshots: async () => (await request('/plugins/snapshots') as { snapshots?: PluginSnapshot[] }).snapshots ?? [],
    restore: async snapshotId => { await post('/plugins/restore', { snapshotId }) },
  }
}
