/** Per-account nftables policy in one owned table; every change is a single `nft -f` transaction. */
import type { PortRange, RuntimeInstance } from '@public-harness/contracts'
import { formatMarketPorts } from './market-firewall.ts'
import { runChecked, type CommandRunner } from '@public-harness/provisioner/system'
import { NativeHostError, type SystemdConfig } from './config.ts'
import { writeControlFile } from './storage.ts'

/** The only nftables table this provider creates or edits; host rules elsewhere are never touched. */
export const NATIVE_TABLE = 'dsh_native'
const PRIVATE_V4 = '{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 }'
const PRIVATE_V6 = '{ ::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10, ff00::/8 }'

/** The account's own slice unit; systemd maps the dashes in its name to `dsh.slice/dsh-user.slice/<slice>`. */
export function unitSlice(instance: RuntimeInstance): string {
  if (instance.runtime.kind !== 'systemd') throw new NativeHostError('invalid-config', 'runtime-selection')
  return instance.runtime.unit.replace(/\.service$/, '.slice')
}

/** Cgroup path of the account's slice, as `socket cgroupv2` matches it (relative to the cgroup2 root).
 * The slice is started before the rules load, so the path exists when nft resolves it; the service and
 * any confined helper the provider starts for the account run below it.
 */
export function unitCgroup(instance: RuntimeInstance): { path: string; level: number; service: string } {
  const slice = unitSlice(instance), path = `dsh.slice/dsh-user.slice/${slice}`
  return { path, level: path.split('/').length, service: `${path}/${instance.runtime.kind === 'systemd' ? instance.runtime.unit : ''}` }
}

/** Base table: owned chains and the UID dispatch map. Idempotent; `add` never replaces existing content. */
export function renderBaseTable(): string {
  return [
    `add table inet ${NATIVE_TABLE}`,
    `add map inet ${NATIVE_TABLE} users_out { type uid : verdict ; }`,
    // Every new loopback connection carries its sender's UID so the input hook can tell the owner from others.
    `add chain inet ${NATIVE_TABLE} output { type filter hook output priority filter - 1 ; policy accept ; }`,
    `add chain inet ${NATIVE_TABLE} input { type filter hook input priority filter - 1 ; policy accept ; }`,
    `flush chain inet ${NATIVE_TABLE} output`,
    `add rule inet ${NATIVE_TABLE} output oif "lo" ct state new ct mark set meta skuid`,
    `add rule inet ${NATIVE_TABLE} output meta skuid vmap @users_out`,
    '',
  ].join('\n')
}

function rules(chain: string, lines: string[]): string[] { return lines.map(line => `add rule inet ${NATIVE_TABLE} ${chain} ${line}`) }

/** Install or replace one account's rules atomically.
 * Output (UID-matched, before any generic accept): established flows of this UID, loopback (judged on input),
 * the resolver, then deny local/private/metadata ranges and allow only configured public ports.
 * Input (matched by the unit cgroup of the receiving socket, and by the sender mark for this UID's own connects):
 * the owner may reach any of its own loopback listeners and its quota port; root may reach only its Web port.
 * When `options.marketPorts` is set, also accept the owner's loopback connects to that range before the final drop
 * (the `dsh_market` drops still narrow it to the port owner and the systemd listener).
 * @param instance Allocated account with recorded ports.
 * @param config Resolver and public egress ports.
 * @param options Optional market port range for the owner accept; omitted keeps prior behaviour.
 * @returns nft script text; `installNetwork` loads it in one transaction. Never loads `dsh_market`.
 */
export function renderUserNetwork(instance: RuntimeInstance, config: SystemdConfig,
  options: { readonly marketPorts?: PortRange } = {}): string {
  const { uid } = instance, out = `out_${uid}`, inn = `in_${uid}`, { path, level } = unitCgroup(instance)
  const resolver = config.resolver.includes(':') ? `ip6 daddr ${config.resolver}` : `ip daddr ${config.resolver}`
  const tcp = config.publicEgress.tcp, udp = config.publicEgress.udp
  const own = `socket cgroupv2 level ${level} "${path}"`
  const marketAccept = options.marketPorts === undefined
    ? []
    : [`ct mark ${uid} iif "lo" tcp dport ${formatMarketPorts(options.marketPorts)} accept`]
  return [
    renderBaseTable(),
    `add chain inet ${NATIVE_TABLE} ${out}`, `flush chain inet ${NATIVE_TABLE} ${out}`,
    `add chain inet ${NATIVE_TABLE} ${inn}`, `flush chain inet ${NATIVE_TABLE} ${inn}`,
    ...rules(out, [
      'ct state established,related accept',
      'oif "lo" accept',
      `${resolver} udp dport 53 accept`, `${resolver} tcp dport 53 accept`,
      `ip daddr ${PRIVATE_V4} drop`, `ip6 daddr ${PRIVATE_V6} drop`,
      ...tcp.length === 0 ? [] : [`tcp dport { ${tcp.join(', ')} } accept`],
      ...udp.length === 0 ? [] : [`udp dport { ${udp.join(', ')} } accept`],
      'counter drop',
    ]),
    ...rules(inn, [
      'ct state established,related accept',
      // No direct ingress from outside the host to any listener the account starts.
      `${own} iif != "lo" counter drop`,
      // New connections into this account's sockets: the owner, or root to the assigned Web port only.
      `${own} ct mark ${uid} accept`,
      `${own} ct mark 0 tcp dport ${instance.webPort} accept`,
      `${own} counter drop`,
      // New connections this account opened elsewhere on loopback: quota, then the market range, then drop.
      `ct mark ${uid} iif "lo" tcp dport ${instance.quotaPort} accept`,
      ...marketAccept,
      `ct mark ${uid} iif "lo" counter drop`,
    ]),
    `add element inet ${NATIVE_TABLE} users_out { ${uid} : jump ${out} }`,
    '',
  ].join('\n')
}

/** Input dispatch for the active accounts; rebuilt as a whole so no rule handle is ever needed.
 * @param instances Every account whose rules are installed, including the one being added.
 * @returns nft script lines that flush and refill the base input chain.
 */
export function renderInputDispatch(instances: readonly RuntimeInstance[]): string {
  return [
    `flush chain inet ${NATIVE_TABLE} input`,
    ...instances.flatMap((instance) => {
      const { path, level } = unitCgroup(instance)
      return [
        `add rule inet ${NATIVE_TABLE} input socket cgroupv2 level ${level} "${path}" ct state new jump in_${instance.uid}`,
        `add rule inet ${NATIVE_TABLE} input iif "lo" ct mark ${instance.uid} ct state new jump in_${instance.uid}`,
      ]
    }),
    '',
  ].join('\n')
}

/** Rules removing one account: the map entry first, so no new connection matches stale chains.
 * @param instance Account being removed.
 * @param remaining Accounts that stay active.
 */
export function renderUserRemoval(instance: RuntimeInstance, remaining: readonly RuntimeInstance[]): string {
  const out = `out_${instance.uid}`, inn = `in_${instance.uid}`
  return [
    renderBaseTable(),
    `add chain inet ${NATIVE_TABLE} ${out}`, `add chain inet ${NATIVE_TABLE} ${inn}`,
    `add element inet ${NATIVE_TABLE} users_out { ${instance.uid} : jump ${out} }`,
    `delete element inet ${NATIVE_TABLE} users_out { ${instance.uid} }`,
    renderInputDispatch(remaining.filter(other => other.uid !== instance.uid)),
    `delete chain inet ${NATIVE_TABLE} ${out}`, `delete chain inet ${NATIVE_TABLE} ${inn}`,
    '',
  ].join('\n')
}

async function load(name: string, script: string, instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner, operation: string) {
  try {
    await writeControlFile(instance.controlDir, name, script)
    await runChecked(runner, config.tools.nft, ['-f', `${instance.controlDir}/${name}`], { timeoutMs: config.operationTimeoutMs })
  } catch (cause) {
    throw cause instanceof NativeHostError ? cause : new NativeHostError('host-operation', operation, cause)
  }
}

/** Install one account's rules and the input dispatch for all active accounts in one transaction.
 * The unit cgroup must exist (unit started with ExecStart blocked, or created by the caller) because nft resolves
 * `socket cgroupv2` paths when the rule loads.
 * @param instance Account being installed.
 * @param config Resolved native settings.
 * @param runner Privileged command adapter.
 * @param active Every other account whose rules stay installed.
 */
export async function installNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner,
  active: readonly RuntimeInstance[] = []): Promise<void> {
  const others = active.filter(other => other.uid !== instance.uid)
  const market = config.ports.market === undefined ? {} : { marketPorts: config.ports.market }
  await load('network.nft', `${renderUserNetwork(instance, config, market)}${renderInputDispatch([...others, instance])}`, instance, config, runner, 'network-install')
}

/** Remove one account's rules in one transaction; other accounts and host tables are unchanged.
 * @param instance Account being removed.
 * @param config Resolved native settings.
 * @param runner Privileged command adapter.
 * @param active Accounts whose rules stay installed.
 */
export async function removeNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner,
  active: readonly RuntimeInstance[] = []): Promise<void> {
  await load('network-remove.nft', renderUserRemoval(instance, active), instance, config, runner, 'network-remove')
}
