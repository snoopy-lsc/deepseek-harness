/** Setup wrapper: only the dsh team-dev profile launches the Node application. */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeTeamDevProfile, type TeamDevSettings } from './profile.ts'

const integrationRoot = fileURLToPath(new URL('../', import.meta.url))
const home = resolve(process.env.PUBLIC_HARNESS_DEV_HOME ?? join(integrationRoot, '.local'))
const settings = JSON.parse(await readFile(join(integrationRoot, 'deploy', 'team-dev.config.json'), 'utf8')) as TeamDevSettings
const profile = await writeTeamDevProfile(home, settings)
const child = spawn(process.execPath, [profile.cli, '--profile', 'team-dev'], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  env: { ...process.env, DSH_HOME: profile.home }, stdio: 'inherit',
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolve(code ?? 1))
})
