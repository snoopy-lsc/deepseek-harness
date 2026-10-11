/** Generate a dedicated dsh profile for the local-only development server. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import { validateTeamDevConfig, type TeamDevConfig } from '../packages/team-dev/src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const integrationRoot = fileURLToPath(new URL('../', import.meta.url))

/** User-adjustable local user list and startup limits. */
export type TeamDevSettings = Pick<TeamDevConfig, 'users' | 'maxActiveInstances' | 'idleStopMs' | 'startupTimeoutMs' | 'stopTimeoutMs' |
  'routeWaitMs' | 'retryAfterSeconds' | 'launchExchangeMs' | 'socketLifetimeMs' | 'cookieLifetimeMs' | 'quota' | 'storageLock'>

/** Write a profile file once; an existing file must be semantically identical. */
export async function ownedFile(path: string, contents: string): Promise<void> {
  let existing: string | undefined
  try { existing = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing !== undefined && !isDeepStrictEqual(parse(existing), parse(contents))) {
    throw new Error(`team-dev profile file differs: ${path}`)
  }
  if (existing === undefined) await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
}

/** Create or verify the team's private profile files without overwriting edits. */
export async function writeTeamDevProfile(home: string, settings: TeamDevSettings): Promise<{ home: string; cli: string }> {
  const absoluteHome = resolve(home)
  const profile = join(absoluteHome, 'profiles', 'team-dev')
  const webPatch = join(profile, 'web.patch.yml')
  const cli = join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js')
  const config: TeamDevConfig = { ...settings, host: '127.0.0.1',
    storageRoot: join(absoluteHome, 'users'), webPatch,
    command: process.execPath, args: [cli] }
  validateTeamDevConfig(config)
  for (const path of [absoluteHome, join(absoluteHome, 'profiles'), profile, config.storageRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  const webToken = pathToFileURL(join(integrationRoot, 'packages', 'web-token', 'lib', 'index.js')).href
  const teamDev = pathToFileURL(join(integrationRoot, 'packages', 'team-dev', 'lib', 'index.js')).href
  await ownedFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-team-dev', private: true, type: 'module', dsh: { profile: { bundles: [] } },
  })}\n`)
  await ownedFile(join(profile, 'cordis.yml'), '[]\n')
  await ownedFile(webPatch, `${JSON.stringify([
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false,
      publicUrl: null, surfaceContext: true, trustedHosts: [] } },
    { insert: [{ id: 'public-harness-web-token', name: webToken }] },
  ])}\n`)
  await ownedFile(join(profile, 'cordis.patch.yml'), `${JSON.stringify([
    { insert: [{ id: 'public-harness-team-dev', name: teamDev, config }] },
  ])}\n`)
  return { home: absoluteHome, cli }
}
