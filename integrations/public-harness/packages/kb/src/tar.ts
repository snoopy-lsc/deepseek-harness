/** Minimal tar reader and writer for knowledge base exports.
 *
 * The reader accepts the ustar archives `git archive` writes (with pax `x` and `g` headers) and refuses anything else:
 * links, devices, FIFOs, GNU long-name records, absolute paths, `..` segments, control characters, and archives above the
 * configured file-count or size limits. Files whose extension is not allowed are skipped and reported, never written. */

/** One regular file of an archive. */
export interface TarFile { readonly path: string; readonly data: Buffer; readonly mode?: number }

/** Limits applied while reading. */
export interface TarLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  /** Lower-case extensions (with the dot) that are kept; `.gitkeep` files are always kept. */
  readonly extensions: readonly string[]
}

/** Result of validating one archive. */
export interface TarRead { readonly files: TarFile[]; readonly directories: string[]; readonly skipped: string[] }

/** The archive broke a rule; the code names which. */
export class TarError extends Error {
  readonly code: string
  constructor(code: string) { super(`invalid archive: ${code}`); this.code = code }
}

export const SOURCE_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf', '.docx', '.html', '.htm'] as const
export const DEFAULT_TAR_LIMITS: TarLimits = { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, extensions: SOURCE_EXTENSIONS }

/** Validate a relative archive path: forward slashes, no empty, `.` or `..` segments, no control characters, at most 400 bytes.
 * @param raw Path as stored (a trailing slash marks a directory).
 * @returns Normalized path without a trailing slash.
 */
export function safeRelativePath(raw: string): string {
  const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (path.length === 0 || Buffer.byteLength(path) > 400 || path.startsWith('/') || path.includes('\\') || /[\0-\x1f\x7f]/.test(path)) throw new TarError('path')
  for (const segment of path.split('/')) if (segment === '' || segment === '.' || segment === '..') throw new TarError('path')
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
  if (!/^[0-7]+$/.test(value)) throw new TarError('header')
  return parseInt(value, 8)
}
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number(data.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) throw new TarError('pax')
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += length
  }
  return out
}

/** Read and validate a tar archive.
 * @param archive Whole archive.
 * @param limits Count, size and extension limits.
 * @returns Regular files, directories and skipped paths.
 */
export function readTar(archive: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): TarRead {
  const files: TarFile[] = [], directories: string[] = [], skipped: string[] = []
  const seen = new Set<string>()
  let offset = 0, total = 0, pax: Record<string, string> = {}
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    if (sum !== octal(header, 148, 8)) throw new TarError('checksum')
    const type = String.fromCharCode(header[156] || 0x30)
    const size = octal(header, 124, 12)
    const body = offset + 512
    if (body + size > archive.length) throw new TarError('truncated')
    const data = archive.subarray(body, body + size)
    offset = body + Math.ceil(size / 512) * 512
    if (type === 'g') continue
    if (type === 'x') { pax = paxRecords(data); continue }
    const magic = text(header, 257, 6)
    const prefix = magic.startsWith('ustar') ? text(header, 345, 155) : ''
    const name = pax.path ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
    pax = {}
    if (type !== '0' && type !== '5' && type !== '\0') throw new TarError('entry-type')
    if (name === 'pax_global_header') continue
    const path = safeRelativePath(name)
    if (seen.has(path)) throw new TarError('duplicate')
    seen.add(path)
    if (type === '5') { directories.push(path); continue }
    if (files.length + skipped.length >= limits.maxFiles) throw new TarError('too-many-files')
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    const dot = base.lastIndexOf('.')
    const extension = dot > 0 ? base.slice(dot) : ''
    if (base !== '.gitkeep' && !limits.extensions.includes(extension)) { skipped.push(path); continue }
    if (size > limits.maxFileBytes) throw new TarError('file-too-large')
    total += size
    if (total > limits.maxTotalBytes) throw new TarError('too-large')
    files.push({ path, data: Buffer.from(data), mode: octal(header, 100, 8) })
  }
  return { files, directories, skipped }
}

function header(name: string, size: number, type: '0' | '5' | 'x', mode: number): Buffer {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 99), 0, 'utf8')
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii')
  block.write('0000000\0', 108, 'ascii'); block.write('0000000\0', 116, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  block.write('00000000000\0', 136, 'ascii')
  block.fill(0x20, 148, 156)
  block.write(type, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii'); block.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}
const pad = (data: Buffer) => data.length % 512 === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - (data.length % 512))])

/** Write a tar archive of regular files (pax headers carry long or non-ASCII paths).
 * @param files Files in order; paths are validated.
 * @returns Archive bytes.
 */
export function writeTar(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = []
  for (const file of files) {
    const path = safeRelativePath(file.path)
    if (Buffer.byteLength(path) > 99 || /[^\x20-\x7e]/.test(path)) {
      const line = (value: string) => { const body = ` path=${value}\n`; let length = Buffer.byteLength(body) + 1; while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body); return `${length}${body}` }
      const record = Buffer.from(line(path), 'utf8')
      parts.push(header('PaxHeader', record.length, 'x', 0o644), pad(record))
    }
    parts.push(header(path, file.data.length, '0', file.mode ?? 0o644), pad(file.data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
