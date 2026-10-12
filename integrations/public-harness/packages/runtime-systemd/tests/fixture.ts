import { parseInstanceId, parseUserId, type RuntimeInstance } from '@public-harness/contracts'
import { deriveNames } from '@public-harness/provisioner/accounts'
import { parseSystemdConfig } from '../src/config.ts'

export const common = {
  paths: { storageRoot: '/srv/dsh/data', stateDir: '/srv/dsh/state', socketDir: '/run/dsh/sockets', quotaMount: '/srv/dsh' },
  tools: { getent: '/usr/bin/getent', useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel', nologin: '/usr/sbin/nologin' },
  runtime: { kind: 'systemd', configFile: '/etc/dsh/native.json' }, socketGid: 100, maxActiveInstances: 4, idleStopMs: 600000, deletionRecoveryMs: 86400000,
  limits: { cpus: 2, memoryBytes: 1073741824, pids: 512, openFiles: 4096, diskBytes: 5368709120 },
  readyTimeoutMs: 30000, stopTimeoutMs: 15000, ports: { quota: { min: 29100, max: 29109 } },
}
export const native = {
  paths: { release: '/opt/dsh/release', releaseManifest: '/opt/dsh/release/release-manifest.json', toolchain: '/opt/dsh/toolchain',
    dsh: '/opt/dsh/release/dsh.mjs', launchPatch: '/opt/dsh/release/native.yml',
    browserRoot: '/opt/dsh/browser', browser: '/opt/dsh/browser/chrome-linux64/chrome' },
  tools: { node: '/opt/dsh/toolchain/node', systemctl: '/usr/bin/systemctl', apparmorParser: '/usr/sbin/apparmor_parser',
    xfsQuota: '/usr/sbin/xfs_quota', nft: '/usr/sbin/nft',
    systemdRun: '/usr/bin/systemd-run', git: '/usr/bin/git' },
  profile: 'public-user', diskInodes: 100000, shmBytes: 67108864, shmInodes: 4096, operationTimeoutMs: 10000,
  web: { min: 29200, max: 29209 }, resolver: '1.1.1.1', publicEgress: { tcp: [80, 443], udp: [] },
}
export const config = () => parseSystemdConfig({ common, native })
export function instance(): RuntimeInstance {
  const userId = parseUserId('native-alice'), names = deriveNames(userId), root = `${common.paths.storageRoot}/users/${names.account}`
  return { userId, instanceId: parseInstanceId('native_1'), runtime: { kind: 'systemd', unit: names.unit }, account: names.account,
    uid: 1201, gid: 1201, home: `${root}/home`, workspace: `${root}/workspace`, cache: `${root}/cache`, tmp: `${root}/tmp`,
    controlDir: `${common.paths.stateDir}/runtime/${names.account}`, webPort: 29200, quotaPort: 29100 }
}
