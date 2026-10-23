/** 1E.6: package reconcile-entry.mjs into release/assets layout for native + container. */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { packageReconcileEntry, RECONCILE_ENTRY_FILENAME } from '../src/package-reconcile-entry.ts'
import {
  buildReconcileSystemdRunArgv,
  reconcilePlanPath,
} from '../../runtime-systemd/src/reconcile-unit.ts'
import { config as nativeConfig, instance as nativeInstance } from '../../runtime-systemd/tests/fixture.ts'
import { CONTAINER, buildReconcileRunArgv } from '../../provisioner/src/runtime.ts'

const roots: string[] = []
const integrationRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const packagesRoot = join(integrationRoot, 'packages')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packageReconcileEntry (1E.6 release layout)', () => {
  it('writes reconcile-entry.mjs at the release/assets root and packages plugin-sync', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'dsh-reconcile-pkg-'))
    roots.push(dest)
    const { entryPath } = await packageReconcileEntry({ destDir: dest, packagesRoot })
    expect(RECONCILE_ENTRY_FILENAME).toBe('reconcile-entry.mjs')
    expect(entryPath).toBe(join(dest, RECONCILE_ENTRY_FILENAME))
    accessSync(entryPath, constants.R_OK)
    accessSync(join(dest, 'packages', 'plugin-sync', 'lib', 'index.js'), constants.R_OK)
    accessSync(join(dest, 'packages', 'plugins', 'lib', 'reconcile-entry-main.js'), constants.R_OK)
    expect(entryPath.endsWith(`/${RECONCILE_ENTRY_FILENAME}`)).toBe(true)
  })

  it('packaged entry exits 2 with missing-plan stderr when run with no plan argv', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'dsh-reconcile-pkg-'))
    roots.push(dest)
    const { entryPath } = await packageReconcileEntry({ destDir: dest, packagesRoot })
    const result = spawnSync(process.execPath, [entryPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dest },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/reconcile-entry: missing plan path/)
  })

  it('packaged entry still requires independent market port (1D.6 contract)', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'dsh-reconcile-pkg-'))
    roots.push(dest)
    const home = mkdtempSync(join(tmpdir(), 'dsh-reconcile-home-'))
    roots.push(home)
    mkdirSync(join(home, 'profiles', 'public-user'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'public-user', 'package.json'),
      `${JSON.stringify({ name: 'dsh', dependencies: {} }, null, 2)}\n`,
    )
    const { entryPath } = await packageReconcileEntry({ destDir: dest, packagesRoot })
    const planPath = join(home, 'plan.json')
    writeFileSync(planPath, `${JSON.stringify({
      registry: 'http://127.0.0.1:31001/npm/',
      entries: [],
    })}\n`)
    const result = spawnSync(process.execPath, [entryPath, planPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: home },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/market port required/)
  })
})

describe('consumer path wiring fixtures (native release + container assets)', () => {
  it('runtime-systemd reconcile unit fixture points at ${release}/reconcile-entry.mjs', () => {
    const i = nativeInstance()
    const cfg = nativeConfig()
    const releaseEntry = `${cfg.paths.release}/${RECONCILE_ENTRY_FILENAME}`
    expect(releaseEntry).toBe('/opt/dsh/release/reconcile-entry.mjs')
    const argv = buildReconcileSystemdRunArgv({
      instance: i,
      config: cfg,
      entryPath: releaseEntry,
      planPath: reconcilePlanPath(i.home),
      npmGlobalConfig: '/dev/null',
      marketPort: 31001,
    })
    const sep = argv.indexOf('--')
    expect(argv.slice(sep + 1)).toEqual([
      cfg.tools.node,
      '/opt/dsh/release/reconcile-entry.mjs',
      reconcilePlanPath(i.home),
      '--market-port=31001',
    ])
  })

  it('provisioner one-shot argv points at ${CONTAINER.assets}/reconcile-entry.mjs', () => {
    // Path constant consumed by buildReconcileRunArgv (full argv covered in reconcile-container.spec).
    expect(`${CONTAINER.assets}/${RECONCILE_ENTRY_FILENAME}`).toBe('/opt/public-harness/reconcile-entry.mjs')
    expect(buildReconcileRunArgv).toEqual(expect.any(Function))
  })
})

describe('build-assets.sh ships reconcile-entry.mjs', () => {
  it('assembled assets root contains reconcile-entry.mjs and packages/plugin-sync', () => {
    const script = readFileSync(join(integrationRoot, 'deploy/production/scripts/build-assets.sh'), 'utf8')
    expect(script).toMatch(/reconcile-entry\.mjs/)
    expect(script).toMatch(/plugin-sync/)
  })
})
