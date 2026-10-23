/** 1D.3: sync op log + user-removal rule. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendOp,
  detectUserRemovals,
  isUserRemoved,
  readOps,
  syncLogPath,
  type SyncOp,
} from '../src/oplog.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-oplog-'))
  roots.push(root)
  return root
}

function writeProfile(dir: string, deps: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh', dependencies: deps }, null, 2)}\n`)
}

describe('syncLogPath', () => {
  it('lives_under_dsh_market_in_home', () => {
    const home = fixtureHome()
    expect(syncLogPath(home)).toBe(join(home, '.dsh-market', 'sync-log.jsonl'))
  })
})

describe('appendOp / readOps', () => {
  it('appends_jsonl_records_for_all_core_types', async () => {
    const home = fixtureHome()
    const types: SyncOp['type'][] = ['intent', 'done', 'removed', 'failed', 'recovered', 'user-removed']
    for (const type of types) {
      await appendOp(home, { type, name: '@corp-dsh/demo', version: '1.0.0', at: 10 })
    }
    const ops = await readOps(home)
    expect(ops.map((o) => o.type)).toEqual(types)
    expect(readFileSync(syncLogPath(home), 'utf8').trim().split('\n')).toHaveLength(types.length)
  })
})

describe('detectUserRemovals', () => {
  it('writes_user_removed_when_done_install_absent_and_no_later_removed', async () => {
    const home = fixtureHome()
    const profile = join(home, 'profile')
    writeProfile(profile, {})
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })

    const written = await detectUserRemovals({ home, profileDir: profile, now: 5 })
    expect(written).toEqual(['@corp-dsh/demo'])
    expect(await readOps(home)).toContainEqual(expect.objectContaining({
      type: 'user-removed',
      name: '@corp-dsh/demo',
      at: 5,
    }))
  })

  it('covers_hand_edit_shape_same_as_cli_remove', async () => {
    const home = fixtureHome()
    const profile = join(home, 'profile')
    // Hand edit: package.json no longer lists the dep (same observable shape as dsh plugin remove).
    writeProfile(profile, { other: '1.0.0' })
    await appendOp(home, { type: 'done', name: '@corp-dsh/cli-removed', version: '2.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'done', name: '@corp-dsh/hand-edit', version: '3.0.0', action: 'update', at: 2 })

    const written = await detectUserRemovals({ home, profileDir: profile, now: 9 })
    expect(written.sort()).toEqual(['@corp-dsh/cli-removed', '@corp-dsh/hand-edit'])
  })

  it('does_not_write_when_package_still_present', async () => {
    const home = fixtureHome()
    const profile = join(home, 'profile')
    writeProfile(profile, { '@corp-dsh/demo': '1.0.0' })
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })
    expect(await detectUserRemovals({ home, profileDir: profile, now: 5 })).toEqual([])
    expect((await readOps(home)).some((o) => o.type === 'user-removed')).toBe(false)
  })

  it('does_not_write_when_sync_removed_after_done', async () => {
    const home = fixtureHome()
    const profile = join(home, 'profile')
    writeProfile(profile, {})
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'removed', name: '@corp-dsh/demo', version: '1.0.0', at: 2 })
    expect(await detectUserRemovals({ home, profileDir: profile, now: 5 })).toEqual([])
  })

  it('does_not_duplicate_existing_user_removed', async () => {
    const home = fixtureHome()
    const profile = join(home, 'profile')
    writeProfile(profile, {})
    await appendOp(home, { type: 'done', name: '@corp-dsh/demo', version: '1.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'user-removed', name: '@corp-dsh/demo', at: 2 })
    expect(await detectUserRemovals({ home, profileDir: profile, now: 5 })).toEqual([])
    expect((await readOps(home)).filter((o) => o.type === 'user-removed')).toHaveLength(1)
  })
})

describe('isUserRemoved', () => {
  it('is_true_after_user_removed_until_reset_or_reenable', async () => {
    const home = fixtureHome()
    await appendOp(home, { type: 'done', name: 'pkg', version: '1.0.0', action: 'install', at: 1 })
    await appendOp(home, { type: 'user-removed', name: 'pkg', at: 2 })
    expect(isUserRemoved(await readOps(home), 'pkg')).toBe(true)

    await appendOp(home, { type: 'reset', name: 'pkg', at: 3 })
    expect(isUserRemoved(await readOps(home), 'pkg')).toBe(false)
  })

  it('reenable_also_clears_the_block', async () => {
    const home = fixtureHome()
    await appendOp(home, { type: 'user-removed', name: 'pkg', at: 1 })
    await appendOp(home, { type: 're-enable', name: 'pkg', at: 2 })
    expect(isUserRemoved(await readOps(home), 'pkg')).toBe(false)
  })
})
