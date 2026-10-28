/** Read-only native host preflight: reports whether this host can run the systemd provider. Changes nothing.
 * Usage: tsx deploy/native/scripts/host-preflight.ts <provisioner.json> <native.json>
 * Prints one JSON object of named results and exits 1 when any check fails. */
import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { parseSystemdConfig } from '../../../packages/runtime-systemd/src/config.ts'
import { validateHostResolvConf, validateNativeAssets } from '../../../packages/runtime-systemd/src/storage.ts'

/** One named preflight result. */
export interface PreflightResult { readonly check: string; readonly ok: boolean; readonly detail: string }
/** Injected host reads so the checks are testable without a dedicated host. */
export interface PreflightHost {
  read(path: string): Promise<string>
  run(command: string, args: readonly string[]): string
}
const defaultHost: PreflightHost = {
  read: path => readFile(path, 'utf8'),
  run: (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }),
}

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
