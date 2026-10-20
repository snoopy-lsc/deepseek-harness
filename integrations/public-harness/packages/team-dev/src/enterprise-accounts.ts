/** Persistent local credentials and account initialization through the identity HTTP API. */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { parseUserId, type UserId } from '@public-harness/contracts'
import type { Mail } from '@public-harness/identity/transports'
import { AccountSchema, type LocalAccount } from './enterprise-config.ts'

/** A generated development password, kept in an owner-only local file. */
export interface LocalCredential extends LocalAccount { readonly password: string }
/** Read a private regular file or exclusively create it, without replacing existing data.
 * @param path Private file.
 * @param initial Contents for its first creation.
 * @returns Existing or newly created contents.
 */
export async function privateFile(path: string, initial: () => string): Promise<string> {
  try { await writeFile(path, initial(), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('enterprise development requires owner-only regular credential files')
  return readFile(path, 'utf8')
}
/** Load passwords without resetting them on a later start.
 * @param root Private state directory.
 * @param accounts Configured initial accounts.
 * @returns Matching credentials; edited account settings require a separate data directory.
 */
export async function localCredentials(root: string, accounts: readonly LocalAccount[]): Promise<LocalCredential[]> {
  const raw: unknown = JSON.parse(await privateFile(join(root, 'accounts.json'), () => JSON.stringify(accounts.map(account => ({
    ...account, password: randomBytes(24).toString('base64url'),
  })), null, 2) + '\n'))
  const saved: LocalCredential[] = z.resolve(raw, z.array(AccountSchema), {})[0]
  if (saved.length !== accounts.length || saved.some((account, i) => ['name', 'email', 'role'].some(key =>
    account[key as keyof LocalAccount] !== accounts[i]![key as keyof LocalAccount]))) throw new Error('initial accounts differ from the saved local credentials; use a different enterprise home')
  return saved
}

/** One bounded request to the private identity listener.
 * @param socket Private identity socket.
 * @param origin Public origin, required by identity's Origin and Host checks.
 * @param path Identity API path.
 * @param body JSON for POST; omitted for GET.
 * @param timeoutMs Socket inactivity limit.
 * @returns Status, headers and response text.
 */
export function identityRequest(socket: string, origin: string, path: string, body: object | undefined, timeoutMs: number): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath: socket, method: payload === undefined ? 'GET' : 'POST', path,
      headers: { host: new URL(origin).host, origin, 'x-forwarded-for': '127.0.0.1', 'x-captcha-response': 'enterprise-local',
        ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('local identity response exceeds its limit')) })
      res.once('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, text }))
      res.once('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('local account initialization timed out')))
    req.once('error', reject)
    req.end(payload)
  })
}

/** Initialize verified accounts without database writes or an authentication bypass.
 * @param options Credentials, private API and delivered local verification messages.
 * @returns The service-generated identity IDs.
 */
export async function initializeAccounts(options: { accounts: readonly LocalCredential[]; socket: string; origin: string; databaseFile: string; timeoutMs: number; latestMail: ReadonlyMap<string, Mail> }): Promise<UserId[]> {
  const ids: UserId[] = []
  const call = (path: string, body?: object) => identityRequest(options.socket, options.origin, path, body, options.timeoutMs)
  const database = new DatabaseSync(options.databaseFile, { readOnly: true })
  const find = database.prepare('SELECT id, emailVerified FROM user WHERE email = ?')
  try {
    for (const account of options.accounts) {
      let user = find.get(account.email) as { id: string; emailVerified: number } | undefined
      if (user === undefined) {
        const signup = await call('/api/auth/sign-up/email', { name: account.name, email: account.email, password: account.password, callbackURL: '/account/verified' })
        if (signup.status !== 200) throw new Error(`local registration failed (${signup.status})`)
        user = find.get(account.email) as { id: string; emailVerified: number } | undefined
      }
      if (user === undefined) throw new Error('local registration did not create an identity')
      if (!user.emailVerified) {
        if (!options.latestMail.has(account.email)) await call('/api/auth/send-verification-email', { email: account.email, callbackURL: '/account/verified' })
        const link = options.latestMail.get(account.email)?.text.match(/https?:\/\/\S+/)?.[0]
        if (link === undefined) throw new Error('local account verification mail was not delivered')
        const url = new URL(link)
        if (url.origin !== options.origin || url.pathname !== '/api/auth/verify-email') throw new Error('invalid local verification link')
        await call(url.pathname + url.search)
        user = find.get(account.email) as { id: string; emailVerified: number } | undefined
        if (!user?.emailVerified) throw new Error('local account verification failed')
      }
      ids.push(parseUserId(user.id))
    }
    return ids
  } finally { database.close() }
}
