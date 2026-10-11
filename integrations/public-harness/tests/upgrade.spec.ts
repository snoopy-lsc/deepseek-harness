import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUserId } from '../packages/contracts/src/index.ts'
import { currentRelease, parseReleaseManifest, preflightUpgrade, rolloutUpgrade, switchRelease, type CanaryProbe, type ReleaseManifest, type RolloutDeps } from '../deploy/upgrade.ts'

const base = JSON.parse(await readFile(new URL('../deploy/release-manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>
const previous = { release: '2026.09.0', harness: { package: '@deepseek-ai/dsh', version: '0.2.0' }, image: 'localhost/dsh-instance:2026.09.0',
  pluginApi: { '@deepseek-ai/cordis': '4.0.4' }, bundles: { '@public-harness/ui': '0.0.9' } }
const manifest = (overrides: Record<string, unknown> = {}): ReleaseManifest => parseReleaseManifest({ ...base, previous, ...overrides })
const users = ['alice', 'bob', 'carol', 'dave'].map(parseUserId)

function probe(overrides: Partial<CanaryProbe> = {}, current = manifest()): CanaryProbe {
  const ok = async (): Promise<void> => {}
  return { installedPluginApi: async () => current.pluginApi, installedBundles: async () => current.bundles, migrateSessions: ok,
    flows: { login: ok, modelCall: ok, terminal: ok, session: ok, pluginLoading: ok }, ...overrides }
}

describe('release manifest', () => {
  it('accepts the shipped manifest and keeps enrollment closed', () => {
    expect(parseReleaseManifest(base).release).toBe(base.release)
    expect(() => parseReleaseManifest({ ...base, publicEnrollment: 'open' })).toThrow(/enrollment/)
  })
  it.each([
    [{ bundles: { '@public-harness/ui': '^0.1.0' } }, 'exact'],
    [{ bundles: {} }, 'pinned'],
    [{ image: 'dsh-instance' }, 'image'],
    [{ extra: true }, 'unexpected'],
    [{ release: '../x' }, 'release'],
    [{ schema: 2 }, 'schema'],
  ])('rejects an unpinned or malformed manifest', (override, message) => {
    expect(() => parseReleaseManifest({ ...base, ...override })).toThrow(new RegExp(message, 'i'))
  })
})

describe('canary preflight', () => {
  it('passes when every flow and pin matches', async () => {
    expect(await preflightUpgrade(manifest(), probe())).toEqual({ ok: true, failures: [] })
  })
  it('stops on an incompatible plugin API before exercising any flow', async () => {
    let ran = false
    const report = await preflightUpgrade(manifest(), probe({ installedPluginApi: async () => ({ '@deepseek-ai/cordis': '5.0.0' }),
      flows: { login: async () => { ran = true }, modelCall: async () => {}, terminal: async () => {}, session: async () => {}, pluginLoading: async () => {} } }))
    expect(report).toEqual({ ok: false, failures: ['plugin-api'] })
    expect(ran).toBe(false)
  })
  it('reports a failed Session migration and individual flow failures without values', async () => {
    expect(await preflightUpgrade(manifest(), probe({ migrateSessions: async () => { throw new Error('secret path /home/x') } })))
      .toEqual({ ok: false, failures: ['session-migration'] })
    const flows = { login: async () => {}, modelCall: async () => { throw new Error('boom') }, terminal: async () => {}, session: async () => {}, pluginLoading: async () => { throw new Error('x') } }
    expect(await preflightUpgrade(manifest(), probe({ flows }))).toEqual({ ok: false, failures: ['modelCall', 'pluginLoading'] })
  })
  it('fails when a bundle in the canary differs from the pin', async () => {
    expect((await preflightUpgrade(manifest(), probe({ installedBundles: async () => ({ '@public-harness/ui': '0.0.1' }) }))).failures).toEqual(['bundle-versions'])
  })
})

describe.skipIf(process.platform === 'win32')('staged rollout and code-only rollback', () => {
  async function layout() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upgrade-'))
    const releasesDir = join(root, 'releases')
    for (const release of ['2026.09.0', String(base.release)]) await mkdir(join(releasesDir, release), { recursive: true })
    const assetsLink = join(root, 'assets-current')
    await switchRelease(assetsLink, join(releasesDir, '2026.09.0'))
    // A released Session generation that no operation may move or delete.
    const dshHome = join(root, 'users', 'alice', 'home')
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, 'session'), 'generation-1')
    return { root, releasesDir, assetsLink, statePath: join(root, 'state', 'rollout.json'), dshHome }
  }
  const deps = (log: string[], fail: string[] = []): RolloutDeps => ({
    stop: async userId => { log.push(`stop ${userId}`) },
    wake: async userId => { log.push(`wake ${userId}`); return !fail.includes(userId) },
  })

  it('upgrades canaries first, then batches, and records progress', async () => {
    const files = await layout()
    const log: string[] = []
    const result = await rolloutUpgrade({ manifest: manifest(), ...files, users, canaryUsers: [users[2]!], batchSize: 2 }, deps(log))
    expect(result.completed).toBe(true)
    expect(log.slice(0, 2)).toEqual(['stop carol', 'wake carol'])
    expect(await readlink(files.assetsLink)).toBe(join(files.releasesDir, String(base.release)))
    expect(JSON.parse(await readFile(files.statePath, 'utf8')).upgraded).toHaveLength(4)
  })

  it('stops on the first failure and restores the previous code without touching data', async () => {
    const files = await layout()
    const log: string[] = []
    const result = await rolloutUpgrade({ manifest: manifest(), ...files, users, canaryUsers: [users[0]!], batchSize: 1 }, deps(log, ['bob']))
    expect(result).toMatchObject({ completed: false, failed: 'bob', rolledBack: true, upgraded: ['alice'] })
    expect(log.some(entry => entry.includes('carol'))).toBe(false)
    expect(await currentRelease(files.assetsLink)).toBe(join(files.releasesDir, '2026.09.0'))
    expect(await readFile(join(files.dshHome, 'session'), 'utf8')).toBe('generation-1')
  })

  it('resumes an interrupted rollout without repeating finished users', async () => {
    const files = await layout()
    const first: string[] = []
    const crashing: RolloutDeps = { stop: async userId => { if (userId === 'carol') throw new Error('power loss'); first.push(`stop ${userId}`) },
      wake: async () => true }
    const interrupted = await rolloutUpgrade({ manifest: manifest(), ...files, users, canaryUsers: [], batchSize: 1 }, crashing)
    expect(interrupted.completed).toBe(false)
    // Clear the failure marker the operator reviewed, keeping the recorded progress.
    const state = JSON.parse(await readFile(files.statePath, 'utf8')) as { release: string; upgraded: string[] }
    await writeFile(files.statePath, JSON.stringify({ release: state.release, upgraded: state.upgraded }))
    const second: string[] = []
    const resumed = await rolloutUpgrade({ manifest: manifest(), ...files, users, canaryUsers: [], batchSize: 1 }, deps(second))
    expect(resumed.completed).toBe(true)
    expect(second.filter(entry => entry.startsWith('stop')).map(entry => entry.slice(5)).sort()).toEqual(['carol', 'dave'])
  })

  it('refuses to roll out another release over saved state, a missing previous, or a failed run', async () => {
    const files = await layout()
    await rolloutUpgrade({ manifest: manifest(), ...files, users, canaryUsers: [], batchSize: 4 }, deps([]))
    await expect(rolloutUpgrade({ manifest: manifest({ release: '2026.11.0' }), ...files, users, canaryUsers: [], batchSize: 1 }, deps([]))).rejects.toThrow(/another release/)
    await expect(rolloutUpgrade({ manifest: manifest({ previous: null }), ...files, users, canaryUsers: [], batchSize: 1 }, deps([]))).rejects.toThrow(/previous/)
  })

  it('will not replace a real directory with a release link', async () => {
    const files = await layout()
    await expect(switchRelease(files.releasesDir, join(files.releasesDir, '2026.09.0'))).rejects.toThrow(/non-link/)
    await expect(switchRelease('relative', '/abs')).rejects.toThrow(/absolute/)
  })
})
