/** Generate the three production dsh profiles (team-router, provisioner, quota); each points at one root-owned JSON file. */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownedFile } from './profile.ts'

const integrationRoot = fileURLToPath(new URL('../', import.meta.url))

export const PRODUCTION_PROFILES = {
  'team-router': { plugin: 'team-router', id: 'public-harness-team-router' },
  provisioner: { plugin: 'provisioner-service', id: 'public-harness-provisioner' },
  quota: { plugin: 'quota-service', id: 'public-harness-quota-service' },
} as const

export type ProductionProfile = keyof typeof PRODUCTION_PROFILES

/** Create or verify one production profile under `home/profiles/<name>`. */
export async function writeProductionProfile(home: string, name: ProductionProfile, options: { configFile: string; installRoot?: string }): Promise<string> {
  if (!isAbsolute(options.configFile) || options.configFile.includes('\0')) throw new Error('configFile must be an absolute path')
  if (!(name in PRODUCTION_PROFILES)) throw new Error('unknown production profile')
  const { plugin, id } = PRODUCTION_PROFILES[name]
  const profile = join(resolve(home), 'profiles', name)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const url = pathToFileURL(join(options.installRoot ?? integrationRoot, 'packages', 'production', 'lib', `${plugin}.js`)).href
  await ownedFile(join(profile, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, type: 'module', dsh: { profile: { bundles: [] } } })}\n`)
  await ownedFile(join(profile, 'cordis.yml'), '[]\n')
  const provider = { id: 'public-harness-container-runtime', name: pathToFileURL(join(options.installRoot ?? integrationRoot,
    'packages', 'production', 'lib', 'container-runtime.js')).href, config: { configFile: options.configFile } }
  const consumer = { id, name: url, config: { configFile: options.configFile } }
  await ownedFile(join(profile, 'cordis.patch.yml'), `${JSON.stringify([{ insert: name === 'provisioner' ? [provider, consumer] : [consumer] }])}\n`)
  return profile
}
