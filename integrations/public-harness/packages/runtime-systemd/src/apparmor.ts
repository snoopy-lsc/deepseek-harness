/** Allowlisted host reads and inherited execution; no abstraction grants hidden profile transitions. */
import type { RuntimeInstance } from '@public-harness/contracts'
import type { SystemdConfig } from './config.ts'

/** Render one enforcing profile for an account and all of its descendants.
 * @param instance Assigned native account and private paths.
 * @param config Immutable release/toolchain locations.
 * @returns Policy text, not evidence that the kernel has loaded or enforced it.
 */
export function renderAppArmor(instance: RuntimeInstance, config: SystemdConfig): string {
  return [
    `profile ${instance.account} flags=(mediate_deleted) {`,
    '  network inet stream,', '  network inet dgram,', '  network inet6 stream,', '  network inet6 dgram,',
    '  unix (create, bind, listen, shutdown, getattr, setattr, getopt, setopt),', `  unix (connect, accept, send, receive) peer=(label=${instance.account}),`,
    `  signal (send, receive) peer=${instance.account},`, '  signal (receive) peer=unconfined,',
    `  ptrace (read, readby, trace, tracedby) peer=${instance.account},`,
    '  userns,', '  / r,', '  /usr/ r,', '  /usr/** rmix,', '  /{bin,sbin,lib,lib64}/** rmix,',
    `  ${config.paths.release}/ r,`, `  ${config.paths.release}/** rmix,`,
    `  ${config.paths.toolchain}/ r,`, `  ${config.paths.toolchain}/** rmix,`,
    '  /etc/{ld.so.cache,ld.so.conf,localtime,nsswitch.conf,passwd,group,resolv.conf,hosts,gai.conf} r,',
    '  /etc/{ssl,fonts,alternatives}/** r,', '  /proc/ r,', '  /proc/{cpuinfo,meminfo,stat,uptime,version,loadavg,filesystems} r,',
    '  /proc/sys/kernel/{osrelease,ostype,version} r,', '  owner /proc/[0-9]*/** r,',
    '  owner /proc/[0-9]*/{oom_score_adj,comm,task/*/comm} rw,',
    '  /sys/devices/system/cpu/** r,', '  /sys/devices/system/node/** r,',
    '  /dev/{null,zero,full,random,urandom,tty,ptmx} rw,', '  /dev/pts/ r,', '  owner /dev/pts/[0-9]* rw,',
    '  /dev/shm/ rw,', '  owner /dev/shm/** rwkm,',
    ...[instance.home, instance.workspace, instance.cache, instance.tmp, '/tmp', '/var/tmp'].flatMap(path => [`  ${path}/ rw,`, `  ${path}/** rwkmix,`]),
    '  deny /run/** rwklx,', '  deny /sys/fs/cgroup/** rwklx,', '  deny /proc/sys/** w,',
    `  deny ${config.paths.stateDir}/** rwklx,`, `  deny ${config.paths.socketDir}/** rwklx,`,
    '}', '',
  ].join('\n')
}
