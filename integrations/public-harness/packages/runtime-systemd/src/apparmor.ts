/** Allowlisted host reads and inherited execution; only the pinned browser binary changes to a named child profile. */
import type { RuntimeInstance } from '@public-harness/contracts'
import type { SystemdConfig } from './config.ts'

/** Child profile name; the kernel label is `<account>//chromium`. */
export const BROWSER_CHILD_PROFILE = 'chromium'

function shared(instance: RuntimeInstance, config: SystemdConfig, userExec: string): string[] {
  return [
    'network inet stream,', 'network inet dgram,', 'network inet6 stream,', 'network inet6 dgram,',
    'unix (create, bind, listen, shutdown, getattr, setattr, getopt, setopt),',
    '/ r,', '/usr/ r,', '/etc/{ld.so.cache,ld.so.conf,localtime,nsswitch.conf,passwd,group,resolv.conf,hosts,gai.conf} r,',
    '/etc/{ssl,fonts,alternatives}/** r,', '/proc/ r,', '/proc/{cpuinfo,meminfo,stat,uptime,version,loadavg,filesystems} r,',
    '/proc/sys/kernel/{osrelease,ostype,version} r,', 'owner /proc/[0-9]*/** r,',
    'owner /proc/[0-9]*/{oom_score_adj,comm,task/*/comm} rw,',
    '/sys/devices/system/cpu/** r,', '/sys/devices/system/node/** r,',
    '/dev/{null,zero,full,random,urandom,tty,ptmx} rw,', '/dev/pts/ r,', 'owner /dev/pts/[0-9]* rw,',
    '/dev/shm/ rw,', 'owner /dev/shm/** rwkm,',
    ...[instance.home, instance.workspace, instance.cache, instance.tmp, '/tmp', '/var/tmp'].flatMap(path => [`${path}/ rw,`, `${path}/** ${userExec},`]),
    'deny /run/** rwklx,', 'deny /sys/fs/cgroup/** rwklx,', 'deny /proc/sys/** w,',
    `deny ${config.paths.stateDir}/** rwklx,`, `deny ${config.paths.socketDir}/** rwklx,`,
  ]
}

/** Render one enforcing profile for an account and its descendants, plus the browser child profile.
 * The main profile has no `userns` rule. Only the configured browser executable enters the child profile, which
 * may create a user namespace and hold the namespace-local capabilities Chromium's sandbox needs.
 * @param instance Assigned native account and private paths.
 * @param config Immutable release/toolchain/browser locations.
 * @returns Policy text, not evidence that the kernel has loaded or enforced it.
 */
export function renderAppArmor(instance: RuntimeInstance, config: SystemdConfig): string {
  const account = instance.account, child = `${account}//${BROWSER_CHILD_PROFILE}`, { browser, browserRoot } = config.paths
  const indent = (lines: string[], depth: number) => lines.map(line => `${'  '.repeat(depth)}${line}`)
  return [
    `profile ${account} flags=(mediate_deleted) {`,
    ...indent([
      ...shared(instance, config, 'rwkmix'),
      `unix (connect, accept, send, receive) peer=(label=${account}),`,
      `signal (send, receive) peer=${account},`, `signal (send) peer=${child},`, 'signal (receive) peer=unconfined,',
      `ptrace (read, readby, trace, tracedby) peer=${account},`,
      '/usr/** rmix,', '/{bin,sbin,lib,lib64}/** rmix,',
      `${config.paths.release}/ r,`, `${config.paths.release}/** rmix,`,
      `${config.paths.toolchain}/ r,`, `${config.paths.toolchain}/** rmix,`,
      `${browser} Cx -> ${BROWSER_CHILD_PROFILE},`,
      '',
      `profile ${BROWSER_CHILD_PROFILE} flags=(mediate_deleted) {`,
      ...indent([
        ...shared(instance, config, 'rwkm'),
        `unix (connect, accept, send, receive) peer=(label=${child}),`,
        `signal (send, receive) peer=${child},`, `signal (receive) peer=${account},`, 'signal (receive) peer=unconfined,',
        `ptrace (read, readby, trace, tracedby) peer=${child},`,
        'userns,', 'capability sys_admin,', 'capability sys_chroot,', 'capability setuid,', 'capability setgid,',
        'owner /proc/[0-9]*/{uid_map,gid_map,setgroups} w,',
        '/usr/** rm,', '/{bin,sbin,lib,lib64}/** rm,',
        `${browserRoot}/ r,`, `${browserRoot}/** rm,`, `${browser} ix,`, `${browserRoot}/**/chrome_crashpad_handler ix,`,
      ], 1),
      '}',
    ], 1),
    '}', '',
  ].join('\n')
}
