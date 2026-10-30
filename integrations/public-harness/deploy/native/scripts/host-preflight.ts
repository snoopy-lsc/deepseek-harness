/** Read-only native host preflight: reports whether this host can run the systemd provider. Changes nothing.
 * Usage: tsx deploy/native/scripts/host-preflight.ts <provisioner.json> <native.json>
 * Prints one JSON object of named results and exits 1 when any check fails. */
import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { parseSystemdConfig } from '../../../packages/runtime-systemd/src/config.ts'
import { validateHostResolvConf, validateNativeAssets } from '../../../packages/runtime-systemd/src/storage.ts'
import { DEFAULT_MARKET_RULES_PATH, checkMarketRulesFile, formatMarketPorts } from '../../../packages/runtime-systemd/src/market-firewall.ts'
import { DEFAULT_MARKET_LOADER_PATH } from '../../../packages/runtime-systemd/src/plugins-units.ts'

/** One named preflight result. */
export interface PreflightResult { readonly check: string; readonly ok: boolean; readonly detail: string }
/** Injected host reads so the checks are testable without a dedicated host. */
export interface PreflightHost {
  read(path: string): Promise<string>
  run(command: string, args: readonly string[]): string
  /** Owner, mode and type of a path without following a final symlink; defaults to `lstat`. */
  stat?(path: string): Promise<{ readonly uid: number; readonly mode: number; readonly file: boolean }>
}
const lstatHost = async (path: string) => { const info = await lstat(path); return { uid: info.uid, mode: info.mode & 0o7777, file: info.isFile() } }
const defaultHost: PreflightHost = {
  stat: lstatHost,
  read: path => readFile(path, 'utf8'),
  run: (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }),
}

/** Installed market firewall paths checked when `ports.market` is enabled. */
export const MARKET_FIREWALL_PATHS = { loader: DEFAULT_MARKET_LOADER_PATH, rules: DEFAULT_MARKET_RULES_PATH, socket: '/etc/systemd/system/dsh-plugins.socket' } as const

/** Oldest Node.js the services and the instance toolchain may run; equals the workspace `engines.node` floor. */
export const MIN_NODE_VERSION = '24.9.0'
/** Node used by the service units' `ExecStart=`. */
const SERVICE_NODE = '/usr/bin/node'

function nodeVersion(output: string): readonly [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(output.trim())
  if (match === null) throw new Error('unrecognized node --version output')
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (version[i] !== floor[i]) return (version[i] as number) > (floor[i] as number)
  return true
}

/** Throws unless `unit` runs the loader as a fatal ExecStartPost and listens on exactly ports.market, loopback only.
 * Applied to the unit file and to systemd's merged view (unit plus drop-ins), whose lines this reads the same way. */
function checkMarketSocketUnit(unit: string, market: { readonly min: number; readonly max: number }, where: string): void {
  const lines = unit.split('\n')
  // systemd joins a line ending in an odd number of backslashes with the next non-comment line, so
  // `ExecStartPost=\` before a blank line, a comment or EOF is an empty value: a reset that removes the loader. No
  // line of these units needs a continuation, so any is refused (comments included, to stay clear of parser versions).
  for (const line of lines) {
    if ((/\\+$/.exec(line.replace(/[ \t\r]+$/, ''))?.[0].length ?? 0) % 2 === 1) {
      throw new Error(`${where}: "${line.trim()}" ends in a line continuation; write each setting on one line`)
    }
  }
  const posts = lines.filter(line => /^\s*ExecStartPost\s*=/.test(line))
  // An empty `ExecStartPost=` in a drop-in resets the list and removes the loader, so any reset is refused.
  if (!posts.includes(`ExecStartPost=${MARKET_FIREWALL_PATHS.loader} ${MARKET_FIREWALL_PATHS.rules}`)
    || posts.some(line => !/^ExecStartPost=[^-\s]/.test(line))) {
    throw new Error(`${where} must run the loader as a fatal ExecStartPost (no "-" prefix, no reset)`)
  }
  // The rules match only `iif "lo"`, so every listener must be loopback-only and the ports exactly ports.market.
  const ports = new Set<number>()
  for (const line of lines.filter(line => /^\s*Listen[A-Za-z]*\s*=/.test(line))) {
    const match = /^ListenStream=127\.0\.0\.1:(\d{1,5})$/.exec(line)
    const port = match === null ? NaN : Number(match[1])
    if (!(port >= market.min && port <= market.max) || ports.has(port)) {
      throw new Error(`${where}: "${line.trim()}" is not one ListenStream=127.0.0.1:<port> within ports.market`)
    }
    ports.add(port)
  }
  if (ports.size !== market.max - market.min + 1) throw new Error(`${where} must listen on every port of ports.market (${ports.size} of ${market.max - market.min + 1})`)
}

/** Parse `systemctl show -p LoadState -p NeedDaemonReload -p ExecStartPost -p Listen` for the market socket: systemd's
 * own view of the loaded unit (fragment plus drop-ins, continuations and resets already applied). Throws unless the
 * unit is loaded and current, runs the loader without ignore_errors, and listens on exactly ports.market, loopback
 * TCP only. */
export function checkMarketSocketShow(show: string, market: { readonly min: number; readonly max: number }, unitName: string): void {
  const lines = show.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line !== '')
  const value = (key: string) => lines.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1))
  if (value('LoadState').join() !== 'loaded') throw new Error(`systemd has not loaded ${unitName} (LoadState=${value('LoadState').join() || 'unknown'}); run systemctl daemon-reload`)
  if (value('NeedDaemonReload').join() !== 'no') throw new Error(`${unitName} changed on disk since systemd loaded it; run systemctl daemon-reload`)
  const loaderArgv = `${MARKET_FIREWALL_PATHS.loader} ${MARKET_FIREWALL_PATHS.rules}`
  const hooks = value('ExecStartPost').filter(entry => entry !== '').map(entry => {
    const fields = /^\{ path=(\S+) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ; /.exec(entry)
    if (fields === null) throw new Error(`${unitName}: unrecognised ExecStartPost entry from systemctl show`)
    return { path: fields[1], argv: fields[2], ignore: fields[3] === 'yes' }
  })
  if (!hooks.some(hook => hook.path === MARKET_FIREWALL_PATHS.loader && hook.argv === loaderArgv && !hook.ignore)) {
    throw new Error(`systemd does not run ${loaderArgv} as a fatal ExecStartPost of ${unitName}`)
  }
  const ports = new Set<number>()
  for (const listen of value('Listen')) {
    const match = /^127\.0\.0\.1:(\d{1,5}) \(Stream\)$/.exec(listen)
    const port = match === null ? NaN : Number(match[1])
    if (!(port >= market.min && port <= market.max) || ports.has(port)) throw new Error(`${unitName}: systemd listens on "${listen}", not one 127.0.0.1:<port> (Stream) within ports.market`)
    ports.add(port)
  }
  if (ports.size !== market.max - market.min + 1) throw new Error(`systemd listens on ${ports.size} of the ${market.max - market.min + 1} ports of ports.market for ${unitName}`)
}

/** Run every check; none mutates the host.
 * @param common Common provisioner settings (the `provisioner` record).
 * @param nativeOptions Native companion settings.
 * @param host Host reads.
 * @returns Results in a fixed order.
 */
export async function preflight(common: unknown, nativeOptions: unknown, host: PreflightHost = defaultHost): Promise<PreflightResult[]> {
  const results: PreflightResult[] = []
  const check = async (name: string, body: () => Promise<string>) => {
    try { results.push({ check: name, ok: true, detail: await body() }) } catch (error) { results.push({ check: name, ok: false, detail: error instanceof Error ? error.message : String(error) }) }
  }
  const config = parseSystemdConfig({ common, native: nativeOptions })
  await check('os', async () => {
    const release = await host.read('/etc/os-release')
    if (!/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="24\.04"$/m.test(release)) throw new Error('Ubuntu 24.04 is the only supported host')
    return 'ubuntu 24.04'
  })
  await check('cgroup2', async () => {
    const controllers = (await host.read('/sys/fs/cgroup/cgroup.subtree_control')).trim().split(/\s+/)
    for (const name of ['cpu', 'memory', 'pids']) if (!controllers.includes(name)) throw new Error(`${name} controller is not enabled`)
    return controllers.join(' ')
  })
  await check('apparmor', async () => {
    if ((await host.read('/sys/module/apparmor/parameters/enabled')).trim() !== 'Y') throw new Error('AppArmor is disabled')
    if ((await host.read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')).trim() !== '1') throw new Error('kernel.apparmor_restrict_unprivileged_userns must be 1')
    return 'enabled; unprivileged user namespaces restricted'
  })
  await check('xfs-quota', async () => {
    const state = host.run(config.tools.xfsQuota, ['-x', '-c', 'state -u', config.paths.quotaMount])
    if (!/Enforcement:\s*ON/.test(state)) throw new Error('XFS user quota enforcement is off on the quota mount')
    return 'user quota enforced'
  })
  await check('node-version', async () => {
    const floor = nodeVersion(`v${MIN_NODE_VERSION}`)
    const found = [config.tools.node, SERVICE_NODE].map(binary => {
      const version = nodeVersion(host.run(binary, ['--version']))
      if (!atLeast(version, floor)) throw new Error(`${binary} is v${version.join('.')}; Node ${MIN_NODE_VERSION} or later is required`)
      return `${binary} v${version.join('.')}`
    })
    return found.join(', ')
  })
  await check('nftables', async () => { host.run(config.tools.nft, ['--version']); return 'available' })
  // With ports.market enabled the per-owner table is mandatory: without it dsh_native's per-uid accept lets every
  // account reach every market port. Checks the installed loader, rules file and the fatal socket wiring.
  if (config.ports.market !== undefined) {
    const market = config.ports.market
    await check('market-firewall', async () => {
      const stat = host.stat ?? lstatHost
      const loader = await stat(MARKET_FIREWALL_PATHS.loader)
      if (!loader.file || loader.uid !== 0 || (loader.mode & 0o022) !== 0 || (loader.mode & 0o100) === 0) throw new Error(`${MARKET_FIREWALL_PATHS.loader} must be a root-owned executable not writable by group or others`)
      const rules = await stat(MARKET_FIREWALL_PATHS.rules)
      if (!rules.file || rules.uid !== 0 || (rules.mode & 0o022) !== 0) throw new Error(`${MARKET_FIREWALL_PATHS.rules} must be a root-owned regular file not writable by group or others`)
      const problems = checkMarketRulesFile(await host.read(MARKET_FIREWALL_PATHS.rules), market)
      if (problems.length > 0) throw new Error(`${MARKET_FIREWALL_PATHS.rules}: ${problems.join('; ')}`)
      // The installed unit file, then systemd's merged view: `systemctl cat` prints the fragment systemd actually uses
      // followed by every drop-in, so an override (`*.socket.d/*.conf`, or a fragment in /run) cannot add a
      // non-loopback listener, reset the listeners or drop the fatal loader hook unseen.
      checkMarketSocketUnit(await host.read(MARKET_FIREWALL_PATHS.socket), market, MARKET_FIREWALL_PATHS.socket)
      const unitName = MARKET_FIREWALL_PATHS.socket.slice(MARKET_FIREWALL_PATHS.socket.lastIndexOf('/') + 1)
      let merged: string
      try { merged = host.run(config.tools.systemctl, ['cat', '--no-pager', unitName]) } catch (error) {
        throw new Error(`systemctl cat ${unitName} failed (${error instanceof Error ? error.message.split('\n')[0] : 'error'}); the merged unit cannot be verified`)
      }
      const fragment = merged.split('\n').find(line => line.startsWith('# /'))
      if (fragment !== `# ${MARKET_FIREWALL_PATHS.socket}`) throw new Error(`systemd loads ${unitName} from ${fragment?.slice(2) ?? 'nowhere'}, not ${MARKET_FIREWALL_PATHS.socket}`)
      checkMarketSocketUnit(merged, market, `${unitName} (merged with drop-ins)`)
      // systemd's parsed result of the loaded unit is authoritative over any reading of the text.
      let show: string
      try {
        show = host.run(config.tools.systemctl, ['show', '--no-pager', '-p', 'LoadState', '-p', 'NeedDaemonReload', '-p', 'ExecStartPost', '-p', 'Listen', unitName])
      } catch (error) {
        throw new Error(`systemctl show ${unitName} failed (${error instanceof Error ? error.message.split('\n')[0] : 'error'}); the loaded unit cannot be verified`)
      }
      checkMarketSocketShow(show, market, unitName)
      let live: string
      try { live = host.run(config.tools.nft, ['list', 'table', 'inet', 'dsh_market']) } catch { live = '' }
      return `ports ${formatMarketPorts(market)}; loader and rules installed; ${live.includes('@market_owner drop') ? 'table loaded' : 'table not loaded yet (dsh-plugins.socket loads it)'}`
    })
  }
  await check('resolv-conf', async () => { await validateHostResolvConf(); return 'regular root-owned file' })
  await check('assets', async () => { await validateNativeAssets(config); return 'release, toolchain and browser trees are root-owned and immutable' })
  await check('browser-pin', async () => {
    const info = await lstat(config.paths.browser)
    if (!info.isFile()) throw new Error('browser executable missing')
    return host.run(config.paths.browser, ['--version']).trim()
  })
  return results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [provisionerFile, nativeFile] = process.argv.slice(2)
  if (provisionerFile === undefined || nativeFile === undefined) { console.error('usage: host-preflight.ts <provisioner.json> <native.json>'); process.exit(2) }
  const profile = JSON.parse(await readFile(provisionerFile, 'utf8')) as { provisioner: unknown }
  const results = await preflight(profile.provisioner, JSON.parse(await readFile(nativeFile, 'utf8')))
  console.log(JSON.stringify(results, null, 2))
  process.exit(results.every(result => result.ok) ? 0 : 1)
}
