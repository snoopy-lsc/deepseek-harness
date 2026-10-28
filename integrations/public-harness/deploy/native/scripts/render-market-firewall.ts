/** Render the native market firewall files from the root-owned configuration (installer step; run as root).
 * Usage: tsx deploy/native/scripts/render-market-firewall.ts <provisioner.json> <plugins.json>
 *          --rules /etc/dsh-public/dsh-market.nft --socket /etc/systemd/system/dsh-plugins.socket
 *          [--listener-cgroup system.slice/dsh-plugins.socket]
 * Writes the `inet dsh_market` ruleset (0600) and `dsh-plugins.socket` (0644), each atomically. Refuses when
 * `ports.market` is not configured (the market stays disabled and neither file is needed) or when the provisioner
 * and plugins ranges differ. Install `load-dsh-market.sh` as /usr/lib/dsh-public/load-dsh-market.sh first. */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { validatePortRange, type PortRange } from '../../../packages/contracts/src/ports.ts'
import { DEFAULT_MARKET_LISTENER_CGROUP, DEFAULT_MARKET_RULES_PATH, checkMarketRulesFile, parseMarketListenerCgroup, renderMarketRulesFile } from '../../../packages/runtime-systemd/src/market-firewall.ts'
import { DEFAULT_MARKET_LOADER_PATH, renderPluginsSocketUnit } from '../../../packages/runtime-systemd/src/plugins-units.ts'

/** Rendered texts for one configuration. */
export interface MarketFirewallFiles { readonly rules: string; readonly socket: string; readonly marketPorts: PortRange }

/** Render both files from parsed configuration objects (pure; used by tests and `main`).
 * @param provisionerProfile Parsed provisioner.json (`{ provisioner: { ports: { market } } }`).
 * @param plugins Parsed plugins.json (`{ ports: { market } }`).
 * @param options Listener cgroup measured by P0.8 and installed paths.
 */
export function renderMarketFirewallFiles(provisionerProfile: unknown, plugins: unknown,
  options: { readonly listenerCgroup?: string; readonly loaderPath?: string; readonly rulesPath?: string } = {}): MarketFirewallFiles {
  const provisionerMarket = (provisionerProfile as { provisioner?: { ports?: { market?: unknown } } } | null)?.provisioner?.ports?.market
  const pluginsMarket = (plugins as { ports?: { market?: unknown } } | null)?.ports?.market
  if (provisionerMarket === undefined) throw new Error('ports.market is not configured: the market is disabled, so no market firewall is rendered')
  const marketPorts = validatePortRange(provisionerMarket, 'provisioner ports.market')
  const fromPlugins = validatePortRange(pluginsMarket, 'plugins ports.market')
  if (fromPlugins.min !== marketPorts.min || fromPlugins.max !== marketPorts.max) throw new Error('ports.market differs between provisioner.json and plugins.json')
  const listenerCgroup = options.listenerCgroup === undefined ? DEFAULT_MARKET_LISTENER_CGROUP : parseMarketListenerCgroup(options.listenerCgroup)
  const rules = renderMarketRulesFile({ marketPorts, listenerCgroup })
  const problems = checkMarketRulesFile(rules, marketPorts)
  if (problems.length > 0) throw new Error(`rendered ruleset is invalid: ${problems.join('; ')}`)
  const socket = renderPluginsSocketUnit({ marketPorts, loaderPath: options.loaderPath ?? DEFAULT_MARKET_LOADER_PATH, rulesPath: options.rulesPath ?? DEFAULT_MARKET_RULES_PATH })
  return { rules, socket, marketPorts }
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text, { mode, flag: 'wx' })
  await rename(tmp, path)
}

/** Parse arguments, render, write.
 * @param argv Arguments after the script name.
 * @returns Process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--rules' || arg === '--socket' || arg === '--listener-cgroup') {
      const value = argv[++i]
      if (value === undefined || arg in flags) return usage()
      flags[arg] = value
    } else positional.push(arg)
  }
  const rulesOut = flags['--rules'], socketOut = flags['--socket']
  if (positional.length !== 2 || rulesOut === undefined || socketOut === undefined || !isAbsolute(rulesOut) || !isAbsolute(socketOut)) return usage()
  const [provisionerFile, pluginsFile] = positional as [string, string]
  const files = renderMarketFirewallFiles(JSON.parse(await readFile(provisionerFile, 'utf8')), JSON.parse(await readFile(pluginsFile, 'utf8')), {
    ...flags['--listener-cgroup'] === undefined ? {} : { listenerCgroup: flags['--listener-cgroup'] }, rulesPath: rulesOut })
  await writeAtomic(rulesOut, files.rules, 0o600)
  await writeAtomic(socketOut, files.socket, 0o644)
  process.stdout.write(`rendered ${rulesOut} and ${socketOut} for ports ${files.marketPorts.min}-${files.marketPorts.max}\n`)
  return 0
}

function usage(): number {
  process.stderr.write('usage: render-market-firewall.ts <provisioner.json> <plugins.json> --rules <out.nft> --socket <out.socket> [--listener-cgroup <path>]\n')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code }, (cause: unknown) => {
  process.stderr.write(`render-market-firewall: ${cause instanceof Error ? cause.message : 'failed'}\n`); process.exitCode = 1
})
