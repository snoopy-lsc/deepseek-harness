/** Automatic deprovisioning: periodic reconciliation of SSO-bound accounts against the directory (LDAP/AD, WeCom, DingTalk) and an
 * inactivity policy for every provider. Fail-safe: a lookup error, an unreachable directory or an implausibly large result never disables anyone. */
import type { IdentityDatabase } from '../database.ts'
import type { DeprovisionConfig } from './config.ts'
import type { DirectoryLookup } from './provider.ts'

const DAY = 86_400_000

/** Result of one run. */
export interface ReconcileReport {
  /** Bindings examined (already disabled ones are not). */
  readonly checked: number
  readonly disabled: ReadonlyArray<{ readonly userId: string; readonly reason: string }>
  /** Bindings left alone because their lookup failed. */
  readonly skipped: number
  /** True when the directory asked for more disables than `maxDisablePerRun`; none of those were applied. */
  readonly aborted: boolean
}

/** Collaborators of one run. */
export interface ReconcileDeps {
  readonly database: IdentityDatabase
  /** Provider kind whose bindings are reconciled. */
  readonly kind: string
  readonly directory?: DirectoryLookup
  /** D7 allow-list in the provider's group form (normalized DNs for LDAP). */
  readonly allowedGroups: readonly string[]
  readonly policy: DeprovisionConfig
  readonly now: number
  readonly log?: (line: string) => void
}

/** Reconcile every binding of one provider once.
 * @param deps Database, provider kind and directory, allow-list, policy, clock and log sink.
 * @returns What was checked, disabled and skipped.
 */
export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { database, policy, now } = deps
  const log = deps.log ?? (() => {})
  const allowed = new Set(deps.allowedGroups)
  const links = database.sso.listLinks(deps.kind).filter(link => database.sso.disabledAt(link.userId) === undefined)
  const local: Array<{ userId: string; reason: string }> = [], remote: Array<{ userId: string; reason: string }> = []
  let skipped = 0
  for (const link of links) {
    // Inactivity is decided from local data only, so it applies to providers without a directory and while a directory is down.
    if (policy.maxInactiveDays > 0 && (link.lastLoginAt ?? link.createdAt) <= now - policy.maxInactiveDays * DAY) { local.push({ userId: link.userId, reason: 'inactive' }); continue }
    if (deps.directory === undefined) continue
    let record
    try { record = await deps.directory.lookup(link.subject) } catch {
      // Unreachable directory, timeout, permission or protocol error: log and skip, never disable on an error.
      skipped++
      continue
    }
    if (record === undefined) continue
    if (record.status === 'missing') remote.push({ userId: link.userId, reason: 'directory-missing' })
    else if (record.status === 'disabled') remote.push({ userId: link.userId, reason: 'directory-disabled' })
    else if (!record.groups.some(group => allowed.has(group))) remote.push({ userId: link.userId, reason: 'directory-group' })
  }
  // A wrong base DN, a scope change or a directory answering "not found" for everyone would look like a mass departure; refuse to act on it.
  const aborted = remote.length > policy.maxDisablePerRun
  const disabled: Array<{ userId: string; reason: string }> = []
  const email = database.db.prepare('SELECT email FROM user WHERE id = ?')
  for (const item of aborted ? local : [...local, ...remote]) {
    const address = (email.get(item.userId) as { email: string } | undefined)?.email
    if (database.sso.disableUser(item.userId, item.reason, now, address)) disabled.push(item)
  }
  const detail = `checked=${links.length} disabled=${disabled.length} skipped=${skipped}${aborted ? ` aborted=${remote.length}>${policy.maxDisablePerRun}` : ''}`
  database.sso.audit({ event: 'sso-reconcile', outcome: aborted || skipped ? 'error' : 'ok', detail }, now)
  log(`identity: sso reconcile ${deps.kind} ${detail}`)
  return { checked: links.length, disabled, skipped, aborted }
}
