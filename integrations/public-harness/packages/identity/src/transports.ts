/** Mail and CAPTCHA transports; failures surface as unavailable, never as success. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptchaConfig, MailConfig } from './config.ts'

/** One outgoing message. */
export interface Mail { readonly to: string; readonly subject: string; readonly text: string }
/** Delivery port; rejects when the message was not accepted. */
export type MailTransport = (mail: Mail) => Promise<void>
/** CAPTCHA port: true for a valid response, false for an invalid one; rejects when the provider is unreachable. */
export type CaptchaVerifier = (response: string, ip: string) => Promise<boolean>

/** A dependency the request needs is down; the service answers 503 and admits nothing. */
export class IdentityUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError'
  constructor(readonly what: 'mail' | 'captcha' | 'store') { super(`identity ${what} unavailable`) }
}

const header = (value: string) => value.replace(/[\r\n]/g, ' ')

/** Build the configured mail transport.
 * @param config Mail settings.
 * @returns Delivery function.
 */
export function createMailTransport(config: MailConfig): MailTransport {
  if (config.kind === 'mailbox') {
    return async mail => {
      await writeFile(join(config.dir, `${Date.now()}-${randomBytes(4).toString('hex')}.json`), JSON.stringify({ from: config.from, ...mail }), { mode: 0o600, flag: 'wx' })
    }
  }
  return mail => new Promise((resolve, reject) => {
    const child = spawn(config.command, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.once('error', () => reject(new IdentityUnavailableError('mail')))
    child.once('close', code => code === 0 ? resolve() : reject(new IdentityUnavailableError('mail')))
    child.stdin.end(`From: ${header(config.from)}\nTo: ${header(mail.to)}\nSubject: ${header(mail.subject)}\nContent-Type: text/plain; charset=utf-8\n\n${mail.text}\n`)
  })
}

/** Build the configured CAPTCHA verifier.
 * @param config CAPTCHA settings.
 * @param fetchImpl Injected fetch for tests.
 * @returns Verifier.
 */
export async function createCaptchaVerifier(config: CaptchaConfig, fetchImpl: typeof fetch = fetch): Promise<CaptchaVerifier> {
  if (config.kind === 'test') return async response => response === config.acceptToken
  const secret = (await readFile(config.secretFile, 'utf8')).trim()
  if (!secret) throw new Error('CAPTCHA secret file is empty')
  return async (response, ip) => {
    if (!response || response.length > 2048) return false
    let result: Response
    try {
      result = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret, response, remoteip: ip }), signal: AbortSignal.timeout(5000) })
    } catch { throw new IdentityUnavailableError('captcha') }
    if (!result.ok) throw new IdentityUnavailableError('captcha')
    const body = await result.json().catch(() => undefined) as { success?: unknown } | undefined
    return body?.success === true
  }
}
