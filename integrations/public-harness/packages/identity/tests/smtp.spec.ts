/** SMTP provider against a local mock relay (127.0.0.1 only) with a throwaway self-signed certificate. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, TLSSocket, createServer as createTlsServer } from 'node:tls'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { MailConfig } from '../src/config.ts'
import { createMailTransport, renderMessage, sendSmtp } from '../src/mail.ts'
import { IdentityUnavailableError } from '../src/transports.ts'

let key = '', cert = ''
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-smtp-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  key = readFileSync(join(dir, 'key.pem'), 'utf8'); cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
})
const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())) })

interface Relay { port: number; log: string[]; data: string[] }
type Behaviour = { implicit?: boolean; offerStartTls?: boolean; auth?: 'PLAIN' | 'LOGIN'; rejectAuth?: boolean; silent?: boolean }
/** Minimal relay: greets, answers EHLO, optional STARTTLS, AUTH, MAIL/RCPT/DATA. Credentials expected: user/pass. */
async function relay(behaviour: Behaviour): Promise<Relay> {
  const log: string[] = [], data: string[] = []
  const context = createSecureContext({ key, cert })
  const session = (socket: Socket | TLSSocket, secure: boolean) => {
    if (behaviour.silent) return
    let buffer = '', inData = false, body = '', loginStep = 0
    const reply = (line: string) => socket.write(`${line}\r\n`)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        if (inData) { if (line === '.') { inData = false; data.push(body); reply('250 queued') } else body += `${line}\r\n`; continue }
        log.push(`${secure ? 'tls' : 'plain'}:${line}`)
        if (loginStep === 1) { loginStep = 2; reply('334 UGFzc3dvcmQ6'); continue }
        if (loginStep === 2) { loginStep = 0; reply(Buffer.from(line, 'base64').toString() === 'pass' ? '235 ok' : '535 no'); continue }
        const verb = line.split(' ')[0]!.toUpperCase()
        if (verb === 'EHLO') {
          const features = [...!secure && behaviour.offerStartTls ? ['STARTTLS'] : [], ...secure ? [`AUTH ${behaviour.auth ?? 'PLAIN'}`] : []]
          reply(features.length ? '250-relay.local' : '250 relay.local'); features.forEach((f, i) => reply(`250${i === features.length - 1 ? ' ' : '-'}${f}`))
        } else if (verb === 'STARTTLS') {
          reply('220 go ahead'); socket.removeListener('data', onData)
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context })
          upgraded.once('secure', () => session(upgraded, true))
        } else if (verb === 'AUTH') {
          if (behaviour.rejectAuth) reply('535 authentication failed')
          else if (line.startsWith('AUTH PLAIN ')) reply(Buffer.from(line.slice(11), 'base64').toString() === '\0user\0pass' ? '235 ok' : '535 no')
          else if (line === 'AUTH LOGIN') { loginStep = 1; reply('334 VXNlcm5hbWU6') } else reply('504 unsupported')
        } else if (verb === 'MAIL' || verb === 'RCPT') reply('250 ok')
        else if (verb === 'DATA') { inData = true; body = ''; reply('354 end with .') }
        else if (verb === 'QUIT') { reply('221 bye'); socket.end() } else reply('500 ?')
      }
    }
    socket.on('data', onData)
    if (!secure || behaviour.implicit) reply('220 relay.local ESMTP')
  }
  const server = behaviour.implicit
    ? createTlsServer({ key, cert }, socket => session(socket, true))
    : createServer(socket => session(socket, false))
  server.on('connection', (socket: Socket) => socket.on('error', () => undefined))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { port: (server.address() as { port: number }).port, log, data }
}
const config = (port: number, security: 'tls' | 'starttls', timeoutMs = 3000): Extract<MailConfig, { kind: 'smtp' }> =>
  ({ kind: 'smtp', host: 'localhost', port, security, user: 'user', password: 'pass', from: 'noreply@example.test', timeoutMs })
const mail = { to: 'alice@example.test', subject: '验证你的 DeepSeek Harness 账户', text: 'Open this link:\nhttps://harness.example/verify?token=x\n.\nend' }

describe('smtp provider', () => {
  it('delivers_over_implicit_tls_with_auth_plain', async () => {
    const r = await relay({ implicit: true })
    await sendSmtp(config(r.port, 'tls'), mail, { tls: { ca: cert } })
    expect(r.log.map(line => line.replace(/^(tls:AUTH PLAIN) .*/, '$1'))).toEqual(['tls:EHLO example.test', 'tls:AUTH PLAIN', 'tls:MAIL FROM:<noreply@example.test>',
      'tls:RCPT TO:<alice@example.test>', 'tls:DATA', 'tls:QUIT'])
    const message = r.data[0]!
    expect(message).toContain('Subject: =?UTF-8?B?')
    expect(message).toContain('Content-Transfer-Encoding: base64')
    const body = Buffer.from(message.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8')
    expect(body).toBe(mail.text)
  })

  it('upgrades_with_starttls_before_auth_login', async () => {
    const r = await relay({ offerStartTls: true, auth: 'LOGIN' })
    await createMailTransport(config(r.port, 'starttls'), { tls: { ca: cert } })(mail)
    expect(r.log.slice(0, 3)).toEqual(['plain:EHLO example.test', 'plain:STARTTLS', 'tls:EHLO example.test'])
    // Credentials never cross the plaintext phase.
    expect(r.log.filter(line => line.startsWith('plain:')).some(line => /AUTH|dXNlcg|cGFzcw/.test(line))).toBe(false)
    expect(r.data).toHaveLength(1)
  })

  it('fails_closed', async () => {
    // A relay that does not offer STARTTLS never receives credentials.
    const plain = await relay({ offerStartTls: false })
    await expect(sendSmtp(config(plain.port, 'starttls'), mail, { tls: { ca: cert } })).rejects.toBeInstanceOf(IdentityUnavailableError)
    expect(plain.log).toEqual(['plain:EHLO example.test'])
    // An untrusted certificate is refused.
    const tls = await relay({ implicit: true })
    await expect(sendSmtp(config(tls.port, 'tls'), mail)).rejects.toBeInstanceOf(IdentityUnavailableError)
    expect(tls.log).toEqual([])
    // Rejected credentials and malformed recipients are unavailable, not success.
    const denied = await relay({ implicit: true, rejectAuth: true })
    await expect(sendSmtp(config(denied.port, 'tls'), mail, { tls: { ca: cert } })).rejects.toBeInstanceOf(IdentityUnavailableError)
    expect(denied.data).toHaveLength(0)
    await expect(sendSmtp(config(tls.port, 'tls'), { ...mail, to: 'a@b>\r\nRCPT TO:<x@y' }, { tls: { ca: cert } })).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('times_out', async () => {
    const silent = await relay({ silent: true })
    const started = Date.now()
    await expect(sendSmtp(config(silent.port, 'starttls', 600), mail)).rejects.toBeInstanceOf(IdentityUnavailableError)
    expect(Date.now() - started).toBeLessThan(2500)
    await expect(sendSmtp(config(1, 'tls', 600), mail)).rejects.toBeInstanceOf(IdentityUnavailableError)
  })

  it('renders_headers_without_injection', () => {
    const text = renderMessage('noreply@example.test', { to: 'a@example.test', subject: 'Hi\r\nBcc: x@evil.example', text: 'x' }, new Date(0))
    expect(text).toContain('Subject: Hi  Bcc: x@evil.example\r\n')
    expect(text).not.toMatch(/^Bcc:/m)
    expect(text).toContain('Date: Thu, 01 Jan 1970 00:00:00 GMT')
  })
})
