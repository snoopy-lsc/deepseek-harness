/** Generate the production dsh profiles (team-router, provisioner, quota, and identity and kb for native deployments); each points at one root-owned JSON file.
 * Native systemd is the mainline runtime; the Podman + gVisor container runtime is frozen (maintained, no new features). */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownedFile } from './profile.ts'

const integrationRoot = fileURLToPath(new URL('../', import.meta.url))

export const PRODUCTION_PROFILES = {
  'team-router': { plugin: 'team-router', id: 'public-harness-team-router' },
  provisioner: { plugin: 'provisioner-service', id: 'public-harness-provisioner' },
  quota: { plugin: 'quota-service', id: 'public-harness-quota-service' },
  identity: { plugin: 'identity-service', id: 'public-harness-identity' },
  kb: { plugin: 'kb-service', id: 'public-harness-kb-service' },
} as const

export type ProductionProfile = keyof typeof PRODUCTION_PROFILES

/** Runtime provider plugins; the provisioner profile loads exactly the one its deployment selects. */
export const RUNTIME_PROVIDERS = {
  'podman-gvisor': { plugin: 'container-runtime', id: 'public-harness-container-runtime' },
  systemd: { plugin: 'systemd-runtime', id: 'public-harness-systemd-runtime' },
} as const

/** One selectable runtime provider. */
export type RuntimeProvider = keyof typeof RUNTIME_PROVIDERS

/** The mainline runtime: native systemd. A profile that names no runtime loads this one. */
export const DEFAULT_RUNTIME: RuntimeProvider = 'systemd'

/** Runtimes that stay selectable and tested but receive no new features (container: Podman + gVisor). */
export const FROZEN_RUNTIMES: readonly RuntimeProvider[] = ['podman-gvisor']

/** Create or verify one production profile under `home/profiles/<name>`.
 * @param home dsh home directory.
 * @param name Profile name.
 * @param options Root-owned configuration file, optional install root, and the runtime the provisioner profile loads
 *   (default `DEFAULT_RUNTIME`, native systemd; pass `podman-gvisor` for the frozen container deployment).
 * @returns Profile directory.
 */
export async function writeProductionProfile(home: string, name: ProductionProfile,
  options: { configFile: string; installRoot?: string; runtime?: RuntimeProvider }): Promise<string> {
  const selected = options.runtime ?? DEFAULT_RUNTIME
  if (!Object.hasOwn(RUNTIME_PROVIDERS, selected)) throw new Error('unknown runtime provider')
  if ((name === 'identity' || name === 'kb') && selected !== 'systemd') throw new Error(`the ${name} profile belongs to native deployments`)
  if (!isAbsolute(options.configFile) || options.configFile.includes('\0')) throw new Error('configFile must be an absolute path')
  if (!(name in PRODUCTION_PROFILES)) throw new Error('unknown production profile')
  const { plugin, id } = PRODUCTION_PROFILES[name]
  const profile = join(resolve(home), 'profiles', name)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const url = pathToFileURL(join(options.installRoot ?? integrationRoot, 'packages', 'production', 'lib', `${plugin}.js`)).href
  await ownedFile(join(profile, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, type: 'module', dsh: { profile: { bundles: [] } } })}\n`)
  await ownedFile(join(profile, 'cordis.yml'), '[]\n')
  const runtime = RUNTIME_PROVIDERS[selected]
  const provider = { id: runtime.id, name: pathToFileURL(join(options.installRoot ?? integrationRoot,
    'packages', 'production', 'lib', `${runtime.plugin}.js`)).href, config: { configFile: options.configFile } }
  const consumer = { id, name: url, config: { configFile: options.configFile } }
  await ownedFile(join(profile, 'cordis.patch.yml'), `${JSON.stringify([{ insert: name === 'provisioner' ? [provider, consumer] : [consumer] }])}\n`)
  return profile
}
