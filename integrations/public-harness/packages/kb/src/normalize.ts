/** Convert accepted sources to Markdown with local tools only: Markdown and text as is, HTML stripped, PDF through poppler's
 * `pdftotext`, DOCX by reading `word/document.xml` from the zip. Nothing leaves the host. */
import { execFile } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

/** Largest extracted text kept per source (characters). */
export const MAX_SOURCE_TEXT = 200_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] === '#') { const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '' }
  return ENTITIES[name.toLowerCase()] ?? whole
})

/** HTML to plain Markdown-ish text: scripts and styles dropped, headings and list items kept as Markdown, tags removed. */
export function htmlToText(html: string): string {
  return decode(html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]*>/g, '').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Read one member of a zip archive (stored or deflated). */
export function zipEntry(zip: Buffer, wanted: string): Buffer | undefined {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && offset + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad zip directory')
    const method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extra + comment
    if (name !== wanted) continue
    if (size > 50 * 1024 * 1024) throw new Error('zip member too large')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + compressed)
    if (method === 0) return Buffer.from(data)
    if (method === 8) return inflateRawSync(data, { maxOutputLength: size + 1024 })
    throw new Error('unsupported zip compression')
  }
  return undefined
}

/** DOCX to text: one line per paragraph, `#` for heading styles. */
export function docxToText(docx: Buffer): string {
  const xml = zipEntry(docx, 'word/document.xml')?.toString('utf8')
  if (xml === undefined) throw new Error('not a docx document')
  return xml.split(/<\/w:p>/).map(paragraph => {
    const heading = /<w:pStyle w:val="(?:Heading|heading|Title)(\d?)"/.exec(paragraph)
    const text = decode([...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join('')).trim()
    if (text === '') return ''
    return heading ? `${'#'.repeat(Math.min(Number(heading[1] || 1), 6))} ${text}` : text
  }).filter(Boolean).join('\n\n')
}

/** PDF to text with `pdftotext` (poppler), reading from stdin. */
export function pdfToText(pdf: Buffer, binary = 'pdftotext'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ['-q', '-enc', 'UTF-8', '-', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      (error, stdout) => { if (error) reject(new Error('pdftotext failed')); else resolve(stdout) })
    child.stdin?.end(pdf)
  })
}

/** Normalize one source by extension.
 * @param path Source path (`raw/...`).
 * @param data File bytes.
 * @returns Markdown text, capped at MAX_SOURCE_TEXT characters.
 */
export async function normalizeSource(path: string, data: Buffer): Promise<string> {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  let text: string
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') text = data.toString('utf8')
  else if (ext === '.html' || ext === '.htm') text = htmlToText(data.toString('utf8'))
  else if (ext === '.pdf') text = await pdfToText(data)
  else if (ext === '.docx') text = docxToText(data)
  else throw new Error('unsupported source type')
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '').slice(0, MAX_SOURCE_TEXT)
}
