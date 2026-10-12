/** Native backup and restore: one tar archive with a consistent identity database copy, provisioning and quota state,
 * and private user data. Trusted secrets are never included. Restore refuses incomplete archives and unsafe entries. */
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** What a native backup contains; each path is copied under its archive name. */
export interface NativeBackupSources {
  readonly identityDatabase: string
  readonly stateDir: string
  readonly quotaDir: string
  readonly storageRoot: string
}
/** Archive members every restore requires. */
export const REQUIRED_MEMBERS = ['identity/identity.db', 'state/', 'quota/', 'storage/'] as const

/** Write a backup. Services must be stopped, or at least the provisioner, so state and storage agree.
 * @param sources Live paths.
 * @param archive Output `.tar` path (must not exist).
 * @param tar GNU tar executable.
 */
export async function createNativeBackup(sources: NativeBackupSources, archive: string, tar = '/usr/bin/tar'): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-backup-'))
  try {
    await mkdir(join(staging, 'identity'), { mode: 0o700 })
    // VACUUM INTO produces a consistent copy even with WAL readers still attached.
    const db = new DatabaseSync(sources.identityDatabase, { readOnly: true })
    try { db.exec(`VACUUM INTO '${join(staging, 'identity', 'identity.db').replace(/'/g, "''")}'`) } finally { db.close() }
    await run(tar, ['--create', '--file', archive, '--numeric-owner', '-C', staging, 'identity'])
    for (const [member, source] of [['state', sources.stateDir], ['quota', sources.quotaDir], ['storage', sources.storageRoot]] as const) {
      // Links are archived as links, never followed, so a tenant link cannot pull other files into the backup.
      await run(tar, ['--append', '--file', archive, '--numeric-owner', '-C', dirname(source), '--transform', `s,^${basename(source)},${member},`, basename(source)])
    }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** List and validate archive members without extracting anything.
 * @param archive Backup path.
 * @param tar GNU tar executable.
 * @returns Member names.
 */
export async function inspectNativeBackup(archive: string, tar = '/usr/bin/tar'): Promise<string[]> {
  const { stdout } = await run(tar, ['--list', '--verbose', '--numeric-owner', '--file', archive], { maxBuffer: 256 * 1024 * 1024 })
  const names: string[] = []
  for (const line of stdout.split('\n').filter(Boolean)) {
    const type = line[0]
    let name = line.split(/\s+/).slice(5).join(' ')
    // Tenant data may hold symbolic links (node_modules/.bin); they are allowed only under storage/, and GNU tar creates
    // them after all other members, so a later member cannot be written through one. Hard links, devices and FIFOs are refused.
    if (type === 'l' && name.startsWith('storage/')) name = name.slice(0, name.indexOf(' -> '))
    else if (type !== '-' && type !== 'd') throw new Error('backup contains a link or special file')
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) throw new Error('backup contains an unsafe path')
    if (!/^(identity|state|quota|storage)(\/|$)/.test(name)) throw new Error('backup contains an unexpected member')
    names.push(name)
  }
  for (const member of REQUIRED_MEMBERS) if (!names.some(name => name === member || name.startsWith(member))) throw new Error(`backup is incomplete: ${member} is missing`)
  return names
}

/** Restore into an empty target directory after validating every member; nothing outside the target is written.
 * @param archive Backup path.
 * @param target Empty directory that receives identity/, state/, quota/ and storage/.
 * @param tar GNU tar executable.
 */
export async function restoreNativeBackup(archive: string, target: string, tar = '/usr/bin/tar'): Promise<void> {
  await inspectNativeBackup(archive, tar)
  const info = await lstat(target)
  if (!info.isDirectory() || (await readdir(target)).length !== 0) throw new Error('restore target must be an empty directory')
  await run(tar, ['--extract', '--file', archive, '--numeric-owner', '--keep-old-files', '-C', target])
}
