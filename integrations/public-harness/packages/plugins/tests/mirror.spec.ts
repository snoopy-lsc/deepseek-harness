/** Mirror pipeline: integrity, closure-source, scripts, freeze, bundle vs fallback, approve digest. */
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MirrorError,
  assertNotReady,
  buildArtifact,
  chooseArtifactMode,
  compareExpectedArtifactSha512,
  detectInstallScripts,
  mirrorVersion,
  readNpmTarball,
  refuseNonSemVerDeps,
  resolveUpload,
  sha512Hex,
  sha512Integrity,
  storeArtifact,
  stripPackagePrefix,
  validateClosureEntries,
  verifyIntegrity,
  type ClosurePackage,
} from '../src/mirror/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mirror-'))
  roots.push(root)
  return root
}

/** Minimal ustar of regular files under a package/ prefix (npm pack layout). */
function writeUstar(files: { path: string; data: Buffer | string }[]): Buffer {
  const parts: Buffer[] = []
  const pad = (data: Buffer) => (data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))]))
  for (const file of files) {
    const data = typeof file.data === 'string' ? Buffer.from(file.data) : file.data
    const name = file.path.slice(0, 99)
    const block = Buffer.alloc(512)
    block.write(name, 0, 'utf8')
    block.write('0000644\0', 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    block.write('00000000000\0', 136, 'ascii')
    block.fill(0x20, 148, 156)
    block.write('0', 156, 'ascii')
    block.write('ustar\0', 257, 'ascii')
    block.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    parts.push(block, pad(data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function npmTgz(manifest: object, extra: { path: string; data: Buffer | string }[] = []): Buffer {
  const pkg = Buffer.from(JSON.stringify(manifest, null, 2))
  return gzipSync(writeUstar([{ path: 'package/package.json', data: pkg }, ...extra.map(e => ({ path: `package/${e.path}`, data: e.data }))]))
}

describe('integrity', () => {
  it('refuses_tarball_when_sha512_integrity_mismatches', () => {
    const bytes = Buffer.from('not-the-real-tarball')
    const integrity = sha512Integrity(Buffer.from('other'))
    expect(() => verifyIntegrity(bytes, integrity)).toThrow(MirrorError)
    expect(() => verifyIntegrity(bytes, integrity)).toThrow(/integrity/)
    verifyIntegrity(bytes, sha512Integrity(bytes))
  })
})

describe('closure-source', () => {
  it('refuses_git_url_file_link_alias_workspace_before_pnpm', () => {
    const bad: [string, string][] = [
      ['git+https://github.com/a/b.git', 'git'],
      ['https://example.com/pkg.tgz', 'url'],
      ['http://example.com/pkg.tgz', 'url'],
      ['file:../local', 'file'],
      ['link:../local', 'link'],
      ['workspace:*', 'workspace'],
      ['npm:other@1.2.3', 'alias'],
      ['github:user/repo', 'github'],
    ]
    for (const [spec] of bad) {
      expect(() => refuseNonSemVerDeps({ dep: spec })).toThrow(MirrorError)
      expect(() => refuseNonSemVerDeps({ dep: spec })).toThrow(/closure-source/)
    }
    refuseNonSemVerDeps({ a: '^1.0.0', b: '~2.3.4', c: '1.2.3', d: '>=1.0.0 <2' })
  })

  it('refuses_lockfile_entries_that_are_not_semver_with_integrity', () => {
    expect(() => validateClosureEntries([
      { name: 'left-pad', version: 'git+https://x', integrity: sha512Integrity(Buffer.from('x')), installScript: null },
    ])).toThrow(/closure-source/)
    expect(() => validateClosureEntries([
      { name: 'left-pad', version: '1.0.0', integrity: '', installScript: null },
    ])).toThrow(/closure-source/)
    validateClosureEntries([
      { name: 'left-pad', version: '1.0.0', integrity: sha512Integrity(Buffer.from('x')), installScript: null },
    ])
  })
})

describe('install scripts', () => {
  it('detects_preinstall_install_postinstall_prepare_gypfile_and_binding_gyp', () => {
    expect(detectInstallScripts({ name: 'a', version: '1.0.0' })).toEqual([])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0', scripts: { preinstall: 'x' } })).toEqual(['preinstall'])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0', scripts: { install: 'x' } })).toEqual(['install'])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0', scripts: { postinstall: 'x' } })).toEqual(['postinstall'])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0', scripts: { prepare: 'x' } })).toEqual(['prepare'])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0', gypfile: true })).toEqual(['gypfile'])
    expect(detectInstallScripts({ name: 'a', version: '1.0.0' }, { hasBindingGyp: true })).toEqual(['binding.gyp'])
    expect(detectInstallScripts(
      { name: 'a', version: '1.0.0', scripts: { preinstall: 'a', install: 'b', postinstall: 'c', prepare: 'd' }, gypfile: true },
      { hasBindingGyp: true },
    )).toEqual(['preinstall', 'install', 'postinstall', 'prepare', 'gypfile', 'binding.gyp'])
  })
})

describe('artifact mode (P0.3)', () => {
  it('uses_bundle_when_closure_has_no_scripts_else_fallback', () => {
    const clean: ClosurePackage[] = [
      { name: 'dep', version: '1.0.0', integrity: sha512Integrity(Buffer.from('d')), installScript: null },
    ]
    const dirty: ClosurePackage[] = [
      { name: 'dep', version: '1.0.0', integrity: sha512Integrity(Buffer.from('d')), installScript: 'postinstall' },
    ]
    expect(chooseArtifactMode(clean)).toBe('bundle')
    expect(chooseArtifactMode(dirty)).toBe('fallback')
    expect(chooseArtifactMode([])).toBe('bundle')
  })
})

describe('store freeze', () => {
  it('never_rewrites_a_ready_artifact_blob', () => {
    const root = tmp()
    const storeRoot = join(root, 'store')
    const bytes = Buffer.from('artifact-v1')
    const sha = sha512Hex(bytes)
    storeArtifact(storeRoot, sha, bytes)
    expect(readFileSync(join(storeRoot, 'sha512', sha)).equals(bytes)).toBe(true)
    expect(() => storeArtifact(storeRoot, sha, Buffer.from('different'))).toThrow(MirrorError)
    expect(() => storeArtifact(storeRoot, sha, Buffer.from('different'))).toThrow(/ready-frozen|blob-immutable/)
    // same bytes is idempotent
    storeArtifact(storeRoot, sha, bytes)
    expect(() => assertNotReady('ready')).toThrow(/ready-frozen/)
    assertNotReady('queued')
    assertNotReady('verifying')
    assertNotReady('failed')
  })
})

describe('expected_artifact_sha512', () => {
  it('compare_helper_rejects_mismatch_with_artifact-mismatch', () => {
    const stored = 'a'.repeat(128)
    expect(() => compareExpectedArtifactSha512('b'.repeat(128), stored)).toThrow(MirrorError)
    expect(() => compareExpectedArtifactSha512('b'.repeat(128), stored)).toThrow(/artifact-mismatch/)
    compareExpectedArtifactSha512(stored, stored)
  })
})

describe('mirrorVersion (fixtures)', () => {
  it('mirrors_upload_to_bundle_when_no_scripts_and_pins_sha512', async () => {
    const root = tmp()
    const tarball = npmTgz({
      name: '@corp-dsh/demo',
      version: '1.0.0',
      dependencies: { 'left-pad': '^1.0.0' },
    })
    const depTgz = npmTgz({ name: 'left-pad', version: '1.0.0' }, [{ path: 'index.js', data: 'module.exports = x => x\n' }])
    const closure: ClosurePackage[] = [
      { name: 'left-pad', version: '1.0.0', integrity: sha512Integrity(depTgz), installScript: null },
    ]
    const result = await mirrorVersion({
      source: { type: 'upload', tarball },
      storeRoot: join(root, 'store'),
      closure,
      fetchClosureTarball: async () => depTgz,
    })
    expect(result.mode).toBe('bundle')
    expect(result.artifactSha512).toMatch(/^[0-9a-f]{128}$/)
    expect(result.closure).toHaveLength(1)
    expect(existsSync(join(root, 'store', 'sha512', result.artifactSha512))).toBe(true)
    const stored = readFileSync(join(root, 'store', 'sha512', result.artifactSha512))
    expect(stored.subarray(0, 4).toString('utf8')).not.toBe('DSHB')
    expect(stored[0]).toBe(0x1f)
    expect(stored[1]).toBe(0x8b)
    // freeze: second mirror of same ready sha path refuses different content via store
    expect(() => assertNotReady('ready')).toThrow(/ready-frozen/)
  })

  it('selects_fallback_when_any_closure_package_has_install_script', async () => {
    const root = tmp()
    const tarball = npmTgz({ name: '@corp-dsh/demo', version: '1.0.0' })
    const closure: ClosurePackage[] = [
      { name: 'native-dep', version: '2.0.0', integrity: sha512Integrity(Buffer.from('n')), installScript: 'binding.gyp' },
    ]
    const result = await mirrorVersion({
      source: { type: 'upload', tarball },
      storeRoot: join(root, 'store'),
      closure,
      fetchClosureTarball: async () => Buffer.from('n'),
    })
    expect(result.mode).toBe('fallback')
  })

  it('refuses_non_corp_scope_on_upload', () => {
    const tarball = npmTgz({ name: 'left-pad', version: '1.0.0' })
    expect(() => resolveUpload(tarball)).toThrow(MirrorError)
    expect(() => resolveUpload(tarball)).toThrow(/scope/)
  })

  it('refuses_upload_deps_that_are_not_semver_ranges', () => {
    const tarball = npmTgz({
      name: '@corp-dsh/demo',
      version: '1.0.0',
      dependencies: { bad: 'git+https://github.com/a/b.git' },
    })
    expect(() => resolveUpload(tarball)).toThrow(/closure-source/)
  })

  it('buildArtifact_bundle_emits_npm_tgz_with_bundleDependencies_not_DSHB', () => {
    const plugin = npmTgz({
      name: '@corp-dsh/demo',
      version: '1.0.0',
      dependencies: { 'left-pad': '^1.0.0' },
    }, [{ path: 'index.js', data: 'export default 1\n' }])
    const dep = npmTgz({
      name: 'left-pad',
      version: '1.0.0',
    }, [{ path: 'index.js', data: 'module.exports = function leftPad() {}\n' }])
    const closure: ClosurePackage[] = [
      { name: 'left-pad', version: '1.0.0', integrity: sha512Integrity(dep), installScript: null },
    ]
    const { bytes, mode } = buildArtifact({
      mode: 'bundle',
      pluginTarball: plugin,
      closure,
      closureTarballs: [dep],
    })
    expect(mode).toBe('bundle')
    expect(bytes.subarray(0, 4).toString('utf8')).not.toBe('DSHB')
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    const files = stripPackagePrefix(readNpmTarball(bytes))
    const manifestEntry = files.find(f => f.path === 'package.json')
    expect(manifestEntry).toBeTruthy()
    const manifest = JSON.parse(manifestEntry!.data.toString('utf8')) as {
      bundleDependencies?: string[]
      bundledDependencies?: string[]
      dependencies?: Record<string, string>
    }
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies
    expect(bundled).toEqual(['left-pad'])
    expect(manifest.dependencies?.['left-pad']).toBe('1.0.0')
    expect(files.some(f => f.path === 'index.js')).toBe(true)
    expect(files.some(f => f.path === 'node_modules/left-pad/package.json')).toBe(true)
    expect(files.some(f => f.path === 'node_modules/left-pad/index.js')).toBe(true)
  })

  it('buildArtifact_caps_at_200_MiB', () => {
    const huge = Buffer.alloc(200 * 1024 * 1024 + 1, 1)
    expect(() => buildArtifact({ mode: 'fallback', pluginTarball: huge, closure: [] })).toThrow(/artifact-too-large/)
  })
})

describe('resolve npm fixture', () => {
  it('checks_dist_integrity_and_tarball_host', async () => {
    const { resolveNpmVersion } = await import('../src/mirror/index.ts')
    const body = Buffer.from('pkg-bytes')
    const integrity = sha512Integrity(body)
    const packument = {
      name: '@corp-dsh/demo',
      versions: {
        '1.0.0': {
          name: '@corp-dsh/demo',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.npmjs.org/@corp-dsh/demo/-/demo-1.0.0.tgz',
            integrity,
          },
          dependencies: {},
        },
      },
    }
    const resolved = await resolveNpmVersion(packument, '1.0.0', {
      registryHost: 'registry.npmjs.org',
      fetchTarball: async (url) => {
        expect(url).toContain('registry.npmjs.org')
        return body
      },
    })
    expect(resolved.upstreamIntegrity).toBe(integrity)
    expect(resolved.name).toBe('@corp-dsh/demo')

    await expect(resolveNpmVersion(packument, '1.0.0', {
      registryHost: 'registry.npmjs.org',
      fetchTarball: async () => Buffer.from('wrong'),
    })).rejects.toThrow(/integrity/)

    const badHost = {
      name: '@corp-dsh/demo',
      versions: {
        '1.0.0': {
          name: '@corp-dsh/demo',
          version: '1.0.0',
          dist: { tarball: 'https://evil.example/x.tgz', integrity },
          dependencies: {},
        },
      },
    }
    await expect(resolveNpmVersion(badHost, '1.0.0', {
      registryHost: 'registry.npmjs.org',
      fetchTarball: async () => body,
    })).rejects.toThrow(/tarball-host|integrity|package/)
  })
})
