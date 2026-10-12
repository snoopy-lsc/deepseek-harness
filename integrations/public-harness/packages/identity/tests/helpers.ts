import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseIdentityConfig, type IdentityConfig } from '../src/config.ts'
import type { Mail } from '../src/transports.ts'

export const ORIGIN = 'http://127.0.0.1:18443'
export async function setup(overrides: Partial<Record<string, unknown>> = {}): Promise<{ dir: string; config: IdentityConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
  await writeFile(join(dir, 'secret'), 'x'.repeat(48), { mode: 0o600 })
  const config = parseIdentityConfig({
    mode: 'local', publicOrigin: ORIGIN, publicSocket: join(dir, 'public.sock'), sessionSocket: join(dir, 'session.sock'), sessionSocketGid: process.getgid!(),
    databaseFile: join(dir, 'identity.db'), secretFile: join(dir, 'secret'), mail: { kind: 'mailbox', dir, from: 'noreply@example.test' },
    captcha: { kind: 'test', acceptToken: 'pass-captcha' },
    limits: { signupPerIpPerHour: 20, signupPerDay: 50, resetPerEmailPerHour: 5, loginPerIpPerMinute: 30 },
    sessionTtlSeconds: 3600, verificationTtlSeconds: 600, clientIpHeader: 'x-forwarded-for', enrollmentOpen: true, ...overrides })
  return { dir, config }
}
export interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
export function call(socketPath: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath, method, path, headers: { host: '127.0.0.1:18443', ...method === 'GET' ? {} : { origin: ORIGIN },
      ...payload === undefined ? {} : { 'content-type': 'application/json' }, ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.once('error', reject); req.end(payload)
  })
}
export const mailbox = () => { const sent: Mail[] = []; return { sent, mail: async (mail: Mail) => { sent.push(mail) } } }
export const linkIn = (mail: Mail) => new URL(/https?:\/\/\S+/.exec(mail.text)![0])
export const sessionCookie = (reply: Reply) => {
  const cookies = ([] as string[]).concat(reply.headers['set-cookie'] ?? [])
  return cookies.map(cookie => cookie.split(';')[0]!).find(cookie => cookie.startsWith('dsh-account.session_token='))
}
