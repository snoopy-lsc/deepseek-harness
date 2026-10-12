/** System services retain one account, AppArmor profile and cgroup across every child process. */
import type { RuntimeInstance } from '@public-harness/contracts'
import type { SystemdConfig } from './config.ts'

/** Render a root-owned service without starting it or initializing a workspace.
 * @param instance Fully allocated native instance.
 * @param config Resolved immutable launch assets and resource limits.
 * @returns Unit text; installation, observed enforcement and readiness are separate admission operations.
 */
export function renderUnit(instance: RuntimeInstance, config: SystemdConfig): string {
  const { home, workspace, cache, tmp } = instance, { limits, paths, tools } = config
  return [
    '[Unit]', 'Description=Private Harness instance', 'After=network.target', '', '[Service]', 'Type=exec',
    `User=${instance.uid}`, `Group=${instance.gid}`, 'SupplementaryGroups=', 'UMask=0077',
    `WorkingDirectory=${workspace}`, `Environment=HOME=${home} DSH_HOME=${home} XDG_CACHE_HOME=${cache} TMPDIR=${tmp}`,
    `Environment=PATH=${paths.toolchain}:/usr/bin:/usr/sbin`,
    `Environment=PUBLIC_HARNESS_WEB_PORT=${instance.webPort} PUBLIC_HARNESS_QUOTA_PORT=${instance.quotaPort} PUBLIC_HARNESS_INSTANCE_ID=${instance.instanceId}`,
    `ExecStart=${tools.node} ${paths.dsh} --profile ${config.profile} --patch ${paths.launchPatch}`,
    `AppArmorProfile=${instance.account}`, 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
    'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectControlGroups=yes',
    'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'ProtectClock=yes',
    'ProtectProc=invisible', 'ProcSubset=all', 'PrivateDevices=yes', 'PrivateIPC=yes', 'RemoveIPC=yes', 'Delegate=no',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    `ReadWritePaths=${home} ${workspace} ${cache} ${tmp}`, `BindPaths=${tmp}:/tmp ${tmp}:/var/tmp`,
    `TemporaryFileSystem=/dev/shm:rw,nosuid,nodev,size=${limits.shmBytes},nr_inodes=${limits.shmInodes},mode=1777`,
    `InaccessiblePaths=${paths.stateDir} ${paths.socketDir} /run/dbus /run/systemd /run/user`,
    `CPUQuota=${limits.cpus * 100}%`, `MemoryMax=${limits.memoryBytes}`, 'MemorySwapMax=0',
    `TasksMax=${limits.pids}`, `LimitNOFILE=${limits.openFiles}`, 'LimitCORE=0', 'OOMPolicy=kill',
    'KillMode=control-group', 'SendSIGKILL=yes', `TimeoutStartSec=${config.readyTimeoutMs}ms`, `TimeoutStopSec=${config.stopTimeoutMs}ms`,
    'StandardOutput=null', 'StandardError=null', 'Restart=no', '',
  ].join('\n')
}
