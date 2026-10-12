import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_CHECKS, nativeHostId, parseAnyReleaseManifest, validateNativeEvidence } from '../deploy/native-release.ts'
import { runNativeRehearsal, treeDigest } from '../deploy/native/scripts/rehearse.ts'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-rehearsal-'))
  const policy = join(base, 'policy'), toolchain = join(base, 'toolchain')
  await mkdir(policy); await mkdir(toolchain)
  await writeFile(join(policy, 'unit.service'), '[Service]\n'); await writeFile(join(toolchain, 'node'), 'binary')
  await writeFile(join(base, 'machine-id'), '0123456789abcdef0123456789abcdef\n')
  const manifest = parseAnyReleaseManifest({ schema: 2, release: 'r1', harness: { package: '@deepseek-ai/dsh', version: '0.2.1' },
    runtime: { kind: 'systemd', policyDigest: await treeDigest([policy]), toolchainDigest: await treeDigest([toolchain]) },
    pluginApi: { '@deepseek-ai/cordis': '4.0.5' }, bundles: { '@public-harness/contracts': '0.1.0' }, previous: null, publicEnrollment: 'closed' })
  return { base, policy, toolchain, manifest, machineIdFile: join(base, 'machine-id') }
}
const passing = Object.fromEntries(NATIVE_CHECKS.map(name => [name, async () => ({ result: 'passed' as const, observed: 'denied as expected' })]))
const env = { DSH_NATIVE_REHEARSAL: 'dedicated-host' }

describe('native rehearsal tooling', () => {
  it('refuses to run without the dedicated-host opt-in', async () => {
    const f = await fixture()
    await expect(runNativeRehearsal({ manifest: f.manifest, policyRoots: [f.policy], toolchainRoots: [f.toolchain], checks: passing, env: {} })).rejects.toThrow(/dedicated-host/)
  })

  it('writes evidence the validator accepts only when every check really ran and passed', async () => {
    const f = await fixture(), now = 1_800_000_000_000
    const options = { manifest: f.manifest, policyRoots: [f.policy], toolchainRoots: [f.toolchain], machineIdFile: f.machineIdFile, env, clock: () => now }
    const host = nativeHostId('0123456789abcdef0123456789abcdef')
    const full = await runNativeRehearsal({ ...options, checks: passing })
    expect(validateNativeEvidence(f.manifest, full.evidence, host, { now, maxAgeMs: 86_400_000 }).realHost).toBe(true)
    // A skipped check marks the whole run simulated; a failing one is recorded as failed.
    const { network: _network, ...partial } = passing
    const skipped = await runNativeRehearsal({ ...options, checks: partial })
    expect(skipped.evidence.realHost).toBe(false)
    expect(() => validateNativeEvidence(f.manifest, skipped.evidence, host, { now, maxAgeMs: 86_400_000 })).toThrow(/simulated|network/)
    const failing = await runNativeRehearsal({ ...options, checks: { ...passing, files: async () => { throw new Error('foreign home readable') } } })
    expect(failing.observations.files).toContain('foreign home readable')
    expect(() => validateNativeEvidence(f.manifest, failing.evidence, host, { now, maxAgeMs: 86_400_000 })).toThrow(/files failed/)
  })

  it('stale_or_wrong_policy_stays_closed: an installed policy change stops the rehearsal', async () => {
    const f = await fixture()
    await writeFile(join(f.policy, 'unit.service'), '[Service]\nNoNewPrivileges=no\n')
    await expect(runNativeRehearsal({ manifest: f.manifest, policyRoots: [f.policy], toolchainRoots: [f.toolchain], machineIdFile: f.machineIdFile, env, checks: passing }))
      .rejects.toThrow(/policy does not match/)
  })
})
