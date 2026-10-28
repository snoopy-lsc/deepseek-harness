import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_CHECKS, nativeHostId, parseAnyReleaseManifest, validateNativeEvidence } from '../deploy/native-release.ts'
import { runNativeRehearsal, stampFromInstalledTrees, treeDigest } from '../deploy/native/scripts/rehearse.ts'
import { main as stampManifest, outputRefusal } from '../deploy/native/scripts/stamp-manifest.ts'

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

  it('refuses an unstamped manifest and accepts it once stamped from the installed trees', async () => {
    const f = await fixture(), now = 1_800_000_000_000
    const unstamped = parseAnyReleaseManifest({ ...f.manifest, runtime: { kind: 'systemd', policyDigest: null, toolchainDigest: null } })
    const options = { policyRoots: [f.policy], toolchainRoots: [f.toolchain], machineIdFile: f.machineIdFile, env, checks: passing, clock: () => now }
    await expect(runNativeRehearsal({ ...options, manifest: unstamped })).rejects.toThrow(/not stamped/)
    const stamped = await stampFromInstalledTrees(unstamped, { policyRoots: [f.policy], toolchainRoots: [f.toolchain] })
    expect(stamped.runtime).toEqual(f.manifest.runtime)
    const run = await runNativeRehearsal({ ...options, manifest: stamped })
    expect(validateNativeEvidence(stamped, run.evidence, nativeHostId('0123456789abcdef0123456789abcdef'), { now, maxAgeMs: 86_400_000 }).realHost).toBe(true)
  })

  it('stamp-manifest writes a stamped copy and leaves the source alone', async () => {
    const f = await fixture()
    const source = join(f.base, 'source.json'), out = join(f.base, 'stamped.json')
    const unstamped = { ...f.manifest, schema: 2, runtime: { kind: 'systemd', policyDigest: null, toolchainDigest: null } }
    await writeFile(source, JSON.stringify(unstamped))
    expect(await stampManifest([source, out, '--policy', f.policy])).toBe(2)
    expect(await stampManifest([source, source, '--policy', f.policy, '--toolchain', f.toolchain])).toBe(2)
    expect(await stampManifest([source, out, '--policy', f.policy, '--toolchain', f.toolchain])).toBe(0)
    expect(parseAnyReleaseManifest(JSON.parse(await readFile(out, 'utf8'))).runtime).toEqual(f.manifest.runtime)
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(unstamped)
  })

  it('stamp-manifest refuses an output inside a digested tree or an unsafe output path (review S2)', async () => {
    const f = await fixture()
    const source = join(f.base, 'source.json')
    await writeFile(source, JSON.stringify({ ...f.manifest, schema: 2, runtime: { kind: 'systemd', policyDigest: null, toolchainDigest: null } }))
    const roots = [f.policy, f.toolchain]
    await symlink(f.policy, join(f.base, 'policy-link'))
    await mkdir(join(f.base, 'out-dir'))
    await mkdir(join(f.policy, '..hidden')); await mkdir(join(f.toolchain, '..hidden'))
    await mkdir(join(f.base, '..outside')); await mkdir(`${f.policy}-sibling`)
    const before = [await treeDigest([f.policy]), await treeDigest([f.toolchain])]
    for (const [out, reason] of [
      [join(f.policy, '..hidden', 'stamped.json'), /inside the digested tree/],
      [join(f.toolchain, '..hidden', 'stamped.json'), /inside the digested tree/],
      [join(f.policy, '..stamped.json'), /inside the digested tree/],
      [join(f.policy, 'stamped.json'), /inside the digested tree/],
      [join(f.toolchain, 'nested', '..', 'stamped.json'), /inside the digested tree/],
      [join(f.base, 'policy-link', 'stamped.json'), /inside the digested tree/],
      [f.policy, /inside the digested tree|not a regular file/],
      ['stamped.json', /absolute/],
      [`${f.base}/`, /absolute file path/],
      [join(f.base, 'missing', 'stamped.json'), /does not exist/],
      [join(f.base, 'out-dir'), /not a regular file/],
      [join(f.base, 'policy-link', '..', 'source.json'), /source/],
    ] as const) expect(await outputRefusal(source, out, roots), out).toMatch(reason)
    expect(await outputRefusal(source, join(f.base, 'stamped.json'), ['relative/policy'])).toMatch(/roots must be absolute/)
    expect(await outputRefusal(source, join(f.base, 'stamped.json'), roots)).toBeUndefined()
    // Genuinely outside, even with a `..`-prefixed name or a root-prefixed sibling directory.
    expect(await outputRefusal(source, join(f.base, '..outside', 'stamped.json'), roots)).toBeUndefined()
    expect(await outputRefusal(source, join(`${f.policy}-sibling`, 'stamped.json'), roots)).toBeUndefined()
    const error = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      expect(await stampManifest([source, join(f.policy, 'stamped.json'), '--policy', f.policy, '--toolchain', f.toolchain])).toBe(2)
      expect(await stampManifest([source, join(f.toolchain, 'stamped.json'), '--policy', f.policy, '--toolchain', f.toolchain])).toBe(2)
    } finally { process.stderr.write = error }
    expect([await treeDigest([f.policy]), await treeDigest([f.toolchain])]).toEqual(before)
  })

  it('stale_or_wrong_policy_stays_closed: an installed policy change stops the rehearsal', async () => {
    const f = await fixture()
    await writeFile(join(f.policy, 'unit.service'), '[Service]\nNoNewPrivileges=no\n')
    await expect(runNativeRehearsal({ manifest: f.manifest, policyRoots: [f.policy], toolchainRoots: [f.toolchain], machineIdFile: f.machineIdFile, env, checks: passing }))
      .rejects.toThrow(/policy does not match/)
  })
})
