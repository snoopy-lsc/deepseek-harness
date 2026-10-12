import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_CHECKS, nativeHostId, parseAnyReleaseManifest, validateNativeEvidence } from '../deploy/native-release.ts'
import { createNativeBackup, inspectNativeBackup, restoreNativeBackup } from '../deploy/native/scripts/backup.ts'

const root = new URL('../', import.meta.url).pathname
const digest = (c: string) => `sha256:${c.repeat(64)}`
const host = nativeHostId('0123456789abcdef0123456789abcdef')
const NOW = 1_800_000_000_000
async function nativeManifest() {
  const legacy = JSON.parse(await readFile(join(root, 'deploy/release-manifest.json'), 'utf8')) as Record<string, unknown>
  const { image: _image, ...rest } = legacy
  return parseAnyReleaseManifest({ ...rest, schema: 2, runtime: { kind: 'systemd', policyDigest: digest('a'), toolchainDigest: digest('b') } })
}
function evidence(overrides: Record<string, unknown> = {}) {
  return { schema: 1, backend: 'systemd', hostId: host, release: '2026.10.0-rc2', policyDigest: digest('a'), toolchainDigest: digest('b'),
    architecture: 'x86_64', kernel: '6.8.0-45-generic', checks: Object.fromEntries(NATIVE_CHECKS.map(name => [name, 'passed'])), verifiedAt: NOW - 1000, realHost: true, ...overrides }
}
const ctx = { now: NOW, maxAgeMs: 7 * 86_400_000 }

describe('native release admission', () => {
  it('accepts complete real evidence bound to this host, release, policy and toolchain', async () => {
    expect(validateNativeEvidence(await nativeManifest(), evidence(), host, ctx).realHost).toBe(true)
  })

  it('container_evidence_cannot_open_native_enrollment', async () => {
    const legacy = parseAnyReleaseManifest(JSON.parse(await readFile(join(root, 'deploy/release-manifest.json'), 'utf8')))
    expect(() => validateNativeEvidence(legacy, evidence(), host, ctx)).toThrow(/container release/)
    const manifest = await nativeManifest()
    expect(() => validateNativeEvidence(manifest, evidence({ backend: 'podman-gvisor' }), host, ctx)).toThrow(/systemd backend/)
  })

  it('stale_or_wrong_policy_stays_closed', async () => {
    const manifest = await nativeManifest()
    expect(() => validateNativeEvidence(manifest, evidence({ policyDigest: digest('c') }), host, ctx)).toThrow(/policy changed/)
    expect(() => validateNativeEvidence(manifest, evidence({ toolchainDigest: digest('c') }), host, ctx)).toThrow(/toolchain changed/)
    expect(() => validateNativeEvidence(manifest, evidence({ verifiedAt: NOW - 8 * 86_400_000 }), host, ctx)).toThrow(/stale/)
    expect(() => validateNativeEvidence(manifest, evidence({ hostId: nativeHostId('f'.repeat(32)) }), host, ctx)).toThrow(/another host/)
    expect(() => validateNativeEvidence(manifest, evidence({ release: 'other' }), host, ctx)).toThrow(/another release/)
  })

  it('missing_check_stays_closed', async () => {
    const manifest = await nativeManifest()
    const { network: _network, ...partial } = evidence().checks as Record<string, string>
    expect(() => validateNativeEvidence(manifest, evidence({ checks: partial }), host, ctx)).toThrow(/network is missing/)
    expect(() => validateNativeEvidence(manifest, evidence({ checks: { ...evidence().checks, files: 'failed' } }), host, ctx)).toThrow(/files failed/)
    expect(() => validateNativeEvidence(manifest, evidence({ realHost: false }), host, ctx)).toThrow(/simulated or skipped/)
    expect(() => validateNativeEvidence(manifest, { ...evidence(), extra: 1 }, host, ctx)).toThrow(/malformed/)
  })

  it('legacy_manifest_is_container_only', async () => {
    const lifted = parseAnyReleaseManifest(JSON.parse(await readFile(join(root, 'deploy/release-manifest.json'), 'utf8')))
    expect(lifted.runtime).toEqual({ kind: 'podman-gvisor', image: 'localhost/dsh-instance:2026.10.0-rc2' })
    expect(lifted.publicEnrollment).toBe('closed')
    const manifest = await nativeManifest()
    expect(() => parseAnyReleaseManifest({ ...manifest, publicEnrollment: 'open' })).toThrow(/cannot open/)
    expect(() => parseAnyReleaseManifest({ ...manifest, runtime: { kind: 'systemd', policyDigest: 'x', toolchainDigest: digest('b') } })).toThrow(/runtime/)
  })
})

describe('native backup and restore', () => {
  async function sources() {
    const base = await mkdtemp(join(tmpdir(), 'dsh-native-backup-'))
    const paths = { identityDatabase: join(base, 'identity.db'), stateDir: join(base, 'state'), quotaDir: join(base, 'quota'), storageRoot: join(base, 'storage') }
    const db = new DatabaseSync(paths.identityDatabase); db.exec("CREATE TABLE user (id TEXT); INSERT INTO user VALUES ('alice')"); db.close()
    for (const dir of [paths.stateDir, paths.quotaDir, join(paths.storageRoot, 'users', 'a', 'workspace')]) await mkdir(dir, { recursive: true })
    await writeFile(join(paths.stateDir, 'alice.json'), '{}'); await writeFile(join(paths.quotaDir, 'ledger.json'), '{}')
    await writeFile(join(paths.storageRoot, 'users', 'a', 'workspace', 'notes.md'), 'keep me')
    await symlink('../workspace/notes.md', join(paths.storageRoot, 'users', 'a', 'link'))
    return { base, paths }
  }

  it('round-trips identity, state, quota and user data, keeping tenant links as links', async () => {
    const { base, paths } = await sources(), archive = join(base, 'backup.tar')
    await createNativeBackup(paths, archive)
    const members = await inspectNativeBackup(archive)
    expect(members).toContain('identity/identity.db')
    const target = join(base, 'restore'); await mkdir(target)
    await restoreNativeBackup(archive, target)
    expect(await readFile(join(target, 'storage', 'users', 'a', 'workspace', 'notes.md'), 'utf8')).toBe('keep me')
    const db = new DatabaseSync(join(target, 'identity', 'identity.db')); expect(db.prepare('SELECT id FROM user').get()).toEqual({ id: 'alice' }); db.close()
    await expect(restoreNativeBackup(archive, target)).rejects.toThrow(/empty directory/)
  })

  it('restore_requires_identity_database', async () => {
    const { base, paths } = await sources(), archive = join(base, 'partial.tar')
    execFileSync('tar', ['--create', '--file', archive, '-C', base, '--transform', 's,^state,state,', 'state'])
    await expect(inspectNativeBackup(archive)).rejects.toThrow(/identity\/identity.db is missing/)
    void paths
  })

  it('restore_rejects_archive_paths', async () => {
    const { base } = await sources()
    const outside = join(base, 'outside.txt'); await writeFile(outside, 'original')
    const evil = join(base, 'evil'); await mkdir(join(evil, 'identity'), { recursive: true })
    await writeFile(join(evil, 'identity', 'identity.db'), '')
    for (const dir of ['state', 'quota', 'storage']) await mkdir(join(evil, dir))
    await symlink(outside, join(evil, 'state', 'escape'))
    const archive = join(base, 'evil.tar')
    execFileSync('tar', ['--create', '--file', archive, '-C', evil, 'identity', 'state', 'quota', 'storage'])
    await expect(inspectNativeBackup(archive)).rejects.toThrow(/link or special/)
    const traversal = join(base, 'traversal.tar')
    execFileSync('tar', ['--create', '--file', traversal, '-C', evil, '--transform', 's,^quota,../quota,', 'identity', 'quota', 'storage'])
    await expect(inspectNativeBackup(traversal)).rejects.toThrow(/unsafe path|unexpected/)
    const target = join(base, 'target'); await mkdir(target)
    await expect(restoreNativeBackup(archive, target)).rejects.toThrow()
    expect(await readdir(target)).toEqual([])
    expect(await readFile(outside, 'utf8')).toBe('original')
    // A tenant link under storage/ followed by a member written "through" it must not reach outside the target.
    const outsideDir = join(base, 'outside-dir'); await mkdir(outsideDir); await writeFile(join(outsideDir, 'victim'), 'original')
    const one = join(base, 'one'), two = join(base, 'two')
    for (const tree of [one, two]) { await mkdir(join(tree, 'identity'), { recursive: true }); await writeFile(join(tree, 'identity', 'identity.db'), ''); for (const dir of ['state', 'quota']) await mkdir(join(tree, dir)) }
    await mkdir(join(one, 'storage')); await symlink(outsideDir, join(one, 'storage', 'link'))
    await mkdir(join(two, 'storage', 'link'), { recursive: true }); await writeFile(join(two, 'storage', 'link', 'victim'), 'overwritten')
    const chained = join(base, 'chained.tar')
    execFileSync('tar', ['--create', '--file', chained, '-C', one, 'identity', 'state', 'quota', 'storage'])
    execFileSync('tar', ['--append', '--file', chained, '-C', two, 'storage/link/victim'])
    const chainedTarget = join(base, 'chained-target'); await mkdir(chainedTarget)
    await restoreNativeBackup(chained, chainedTarget).catch(() => undefined)
    expect(await readFile(join(outsideDir, 'victim'), 'utf8')).toBe('original')
  })
})
