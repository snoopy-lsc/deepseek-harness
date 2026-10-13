/** Mail providers behind one port: a local sendmail command, an authenticated SMTP relay over TLS or STARTTLS,
 * or a file mailbox for local runs. Any delivery failure rejects with IdentityUnavailableError. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { connect as netConnect, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import type { MailConfig } from './config.ts'
import { IdentityUnavailableError, type Mail, type MailTransport } from './transports.ts'

const header = (value: string) => value.replace(/[\r\n]/g, ' ')
/** RFC 2047 encoded-word for a non-ASCII header value. */
const encodedWord = (raw: string) => { const value = header(raw); return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` }
const ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+$/

/** Render one RFC 5322 message with a base64 UTF-8 body and CRLF line endings.
 * @param from Sender address.
 * @param mail Message.
 * @param now Date for the Date header.
 * @returns Message text.
 */
export function renderMessage(from: string, mail: Mail, now = new Date()): string {
  const domain = from.split('@')[1] ?? 'localhost'
  const body = Buffer.from(mail.text, 'utf8').toString('base64').replace(/.{1,76}/g, line => `${line}\r\n`)
  return [`From: ${header(from)}`, `To: ${header(mail.to)}`, `Subject: ${encodedWord(mail.subject)}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64', '', body].join('\r\n')
}

/** Line-oriented SMTP reply reader over a socket that may be upgraded to TLS mid-session. */
class SmtpConversation {
  private buffer = ''
  private waiting: ((reply: { code: number; lines: string[] } | Error) => void) | undefined
  private lines: string[] = []
  private failure: Error | undefined
  constructor(public socket: Socket | TLSSocket) { this.attach(socket) }
  attach(socket: Socket | TLSSocket): void {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { this.buffer += chunk; this.drain() })
    socket.once('error', error => this.fail(error))
    socket.once('close', () => this.fail(new Error('connection closed')))
  }
  private fail(error: Error): void { this.failure ??= error; const w = this.waiting; this.waiting = undefined; w?.(error) }
  private drain(): void {
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1)
      if (this.buffer.length > 65_536 || line.length > 4096) { this.fail(new Error('reply too long')); return }
      this.lines.push(line)
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.map(item => item.slice(4)) }
        this.lines = []
        const w = this.waiting; this.waiting = undefined; w?.(reply)
      }
    }
  }
  /** Await the next complete reply, optionally after sending a command; reject unless the code is expected. */
  async send(command: string | undefined, expect: number[]): Promise<string[]> {
    if (this.failure !== undefined) throw this.failure
    const reply = new Promise<{ code: number; lines: string[] } | Error>(resolve => { this.waiting = resolve })
    if (command !== undefined) this.socket.write(`${command}\r\n`)
    const result = await reply
    if (result instanceof Error) throw result
    if (!expect.includes(result.code)) throw new Error(`unexpected SMTP reply ${result.code}`)
    return result.lines
  }
  /** Stop reading so the socket can be handed to TLS. */
  detach(): Socket { this.socket.removeAllListeners('data'); this.socket.removeAllListeners('error'); this.socket.removeAllListeners('close'); return this.socket }
}

/** Options for the SMTP transport beyond the configuration (tests inject a CA and a clock). */
export interface SmtpOptions { readonly tls?: Pick<ConnectionOptions, 'ca'>; readonly clock?: () => Date }

/** Deliver one message through an SMTP relay. TLS is mandatory: implicit TLS (`tls`, e.g. port 465) or a STARTTLS upgrade
 * (`starttls`, e.g. port 25/80/587) that must be offered, after which credentials are sent with AUTH PLAIN or LOGIN.
 * Certificates are always verified against the configured host name.
 * @param config SMTP settings.
 * @param mail Message.
 * @param options Test hooks.
 */
export async function sendSmtp(config: Extract<MailConfig, { kind: 'smtp' }>, mail: Mail, options: SmtpOptions = {}): Promise<void> {
  if (!ADDRESS.test(mail.to)) throw new IdentityUnavailableError('mail')
  const secure = (socket?: Socket) => new Promise<TLSSocket>((resolve, reject) => {
    const tls = tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...options.tls, ...socket ? { socket } : {} })
    tls.once('secureConnect', () => { tls.removeListener('error', reject); resolve(tls) }); tls.once('error', reject)
  })
  let socket: Socket | undefined
  const timer = setTimeout(() => socket?.destroy(new Error('SMTP timeout')), config.timeoutMs)
  try {
    socket = config.security === 'tls' ? await secure() : await new Promise<Socket>((resolve, reject) => {
      const plain = netConnect({ host: config.host, port: config.port }, () => { plain.removeListener('error', reject); resolve(plain) }); plain.once('error', reject)
    })
    const smtp = new SmtpConversation(socket)
    const name = config.from.split('@')[1]!
    await smtp.send(undefined, [220])
    let features = await smtp.send(`EHLO ${name}`, [250])
    if (config.security === 'starttls') {
      // No fallback to plaintext: a relay that does not offer STARTTLS never sees the credentials.
      if (!features.some(line => /^STARTTLS\b/i.test(line))) throw new Error('STARTTLS not offered')
      await smtp.send('STARTTLS', [220])
      socket = await secure(smtp.detach())
      smtp.attach(socket)
      features = await smtp.send(`EHLO ${name}`, [250])
    }
    const auth = features.find(line => /^AUTH[ =]/i.test(line))?.slice(5).toUpperCase().split(/\s+/) ?? []
    if (auth.includes('PLAIN')) await smtp.send(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64')}`, [235])
    else if (auth.includes('LOGIN')) {
      await smtp.send('AUTH LOGIN', [334])
      await smtp.send(Buffer.from(config.user, 'utf8').toString('base64'), [334])
      await smtp.send(Buffer.from(config.password, 'utf8').toString('base64'), [235])
    } else throw new Error('no supported AUTH mechanism')
    await smtp.send(`MAIL FROM:<${config.from}>`, [250])
    await smtp.send(`RCPT TO:<${mail.to}>`, [250, 251])
    await smtp.send('DATA', [354])
    const message = renderMessage(config.from, mail, options.clock?.() ?? new Date()).replace(/^\./gm, '..')
    await smtp.send(`${message}${message.endsWith('\r\n') ? '' : '\r\n'}.`, [250])
    await smtp.send('QUIT', [221]).catch(() => undefined)
  } catch { throw new IdentityUnavailableError('mail') } finally {
    clearTimeout(timer)
    socket?.destroy()
  }
}

/** Build the configured mail transport.
 * @param config Mail settings.
 * @param options SMTP test hooks.
 * @returns Delivery function.
 */
export function createMailTransport(config: MailConfig, options: SmtpOptions = {}): MailTransport {
  if (config.kind === 'mailbox') {
    return async mail => {
      await writeFile(join(config.dir, `${Date.now()}-${randomBytes(4).toString('hex')}.json`), JSON.stringify({ from: config.from, ...mail }), { mode: 0o600, flag: 'wx' })
    }
  }
  if (config.kind === 'smtp') return mail => sendSmtp(config, mail, options)
  return mail => new Promise((resolve, reject) => {
    const child = spawn(config.command, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.once('error', () => reject(new IdentityUnavailableError('mail')))
    child.once('close', code => code === 0 ? resolve() : reject(new IdentityUnavailableError('mail')))
    child.stdin.end(`From: ${header(config.from)}\nTo: ${header(mail.to)}\nSubject: ${encodedWord(mail.subject)}\nContent-Type: text/plain; charset=utf-8\n\n${mail.text}\n`)
  })
}
