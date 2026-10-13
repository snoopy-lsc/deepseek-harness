/** The Better Auth signing secret, read from a private root-owned file; never logged. */
import { readFile, stat } from 'node:fs/promises'

/** Read the signing secret from a private file; it is never logged.
 * @param file Secret file path.
 * @returns Secret text.
 */
export async function readSecret(file: string): Promise<string> {
  const info = await stat(file)
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('identity secret file must be private')
  const secret = (await readFile(file, 'utf8')).trim()
  if (secret.length < 32) throw new Error('identity secret is too short')
  return secret
}
