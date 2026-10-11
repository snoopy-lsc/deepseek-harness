/** Strict, secret-free production configuration files: root-owned JSON read once at startup. */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Read a JSON file that only its owner may write, refusing links and oversized input. */
export async function readConfigFile(path: string): Promise<unknown> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('configuration file path must be absolute')
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 65_536
    || (process.platform !== 'win32' && (entry.mode & 0o022) !== 0)) {
    throw new Error('configuration file must be a regular file that is not group- or world-writable')
  }
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('configuration file is not valid JSON') }
}

/** Require exactly the named keys on a plain object. */
export function exactRecord(value: unknown, keys: readonly string[], context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort().join(',')
  if (actual !== [...keys].sort().join(',')) throw new Error(`${context} must contain exactly: ${[...keys].sort().join(', ')}`)
  return record
}

/** A positive safe integer. */
export function positiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

/** An absolute path string. */
export function absolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path`)
  return value
}
