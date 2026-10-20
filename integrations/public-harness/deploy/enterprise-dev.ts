/** Prepare the local enterprise profile; only dsh launches the application. */
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { ownedFile } from './profile.ts'

const integrationRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const home = resolve(process.env.PUBLIC_HARNESS_ENTERPRISE_HOME ?? join(integrationRoot, '.enterprise-local'))
const profile = join(home, 'profiles', 'enterprise-dev')
const stateRoot = join(home, 'state')
const configFile = join(profile, 'settings.json')
const webPatch = join(profile, 'web.patch.json')
for (const path of [profile, stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
const settings: Record<string, unknown> = JSON.parse(await readFile(join(integrationRoot, 'deploy', 'enterprise-dev.config.json'), 'utf8'))
const team: Record<string, unknown> = JSON.parse(await readFile(join(integrationRoot, 'deploy', 'team-dev.config.json'), 'utf8'))
const cli = join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js')
await ownedFile(configFile, `${JSON.stringify({ ...settings, stateRoot, team: { ...team,
  storageRoot: join(stateRoot, 'runtime'), host: '127.0.0.1', webPatch, command: process.execPath, args: [cli],
} }, null, 2)}\n`)
const picker: unknown = parse(await readFile(join(repositoryRoot, 'apps/web/tests/pin-browse-picker.overlay.yml'), 'utf8'))
if (!Array.isArray(picker)) throw new Error('the local browser directory picker overlay must be a list')
await ownedFile(webPatch, `${JSON.stringify([
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, publicUrl: null, surfaceContext: true, trustedHosts: [] } },
  ...picker,
  { insert: [{ id: 'public-harness-web-token', name: pathToFileURL(join(integrationRoot, 'packages', 'web-token', 'lib', 'index.js')).href }] },
])}\n`)
await ownedFile(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-enterprise-dev', private: true, type: 'module', dsh: { profile: { bundles: [] } } })}\n`)
await ownedFile(join(profile, 'cordis.yml'), '[]\n')
await ownedFile(join(profile, 'cordis.patch.yml'), `${JSON.stringify([{ insert: [{ id: 'enterprise-dev',
  name: pathToFileURL(join(integrationRoot, 'packages', 'team-dev', 'lib', 'enterprise.js')).href, config: { configFile },
}] }])}\n`)
const child = spawn(process.execPath, [cli, '--profile', 'enterprise-dev'], {
  cwd: repositoryRoot, env: { ...process.env, DSH_HOME: home }, stdio: 'inherit',
})
const interrupt = () => child.kill('SIGINT')
const terminate = () => child.kill('SIGTERM')
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
} finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
