/** Operator CLI for the provisioner's root-only administrative socket and the release gate. Prints only counts and fixed words. */
import { readFile } from 'node:fs/promises'
import { parseUserId } from '../packages/contracts/src/index.ts'
import { AdminClient } from '../packages/provisioner/src/admin.ts'
import { checkPublicEnrollment, collectConfigFacts } from './release-check.ts'
import { parseAnyReleaseManifest, requireRuntime } from './native-release.ts'

const ADMIN_SOCKET = process.env.DSH_ADMIN_SOCKET ?? '/run/dsh-public/admin/admin.sock'
const USER_COMMANDS = ['suspend', 'reactivate', 'request-deletion', 'confirm-deletion', 'delete'] as const

async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }

/** Run one command; returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const client = new AdminClient(ADMIN_SOCKET)
  if ((USER_COMMANDS as readonly (string | undefined)[]).includes(command) && rest.length === 1) {
    await client.userOperation(command as typeof USER_COMMANDS[number], parseUserId(rest[0]!))
    process.stdout.write('ok\n'); return 0
  }
  if (command === 'reconcile' && rest.length === 0) { process.stdout.write(`${JSON.stringify(await client.reconcile())}\n`); return 0 }
  if (command === 'idle-stop' && rest.length === 0) { process.stdout.write(`stopped ${String(await client.requestRaw({ op: 'idle-stop' }))}\n`); return 0 }
  if (command === 'status' && rest.length === 0) { process.stdout.write(`${String(await client.requestRaw({ op: 'status' }))}\n`); return 0 }
  if (command === 'release-check' && rest.length === 2) {
    // dshctl release-check <evidence.json> <config-dir>; reads configuration files only, never secrets.
    const [evidencePath, configDir] = rest as [string, string]
    // This check covers the frozen container runtime, so it reads the container manifest; the native one is admitted by validateNativeEvidence.
    const manifest = requireRuntime(parseAnyReleaseManifest(await json(new URL('./production/release-manifest.json', import.meta.url).pathname)), 'podman-gvisor')
    const config = collectConfigFacts({ caddyfile: await readFile(`${configDir}/Caddyfile`, 'utf8'), router: await json(`${configDir}/router.json`),
      provisioner: await json(`${configDir}/provisioner.json`), quota: await json(`${configDir}/quota.json`),
      blueprint: await readFile(`${configDir}/public-harness.yaml`, 'utf8'), manifestEnrollment: manifest.publicEnrollment })
    const decision = await checkPublicEnrollment(await json(evidencePath), { expectedHost: process.env.DSH_EXPECTED_HOST ?? '', release: manifest.release,
      now: new Date(), maxAgeMs: 7 * 86_400_000, config })
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
    return decision.decision === 'allow' ? 0 : 1
  }
  process.stderr.write('usage: dshctl status | reconcile | idle-stop | <suspend|reactivate|request-deletion|confirm-deletion|delete> <user> | release-check <evidence.json> <config-dir>\n')
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code }, () => { process.stderr.write('dshctl: failed\n'); process.exitCode = 1 })
