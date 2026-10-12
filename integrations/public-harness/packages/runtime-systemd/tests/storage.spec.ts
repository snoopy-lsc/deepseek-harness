import { mkdtemp, mkdir, readFile, stat, symlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDirectoryNoFollow, validateRootAssets } from '../src/storage.ts'

describe.skipIf(process.platform === 'win32')('native no-follow storage', () => {
  it('symlink_cannot_redirect_root_write', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-native-victim-'))
    try {
      const victim = join(base, 'victim'); await mkdir(victim)
      await writeFile(join(victim, 'bytes'), 'do not change'); const before = await stat(victim)
      const link = join(base, 'home'); await symlink(victim, link)
      await expect(openDirectoryNoFollow(link)).rejects.toThrow()
      expect(await readFile(join(victim, 'bytes'), 'utf8')).toBe('do not change')
      const after = await stat(victim)
      expect({ uid: after.uid, gid: after.gid, mode: after.mode }).toEqual({ uid: before.uid, gid: before.gid, mode: before.mode })
    } finally { await rm(base, { recursive: true, force: true }) }
  })
  it('rejects writable release assets before preparation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-native-assets-'))
    try {
      await writeFile(join(base, 'dsh.mjs'), 'throw new Error("never execute")', { mode: 0o666 })
      await expect(validateRootAssets([base])).rejects.toMatchObject({ code: 'unsafe-path' })
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})

it.skipIf(process.platform === 'win32')('resolves an internal immutable link and refuses an escaping or dangling link', async () => {
  const { resolveImmutablePath } = await import('../src/storage.ts')
  const base = await mkdtemp(join(tmpdir(), 'dsh-native-links-'))
  try {
    const root = join(base, 'release'); await mkdir(root)
    const target = join(root, 'target'); await writeFile(target, 'immutable content', { mode: 0o444 })
    await symlink('target', join(root, 'internal'))
    const canonical = await import('node:fs/promises').then(fs => fs.realpath(root))
    expect(await resolveImmutablePath(join(root, 'internal'), [canonical])).toBe(join(canonical, 'target'))
    await symlink('../outside', join(root, 'escape')); await writeFile(join(base, 'outside'), 'foreign')
    await expect(resolveImmutablePath(join(root, 'escape'), [canonical])).rejects.toMatchObject({ code: 'unsafe-path', operation: 'asset-link-escape' })
    await symlink('absent', join(root, 'dangling'))
    await expect(resolveImmutablePath(join(root, 'dangling'), [canonical])).rejects.toMatchObject({ operation: 'asset-link-resolution' })
    await symlink('cycle-b', join(root, 'cycle-a')); await symlink('cycle-a', join(root, 'cycle-b'))
    await expect(resolveImmutablePath(join(root, 'cycle-a'), [canonical])).rejects.toMatchObject({ operation: 'asset-link-resolution' })
    await expect(validateRootAssets([join(root, 'internal')], [canonical])).rejects.toMatchObject({ code: 'unsafe-path' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'linux')('held directory descriptor ignores a replaced parent pathname', async () => {
  const { ensureDirectoryAt } = await import('../src/storage.ts')
  const { rename, realpath } = await import('node:fs/promises')
  const base = await mkdtemp(join(tmpdir(), 'dsh-native-rename-'))
  let parent: Awaited<ReturnType<typeof openDirectoryNoFollow>> | undefined
  try {
    const trusted = join(base, 'trusted'), victim = join(base, 'victim')
    await mkdir(trusted, { mode: 0o700 }); await mkdir(victim)
    await writeFile(join(victim, 'bytes'), 'unchanged'); const before = await stat(victim)
    parent = await openDirectoryNoFollow(trusted)
    await rename(trusted, join(base, 'held')); await symlink(victim, trusted)
    const child = await ensureDirectoryAt(parent, 'home', { uid: process.getuid!(), gid: process.getgid!() }, 0o700)
    try { expect(await realpath(`/proc/self/fd/${child.fd}`)).toBe(await realpath(join(base, 'held/home'))) }
    finally { await child.close() }
    expect(await readFile(join(victim, 'bytes'), 'utf8')).toBe('unchanged')
    expect((await stat(victim)).uid).toBe(before.uid)
    await expect(stat(join(victim, 'home'))).rejects.toMatchObject({ code: 'ENOENT' })
    await symlink(victim, join(base, 'held/linked'))
    await expect(ensureDirectoryAt(parent, 'linked', { uid: process.getuid!(), gid: process.getgid!() }, 0o700)).rejects.toMatchObject({ code: 'unsafe-path' })
  } finally { await parent?.close(); await rm(base, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('root-owned internal asset links pass; writable targets and escapes reject', async () => {
  // Root-only Linux evidence uses an exclusively created fixture below a trusted root ancestor, never /tmp.
  const base = await mkdtemp('/root/dsh-assets-')
  const { chmod } = await import('node:fs/promises')
  try {
    const release = join(base, 'release'); await mkdir(release)
    const target = join(release, 'target'); await writeFile(target, 'asset', { mode: 0o444 })
    await symlink('target', join(release, 'link'))
    await expect(validateRootAssets([release])).resolves.toBeUndefined()
    await chmod(target, 0o666)
    await expect(validateRootAssets([release])).rejects.toMatchObject({ code: 'unsafe-path' })
    await chmod(target, 0o444)
    const outside = join(base, 'outside'); await writeFile(outside, 'outside', { mode: 0o444 })
    await symlink(outside, join(release, 'escape'))
    await expect(validateRootAssets([release])).rejects.toMatchObject({ operation: 'asset-link-escape' })
  } finally { await rm(base, { recursive: true, force: true }) }
})
