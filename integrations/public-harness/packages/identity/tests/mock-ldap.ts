/** A local LDAP directory for tests: 127.0.0.1 only, a minimal BER server for bind, search, StartTLS and unbind, with a CA and server
 * certificate generated per run by openssl into a temporary directory and never committed. Not a general LDAP server. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, TLSSocket } from 'node:tls'

export const MOCK_LDAP_BASE = 'dc=corp,dc=example'
export const MOCK_LDAP_BIND_DN = 'cn=svc-harness,ou=service,dc=corp,dc=example'
/** Test-only value; only the mock knows it. */
export const MOCK_LDAP_BIND_PASSWORD = 'mock-ldap-service-test-only'
/** Test-only user password. */
export const MOCK_USER_PASSWORD = 'mock-user-test-only-pw'
const IN_CHAIN = '1.2.840.113556.1.4.1941'
const START_TLS = '1.3.6.1.4.1.1466.20037'

export interface TestPki { dir: string; caFile: string; ca: string; key: string; cert: string; cleanup(): void }
/** A throwaway CA and a 127.0.0.1 server certificate it signed. */
export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ldap-test-')), at = (name: string) => join(dir, name)
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=mock-ldap-ca.test', '-keyout', at('ca.key'), '-out', at('ca.crt')])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', at('server.key'), '-out', at('server.csr')])
  writeFileSync(at('ext'), 'subjectAltName=IP:127.0.0.1\n')
  run(['x509', '-req', '-in', at('server.csr'), '-CA', at('ca.crt'), '-CAkey', at('ca.key'), '-CAcreateserial', '-days', '2', '-extfile', at('ext'), '-out', at('server.crt')])
  return { dir, caFile: at('ca.crt'), ca: readFileSync(at('ca.crt'), 'utf8'), key: readFileSync(at('server.key'), 'utf8'), cert: readFileSync(at('server.crt'), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---- BER ----
const length = (n: number) => { if (n < 128) return Buffer.from([n]); const out: number[] = []; while (n) { out.unshift(n & 255); n >>= 8 } return Buffer.from([0x80 | out.length, ...out]) }
const tlv = (tag: number, ...parts: Buffer[]) => { const value = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(value.length), value]) }
const integer = (tag: number, n: number) => { const out: number[] = []; do { out.unshift(n & 255); n >>= 8 } while (n); if (out[0]! & 0x80) out.unshift(0); return tlv(tag, Buffer.from(out)) }
const octets = (value: string | Buffer, tag = 0x04) => tlv(tag, Buffer.from(value))
interface Node { tag: number; value: Buffer; children(): Node[] }
function read(buf: Buffer, at = 0): { node: Node; next: number } | undefined {
  if (buf.length < at + 2) return undefined
  let len = buf[at + 1]!, start = at + 2
  if (len & 0x80) { const n = len & 0x7f; if (buf.length < start + n) return undefined; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!; start += n }
  if (buf.length < start + len) return undefined
  const value = buf.subarray(start, start + len)
  const node: Node = { tag: buf[at]!, value, children() { const out: Node[] = []; let i = 0; while (i < value.length) { const r = read(value, i)!; out.push(r.node); i = r.next } return out } }
  return { node, next: start + len }
}
const num = (node: Node) => { let n = 0; for (const b of node.value) n = n * 256 + b; return n }
const text = (node: Node) => node.value.toString('utf8')

export type Value = string | Buffer
export interface MockLdap {
  url: string
  pki: TestPki
  /** Entries by DN; attribute names are matched case-insensitively. `userPassword` is the bind password. */
  entries: Map<string, Record<string, Value[]>>
  /** Equality and extensible assertions received, as [attribute, value]; substring filters are recorded as ['*substrings*', attribute]. */
  assertions: Array<[string, string]>
  binds: string[]
  delayMs: number
  connections: number
  close(): Promise<void>
}

/** Start the directory.
 * @param mode `ldaps`, `starttls` (plain listener that upgrades) or `plain`.
 */
export async function startMockLdap(mode: 'ldaps' | 'starttls' | 'plain' = 'ldaps'): Promise<MockLdap> {
  const pki = makeTestPki()
  const guid = (hex: string) => Buffer.from(hex, 'hex')
  const user = (cn: string, extra: Record<string, Value[]>): [string, Record<string, Value[]>] => [`cn=${cn},ou=people,${MOCK_LDAP_BASE}`, { objectClass: ['top', 'person', 'user', 'inetOrgPerson'], cn: [cn], userPassword: [MOCK_USER_PASSWORD], userAccountControl: ['512'], ...extra }]
  const mock: MockLdap = {
    url: '', pki, assertions: [], binds: [], delayMs: 0, connections: 0,
    entries: new Map([
      [MOCK_LDAP_BIND_DN, { objectClass: ['top', 'person'], userPassword: [MOCK_LDAP_BIND_PASSWORD] }],
      user('Alice Zhang', { sAMAccountName: ['alice'], uid: ['alice'], mail: ['Alice@Corp.Example'], displayName: ['Alice Zhang'],
        objectGUID: [guid('33221100554477668899aabbccddeeff')], entryUUID: ['6F1B2C3D-0000-4000-8000-00000000A11C'],
        memberOf: [`CN=Engineering,OU=Groups,${MOCK_LDAP_BASE.toUpperCase()}`] }),
      user('Bob Li', { sAMAccountName: ['bob'], uid: ['bob'], displayName: ['Bob Li'], objectGUID: [guid('00112233445566778899aabbccddeeff')], entryUUID: ['b0b'],
        memberOf: [`cn=Platform,ou=groups,${MOCK_LDAP_BASE}`] }),
      user('Carol Wu', { sAMAccountName: ['carol'], uid: ['carol'], objectGUID: [guid('ffeeddccbbaa99887766554433221100')], userAccountControl: ['514'],
        memberOf: [`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`] }),
      [`cn=Engineering,ou=groups,${MOCK_LDAP_BASE}`, { objectClass: ['group', 'groupOfNames'], member: [`cn=Alice Zhang,ou=people,${MOCK_LDAP_BASE}`, `cn=Carol Wu,ou=people,${MOCK_LDAP_BASE}`, `cn=Platform,ou=groups,${MOCK_LDAP_BASE}`] }],
      // Nested: Platform is a member of Engineering, so Bob is in Engineering only through the chain.
      [`cn=Platform,ou=groups,${MOCK_LDAP_BASE}`, { objectClass: ['group', 'groupOfNames'], member: [`cn=Bob Li,ou=people,${MOCK_LDAP_BASE}`] }],
    ]),
    close: () => new Promise(resolve => { server.close(() => { pki.cleanup(); resolve() }); for (const socket of sockets) socket.destroy() }),
  }
  const sockets = new Set<Socket>()
  const lower = (s: string) => s.toLowerCase().replace(/\s*,\s*/g, ',')
  const find = (dn: string) => [...mock.entries].find(([key]) => lower(key) === lower(dn))
  const values = (entry: Record<string, Value[]>, name: string) => Object.entries(entry).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const chain = (group: string, member: string, seen = new Set<string>()): boolean => {
    if (seen.has(lower(group))) return false
    seen.add(lower(group))
    const members = (values(find(group)?.[1] ?? {}, 'member') ?? []).map(String)
    return members.some(m => lower(m) === lower(member) || chain(m, member, seen))
  }
  const matches = (filter: Node, dn: string, entry: Record<string, Value[]>): boolean => {
    const kids = () => filter.children()
    switch (filter.tag) {
      case 0xa0: return kids().every(child => matches(child, dn, entry))
      case 0xa1: return kids().some(child => matches(child, dn, entry))
      case 0xa2: return !matches(kids()[0]!, dn, entry)
      case 0xa3: {
        const [attr, value] = kids().map(text)
        mock.assertions.push([attr!, value!])
        // Binary attributes (objectGUID) compare as bytes, text ones case-insensitively.
        const raw = kids()[1]!.value
        return (values(entry, attr!) ?? []).some(v => Buffer.isBuffer(v) ? v.equals(raw) : lower(String(v)) === lower(value!))
      }
      case 0x87: return values(entry, filter.value.toString()) !== undefined
      case 0xa4: {
        // Unescaped user input would arrive here; matching everything shows why escaping matters.
        const attr = text(kids()[0]!)
        mock.assertions.push(['*substrings*', attr])
        return values(entry, attr) !== undefined
      }
      case 0xa9: {
        const parts = Object.fromEntries(kids().map(child => [child.tag, text(child)]))
        mock.assertions.push([`${parts[0x82]}:${parts[0x81]}`, parts[0x83]!])
        if (parts[0x81] === IN_CHAIN && parts[0x82]?.toLowerCase() === 'member') return chain(dn, parts[0x83]!)
        return false
      }
      default: return false
    }
  }
  const result = (tag: number, id: number, code: number, extra: Buffer[] = []) => tlv(0x30, integer(0x02, id), tlv(tag, integer(0x0a, code), octets(''), octets(''), ...extra))

  const serve = (socket: Socket) => {
    mock.connections++
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy())
    let buffer = Buffer.alloc(0), bound = ''
    let current: Socket = socket
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const r = read(buffer)
        if (r === undefined) return
        buffer = buffer.subarray(r.next)
        const message = r.node
        void (async () => {
          if (mock.delayMs) await new Promise(resolve => setTimeout(resolve, mock.delayMs))
          const [idNode, op] = message.children()
          const id = num(idNode!)
          if (op!.tag === 0x42) { current.end(); return }
          if (op!.tag === 0x60) {
            const [, name, auth] = op!.children()
            const dn = text(name!), password = auth!.value.toString('utf8')
            mock.binds.push(dn)
            // As real servers do, an empty password is an unauthenticated bind and "succeeds"; the provider must never send one.
            const entry = find(dn)
            const ok = dn === '' || password === '' || (entry !== undefined && (values(entry[1], 'userPassword') ?? []).map(String).includes(password))
            if (ok) bound = dn
            current.write(result(0x61, id, ok ? 0 : 49)); return
          }
          if (op!.tag === 0x77) {
            const oid = text(op!.children()[0]!)
            if (oid !== START_TLS || mode !== 'starttls' || current instanceof TLSSocket) { current.write(result(0x78, id, 2)); return }
            // Stop reading plaintext before the reply goes out, so the client's handshake reaches only the TLS layer.
            current.removeListener('data', onData)
            current.pause()
            const raw = current
            const secure = new TLSSocket(raw, { isServer: true, key: pki.key, cert: pki.cert })
            raw.write(result(0x78, id, 0))
            secure.on('data', onData); secure.on('error', () => secure.destroy())
            current = secure
            return
          }
          if (op!.tag === 0x63) {
            const [base, , , sizeLimit, , , filter, attrs] = op!.children()
            if (!find(bound) || bound === '') { current.write(result(0x65, id, 50)); return }
            const wanted = attrs!.children().map(text).map(a => a.toLowerCase())
            const hits = [...mock.entries].filter(([dn, entry]) => lower(dn).endsWith(lower(text(base!))) && matches(filter!, dn, entry))
            const limit = num(sizeLimit!)
            for (const [dn, entry] of limit ? hits.slice(0, limit) : hits) {
              const out = Object.entries(entry).filter(([key]) => key !== 'userPassword' && (wanted.length === 0 || wanted.includes(key.toLowerCase())))
                .map(([key, vals]) => tlv(0x30, octets(key), tlv(0x31, ...vals.map(v => octets(v)))))
              current.write(tlv(0x30, integer(0x02, id), tlv(0x64, octets(dn), tlv(0x30, ...out))))
            }
            current.write(result(0x65, id, limit && hits.length > limit ? 4 : 0)); return
          }
          current.write(result(0x65, id, 53))
        })().catch(() => current.destroy())
      }
    }
    socket.on('data', onData)
  }
  const server: Server = mode === 'ldaps' ? createTlsServer({ key: pki.key, cert: pki.cert }, serve) : createNetServer(serve)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  mock.url = `${mode === 'ldaps' ? 'ldaps' : 'ldap'}://127.0.0.1:${(server.address() as AddressInfo).port}`
  return mock
}
