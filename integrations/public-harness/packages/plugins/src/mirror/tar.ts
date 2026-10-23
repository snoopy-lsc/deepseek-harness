/** Safe npm-style ustar reader for upload / packument tarballs (no links, 10k / 200 MiB). */
import { gunzipSync } from 'node:zlib'
import { MirrorError } from './errors.ts'

export interface TarFile { readonly path: string; readonly data: Buffer }

export const MAX_UPLOAD_ENTRIES = 10_000
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024

function safeRelativePath(raw: string): string {
  const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (path.length === 0 || Buffer.byteLength(path) > 400 || path.startsWith('/') || path.includes('\\') || /[\0-\x1f\x7f]/.test(path)) {
    throw new MirrorError('upload', 'path')
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new MirrorError('upload', 'path')
  }
  return path
}

const text = (block: Buffer, start: number, length: number) => {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}
const octal = (block: Buffer, start: number, length: number) => {
  const value = text(block, start, length).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/.test(value)) throw new MirrorError('upload', 'header')
  return parseInt(value, 8)
}

/** Read a plain ustar archive (regular files + directories only). */
export function readUstar(archive: Buffer): TarFile[] {
  const files: TarFile[] = []
  const seen = new Set<string>()
  let offset = 0
  let total = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    if (sum !== octal(header, 148, 8)) throw new MirrorError('upload', 'checksum')
    const type = String.fromCharCode(header[156] || 0x30)
    const size = octal(header, 124, 12)
    const body = offset + 512
    if (body + size > archive.length) throw new MirrorError('upload', 'truncated')
    const data = archive.subarray(body, body + size)
    offset = body + Math.ceil(size / 512) * 512
    if (type === 'g' || type === 'x') continue
    const magic = text(header, 257, 6)
    const prefix = magic.startsWith('ustar') ? text(header, 345, 155) : ''
    const name = prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100)
    if (name === 'pax_global_header') continue
    // refuse symlinks, hard links, devices, FIFOs
    if (type !== '0' && type !== '5' && type !== '\0') throw new MirrorError('upload', 'entry-type')
    const path = safeRelativePath(name)
    if (seen.has(path)) throw new MirrorError('upload', 'duplicate')
    seen.add(path)
    if (type === '5') continue
    if (files.length >= MAX_UPLOAD_ENTRIES) throw new MirrorError('upload', 'too-many')
    total += size
    if (total > MAX_UNPACKED_BYTES) throw new MirrorError('artifact-too-large', String(total))
    files.push({ path, data: Buffer.from(data) })
  }
  return files
}

/** Gunzip (if needed) and read an npm pack tarball. */
export function readNpmTarball(tarball: Buffer): TarFile[] {
  let archive = tarball
  if (tarball.length >= 2 && tarball[0] === 0x1f && tarball[1] === 0x8b) {
    try { archive = gunzipSync(tarball) } catch { throw new MirrorError('upload', 'gzip') }
  }
  return readUstar(archive)
}

/** Strip the leading `package/` (or other single root) npm pack prefix. */
export function stripPackagePrefix(files: readonly TarFile[]): TarFile[] {
  if (files.length === 0) return []
  const first = files[0]!.path
  const slash = first.indexOf('/')
  if (slash <= 0) return [...files]
  const root = first.slice(0, slash)
  if (!files.every(f => f.path === root || f.path.startsWith(`${root}/`))) return [...files]
  return files
    .filter(f => f.path.startsWith(`${root}/`))
    .map(f => ({ path: f.path.slice(root.length + 1), data: f.data }))
}
