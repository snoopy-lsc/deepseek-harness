/** Generators for dsh-plugins systemd socket unit text (installer fills ListenStream from ports.market). */
import type { PortRange } from '@public-harness/contracts'
import { validatePortRange } from '@public-harness/contracts'

/** Default path of the ExecStartPost loader that loads `inet dsh_market` (sketch; install lands with packaging). */
export const DEFAULT_MARKET_LOADER_PATH = '/usr/lib/dsh-public/load-dsh-market.sh'

/** Render `dsh-plugins.socket` with one loopback ListenStream per port and a non-fatal market table loader. */
export function renderPluginsSocketUnit(options: {
  readonly marketPorts: PortRange
  readonly loaderPath?: string
}): string {
  const range = validatePortRange(options.marketPorts, 'ports.market')
  const loader = options.loaderPath ?? DEFAULT_MARKET_LOADER_PATH
  if (typeof loader !== 'string' || !loader.startsWith('/') || loader.includes('\n')) {
    throw new Error('loaderPath must be an absolute path')
  }
  const listens: string[] = []
  for (let port = range.min; port <= range.max; port += 1) {
    listens.push(`ListenStream=127.0.0.1:${port}`)
  }
  return [
    '[Unit]',
    'Description=Team Harness plugin market ports (one ListenStream per ports.market entry)',
    'PartOf=dsh-public.target',
    'Before=dsh-provisioner.service',
    '',
    '[Socket]',
    'BindIPv6Only=both',
    ...listens,
    'Service=dsh-plugins.service',
    'RemoveOnStop=yes',
    // Non-fatal: missing nft must not fail the socket unit or block instance starts (dsh_market loader).
    `ExecStartPost=-${loader}`,
    '',
    '[Install]',
    'WantedBy=sockets.target',
    '',
  ].join('\n')
}
