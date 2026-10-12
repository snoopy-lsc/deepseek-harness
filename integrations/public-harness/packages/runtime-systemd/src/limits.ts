/** XFS user quotas bound all account-owned disk data; functional verification belongs to admission probes. */
import type { RuntimeInstance } from '@public-harness/contracts'
import { runChecked, type CommandRunner } from '@public-harness/provisioner/system'
import { NativeHostError, type SystemdConfig } from './config.ts'

/** Apply hard byte and inode ceilings before handing writable directories to the user.
 * @param instance Assigned account.
 * @param config Resolved XFS mount and limits.
 * @param runner Privileged command adapter.
 * @returns Resolves after the quota command; callers must verify actual enforcement before execution.
 */
export async function applyDiskLimits(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void> {
  try {
    await runChecked(runner, config.tools.xfsQuota, ['-x', '-c',
      `limit -u bsoft=0 bhard=${config.limits.diskBytes / 1024}k isoft=0 ihard=${config.limits.diskInodes} ${instance.uid}`, config.paths.quotaMount],
    { timeoutMs: config.operationTimeoutMs })
  } catch (cause) { throw new NativeHostError('host-operation', 'disk-quota', cause) }
}
