/** Derived host identities and the Linux account directory. */
import { createHash } from 'node:crypto'
import { parseContainerName, parseUnitName, type ContainerName, type UnitName, type UserId } from '@public-harness/contracts'
import { runChecked, type CommandRunner } from './system.ts'

/** Account, container, and file names derived only from the opaque user ID. */
export interface DerivedNames { readonly account: string; readonly container: ContainerName; readonly unit: UnitName }

const ACCOUNT_PATTERN = /^dsh-[0-9a-f]{24}$/

/** Derive stable, fixed-shape names; display names, emails, and raw IDs never reach the host. */
export function deriveNames(userId: UserId): DerivedNames {
  const digest = createHash('sha256').update('public-harness/user/v1\0').update(userId).digest('hex').slice(0, 24)
  return { account: `dsh-${digest}`, container: parseContainerName(`dsh-${digest}`), unit: parseUnitName(`dsh-user-${digest}.service`) }
}

/** True only for names this module could have derived. */
export function isDerivedAccountName(value: string): boolean { return ACCOUNT_PATTERN.test(value) }

/** An existing account or home directory is not the one this provisioner would create. */
export class AccountConflictError extends Error {
  override readonly name = 'AccountConflictError'
  constructor(reason: string) { super(`account conflict: ${reason}`) }
}

/** Numeric identity of a host account. */
export interface AccountIdentity { readonly uid: number; readonly gid: number }

/** Tools and fixed names the directory needs. */
export interface AccountToolchain {
  readonly getent: string
  readonly useradd: string
  readonly userdel: string
  readonly loginctl: string
  readonly nologin: string
  /** Shared supplementary group used by firewall rules; created by the host setup, never here. */
  readonly sharedGroup: string
}

/** Operations on host accounts. */
export interface AccountDirectory {
  lookup(account: string): Promise<(AccountIdentity & { readonly home: string; readonly shell: string }) | undefined>
  create(account: string, home: string): Promise<void>
  remove(account: string): Promise<void>
}

function assertAccount(account: string): void {
  if (!isDerivedAccountName(account)) throw new Error('refusing to manage a non-derived account name')
}

/** Host account directory; native lookup verifies password lock and private-group membership, while container accounts retain linger. */
export function createAccountDirectory(runner: CommandRunner, tools: Pick<AccountToolchain, 'getent' | 'useradd' | 'userdel' | 'nologin'>,
  runtime: { readonly kind: 'systemd' } | { readonly kind: 'podman-gvisor'; readonly tools: Pick<AccountToolchain, 'loginctl' | 'sharedGroup'> }): AccountDirectory {
  return {
    async lookup(account) {
      assertAccount(account)
      const result = await runner.run(tools.getent, ['passwd', account])
      if (result.code === 2) return undefined
      if (result.code !== 0) throw new Error('account lookup failed')
      const fields = result.stdout.trim().split(':')
      if (fields.length < 7 || fields[0] !== account) throw new Error('account lookup returned an unexpected entry')
      const uid = Number(fields[2]), gid = Number(fields[3])
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid < 0) throw new Error('account lookup returned an invalid identity')
      if (runtime.kind === 'systemd') {
        const shadow = (await runChecked(runner, tools.getent, ['shadow', account])).trim().split(':')
        const groups = (await runChecked(runner, tools.getent, ['initgroups', account])).trim().split(/\s+/)
        if (gid === 0 || shadow[0] !== account || !/^[!*]/.test(shadow[1] ?? '') || groups[0] !== account
          || groups.length < 2 || groups.slice(1).some(group => group !== String(gid))) {
          throw new AccountConflictError('native account requires a locked password and only its private group')
        }
      }
      return { uid, gid, home: fields[5]!, shell: fields[6]! }
    },
    async create(account, home) {
      assertAccount(account)
      await runChecked(runner, tools.useradd, ['--user-group', '--no-create-home', '--home-dir', home,
        '--shell', tools.nologin, '--password', '!', ...(runtime.kind === 'podman-gvisor' ? ['--groups', runtime.tools.sharedGroup] : []), '--comment', 'public harness instance', account])
      // Rootless Podman needs a persistent user manager and runtime directory for the account.
      if (runtime.kind === 'podman-gvisor') await runChecked(runner, runtime.tools.loginctl, ['enable-linger', account])
    },
    async remove(account) {
      assertAccount(account)
      if (runtime.kind === 'podman-gvisor') await runner.run(runtime.tools.loginctl, ['disable-linger', account])
      await runChecked(runner, tools.userdel, [account])
    },
  }
}

/** Create the account if absent and verify an existing one matches the expected home and shell. */
export async function ensureAccount(directory: AccountDirectory, account: string, home: string,
  nologin: string): Promise<AccountIdentity & { readonly created: boolean }> {
  let existing = await directory.lookup(account)
  let created = false
  if (existing === undefined) {
    await directory.create(account, home)
    created = true
    existing = await directory.lookup(account)
    if (existing === undefined) throw new Error('account creation did not produce an account')
  }
  if (existing.home !== home) throw new AccountConflictError('home directory differs')
  if (existing.shell !== nologin) throw new AccountConflictError('account has a login shell')
  return { uid: existing.uid, gid: existing.gid, created }
}
