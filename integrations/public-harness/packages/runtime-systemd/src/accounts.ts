/** Locked native accounts use system units, with no user manager or supplementary groups. */
import type { UserId } from '@public-harness/contracts'
import { createAccountDirectory, deriveNames, ensureAccount, type AccountIdentity } from '@public-harness/provisioner/accounts'
import { type CommandRunner } from '@public-harness/provisioner/system'
import { NativeHostError, type SystemdConfig } from './config.ts'

/** Reconcile the derived account and reject unlocked passwords or additional group membership.
 * @param userId Validated opaque owner.
 * @param config Resolved settings; the caller must validate root-owned assets before using host executables.
 * @param runner Trusted account-command adapter.
 * @returns Numeric identity; partial account creation remains owned by the common provisioning record on failure.
 */
export async function ensureNativeAccount(userId: UserId, config: SystemdConfig, runner: CommandRunner): Promise<AccountIdentity> {
  const account = deriveNames(userId).account
  const bounded: CommandRunner = { run: (command, args) => runner.run(command, args, { timeoutMs: config.operationTimeoutMs }) }
  try {
    const directory = createAccountDirectory(bounded, config.tools, { kind: 'systemd' })
    const identity = await ensureAccount(directory, account, `${config.paths.storageRoot}/users/${account}/home`, config.tools.nologin)
    return { uid: identity.uid, gid: identity.gid }
  } catch (cause) {
    if (cause instanceof NativeHostError) throw cause
    throw new NativeHostError('account-conflict', 'account-reconciliation', cause)
  }
}
