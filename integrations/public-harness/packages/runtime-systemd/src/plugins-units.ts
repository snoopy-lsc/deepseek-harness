/** Generators for dsh-plugins systemd socket unit text (installer fills ListenStream from ports.market). */
import type { PortRange } from '@public-harness/contracts'
import { validatePortRange } from '@public-harness/contracts'
import { DEFAULT_MARKET_RULES_PATH } from './market-firewall.ts'

/** Installed path of the loader that loads `inet dsh_market` (`deploy/native/scripts/load-dsh-market.sh`). */
export const DEFAULT_MARKET_LOADER_PATH = '/usr/lib/dsh-public/load-dsh-market.sh'

const absolute = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\s\n"'\\]/.test(value)) throw new Error(`${name} must be an absolute path`)
  return value
}

/** Render `dsh-plugins.socket` with one loopback ListenStream per port and a fatal market table loader.
 * The loader runs as `ExecStartPost=` without the `-` prefix: when `inet dsh_market` cannot be loaded the socket unit
 * fails and systemd closes every market listener, so the market is unreachable instead of reachable by every account.
 * `PartOf=nftables.service` restarts the socket (and so reruns the loader) when the host ruleset is reloaded.
 */
export function renderPluginsSocketUnit(options: {
  readonly marketPorts: PortRange
  readonly loaderPath?: string
  readonly rulesPath?: string
}): string {
  const range = validatePortRange(options.marketPorts, 'ports.market')
  const loader = absolute(options.loaderPath ?? DEFAULT_MARKET_LOADER_PATH, 'loaderPath')
  const rules = absolute(options.rulesPath ?? DEFAULT_MARKET_RULES_PATH, 'rulesPath')
  const listens: string[] = []
  for (let port = range.min; port <= range.max; port += 1) {
    listens.push(`ListenStream=127.0.0.1:${port}`)
  }
  return [
    '[Unit]',
    'Description=Team Harness plugin market ports (one ListenStream per ports.market entry)',
    'PartOf=dsh-public.target',
    // A host ruleset reload (`nft flush ruleset` in nftables.service) drops inet dsh_market; restart to reload it.
    'After=nftables.service',
    'PartOf=nftables.service',
    'Before=dsh-provisioner.service',
    '',
    '[Socket]',
    ...listens,
    'Service=dsh-plugins.service',
    'RemoveOnStop=yes',
    // Fatal: with ports.market enabled the per-owner table must load, or no market port stays open.
    `ExecStartPost=${loader} ${rules}`,
    // The loader's private copy lives in this unit's own /tmp, which systemd removes with the unit (even if the
    // loader is killed before its own cleanup runs).
    'PrivateTmp=yes',
    '',
    '[Install]',
    'WantedBy=sockets.target',
    '',
  ].join('\n')
}
