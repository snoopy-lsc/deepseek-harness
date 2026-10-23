/** Peer UID lookup for market TCP accepts: inet_diag first, /proc/net/tcp fallback. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'

/** IPv4 four-tuple identifying the *peer* (client) socket. */
export interface Ipv4FourTuple {
  /** Peer source port (client port / remotePort on the accepted socket). */
  readonly sport: number
  /** Peer destination port (server port / localPort on the accepted socket). */
  readonly dport: number
  /** Peer source address. */
  readonly src: string
  /** Peer destination address. */
  readonly dst: string
}

export interface SockDiagTransport {
  /** Send one netlink request; return the raw response bytes (may be empty). */
  query(request: Buffer): Buffer
}

export type PeerLookupOk = { readonly ok: true; readonly uid: number; readonly method: 'inet_diag' | 'proc_net_tcp' }
export type PeerLookupFail = { readonly ok: false; readonly reason: 'lookup-failed' }
export type PeerLookupResult = PeerLookupOk | PeerLookupFail

export type PeerCheckDecision =
  | { readonly allow: true; readonly uid: number }
  | { readonly allow: false; readonly reason: 'foreign-uid' | 'unmapped-port' | 'lookup-failed' }

export interface LookupPeerUidOptions {
  /** When null/undefined, skip inet_diag and use /proc only. */
  readonly transport?: SockDiagTransport | null
  /** Injectable /proc/net/tcp text (tests); default reads the live file. */
  readonly procTable?: string | (() => string)
}

export interface PeerCheckHooks {
  readonly ownerUidForPort: (localPort: number) => number | undefined
  /** Override lookup (tests). Default: {@link lookupPeerUidFromSocket}. */
  readonly lookupPeerUid?: (socket: Socket) => PeerLookupResult
}

const AF_INET = 2
const IPPROTO_TCP = 6
const SOCK_DIAG_BY_FAMILY = 20
const NLM_F_REQUEST = 1
const NLMSG_ERROR = 2
const NLMSG_DONE = 3
const TCPF_ALL = 0xfff
const INET_DIAG_NOCOOKIE = 0xffffffff
/** Offset of idiag_uid inside inet_diag_msg payload. */
const INET_DIAG_UID_OFFSET = 4 + 48 + 12

function ipv4ToBe32(addr: string): number {
  const parts = addr.split('.')
  if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${addr}`)
  let value = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid IPv4 address: ${addr}`)
    value = (value << 8) | n
  }
  return value >>> 0
}

/** Swap accepted-socket names into the peer (client) four-tuple for inet_diag /proc lookup. */
export function fourTupleFromAccepted(
  socket: Pick<Socket, 'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>,
): Ipv4FourTuple {
  const localAddress = socket.localAddress
  const remoteAddress = socket.remoteAddress
  const localPort = socket.localPort
  const remotePort = socket.remotePort
  if (
    typeof localAddress !== 'string' ||
    typeof remoteAddress !== 'string' ||
    typeof localPort !== 'number' ||
    typeof remotePort !== 'number'
  ) {
    throw new Error('accepted socket is missing address tuple')
  }
  const src = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress
  const dst = localAddress.startsWith('::ffff:') ? localAddress.slice(7) : localAddress
  return { sport: remotePort, dport: localPort, src, dst }
}

/**
 * Build an exact four-tuple `inet_diag_req_v2` netlink request (SOCK_DIAG_BY_FAMILY).
 * Ports and addresses are network byte order inside `inet_diag_sockid`.
 */
export function buildInetDiagRequestV2(
  tuple: Ipv4FourTuple,
  options: { readonly states?: number; readonly seq?: number } = {},
): Buffer {
  const states = options.states ?? TCPF_ALL
  const seq = options.seq ?? 1
  const reqV2 = Buffer.alloc(56)
  reqV2.writeUInt8(AF_INET, 0)
  reqV2.writeUInt8(IPPROTO_TCP, 1)
  reqV2.writeUInt8(0, 2)
  reqV2.writeUInt8(0, 3)
  reqV2.writeUInt32LE(states, 4)
  reqV2.writeUInt16BE(tuple.sport, 8)
  reqV2.writeUInt16BE(tuple.dport, 10)
  reqV2.writeUInt32BE(ipv4ToBe32(tuple.src), 12)
  reqV2.writeUInt32BE(ipv4ToBe32(tuple.dst), 28)
  reqV2.writeUInt32LE(INET_DIAG_NOCOOKIE, 48)
  reqV2.writeUInt32LE(INET_DIAG_NOCOOKIE, 52)

  const nlmsgLen = 16 + reqV2.byteLength
  const hdr = Buffer.alloc(16)
  hdr.writeUInt32LE(nlmsgLen, 0)
  hdr.writeUInt16LE(SOCK_DIAG_BY_FAMILY, 4)
  hdr.writeUInt16LE(NLM_F_REQUEST, 6)
  hdr.writeUInt32LE(seq, 8)
  hdr.writeUInt32LE(0, 12)
  return Buffer.concat([hdr, reqV2])
}

/** Parse the first inet_diag_msg UID from a netlink response, or null on error/empty/done. */
export function parseInetDiagUid(response: Buffer): number | null {
  let offset = 0
  while (offset + 16 <= response.byteLength) {
    const len = response.readUInt32LE(offset)
    if (len < 16) return null
    const type = response.readUInt16LE(offset + 4)
    const payload = response.subarray(offset + 16, offset + len)
    if (type === NLMSG_ERROR) return null
    if (type === NLMSG_DONE) return null
    if (type === SOCK_DIAG_BY_FAMILY && payload.byteLength >= INET_DIAG_UID_OFFSET + 4) {
      return payload.readUInt32LE(INET_DIAG_UID_OFFSET)
    }
    offset += (len + 3) & ~3
  }
  return null
}

export function lookupPeerUidInetDiag(tuple: Ipv4FourTuple, transport: SockDiagTransport): number | null {
  const request = buildInetDiagRequestV2(tuple)
  const response = transport.query(request)
  if (response.byteLength === 0) return null
  return parseInetDiagUid(response)
}

/** Hex IPv4 as in /proc/net/tcp (host-endian address word, e.g. 127.0.0.1 → 0100007F on LE). */
function ipv4ToProcHex(addr: string): string {
  const be = ipv4ToBe32(addr)
  const bytes = Buffer.from([be & 0xff, (be >>> 8) & 0xff, (be >>> 16) & 0xff, (be >>> 24) & 0xff])
  return bytes.toString('hex').toUpperCase()
}

function portToProcHex(port: number): string {
  return port.toString(16).padStart(4, '0').toUpperCase()
}

/**
 * Find the peer socket row in a /proc/net/tcp table and return its uid.
 * The peer four-tuple uses local=sport/src and rem=dport/dst (client identity).
 */
export function parseProcNetTcpUid(table: string, tuple: Ipv4FourTuple): number | null {
  const localIp = ipv4ToProcHex(tuple.src)
  const remIp = ipv4ToProcHex(tuple.dst)
  const localPort = portToProcHex(tuple.sport)
  const remPort = portToProcHex(tuple.dport)
  for (const line of table.trim().split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8 || !parts[1]?.includes(':') || !parts[2]?.includes(':')) continue
    const [lip, lport] = parts[1].split(':')
    const [rip, rport] = parts[2].split(':')
    if (
      lip.toUpperCase() === localIp &&
      lport.toUpperCase() === localPort &&
      rip.toUpperCase() === remIp &&
      rport.toUpperCase() === remPort
    ) {
      const uid = Number(parts[7])
      return Number.isSafeInteger(uid) ? uid : null
    }
  }
  return null
}

export function lookupPeerUidProcNetTcp(tuple: Ipv4FourTuple, table?: string): number | null {
  const text = table ?? readFileSync('/proc/net/tcp', 'utf8')
  return parseProcNetTcpUid(text, tuple)
}

function resolveProcTable(procTable: LookupPeerUidOptions['procTable']): string {
  if (typeof procTable === 'function') return procTable()
  if (typeof procTable === 'string') return procTable
  return readFileSync('/proc/net/tcp', 'utf8')
}

/**
 * Look up peer UID: inet_diag via transport when provided, else /proc/net/tcp.
 * Neither succeeding → lookup-failed (caller must refuse; no silent isolation downgrade).
 */
export function lookupPeerUid(tuple: Ipv4FourTuple, options: LookupPeerUidOptions = {}): PeerLookupResult {
  if (options.transport) {
    try {
      const uid = lookupPeerUidInetDiag(tuple, options.transport)
      if (uid !== null) return { ok: true, uid, method: 'inet_diag' }
    } catch {
      // fall through to /proc
    }
  }
  try {
    const uid = parseProcNetTcpUid(resolveProcTable(options.procTable), tuple)
    if (uid !== null) return { ok: true, uid, method: 'proc_net_tcp' }
  } catch {
    // both failed
  }
  return { ok: false, reason: 'lookup-failed' }
}

/** Look up peer UID for an accepted TCP socket. */
export function lookupPeerUidFromSocket(socket: Socket, options: LookupPeerUidOptions = {}): PeerLookupResult {
  try {
    return lookupPeerUid(fourTupleFromAccepted(socket), options)
  } catch {
    return { ok: false, reason: 'lookup-failed' }
  }
}

export function decidePeerAccess(input: {
  readonly localPort: number
  readonly peerUid: number | null
  readonly ownerUidForPort: (port: number) => number | undefined
}): PeerCheckDecision {
  if (input.peerUid === null) return { allow: false, reason: 'lookup-failed' }
  const owner = input.ownerUidForPort(input.localPort)
  if (owner === undefined) return { allow: false, reason: 'unmapped-port' }
  if (owner !== input.peerUid) return { allow: false, reason: 'foreign-uid' }
  return { allow: true, uid: input.peerUid }
}

/** Apply peer check on an accepted socket; destroy immediately when refused. */
export function enforcePeerCheck(
  socket: Socket,
  hooks: PeerCheckHooks,
  options: LookupPeerUidOptions = {},
): PeerCheckDecision {
  const localPort = socket.localPort
  if (typeof localPort !== 'number') {
    socket.destroy()
    return { allow: false, reason: 'lookup-failed' }
  }
  const looked = hooks.lookupPeerUid
    ? hooks.lookupPeerUid(socket)
    : lookupPeerUidFromSocket(socket, options)
  const peerUid = looked.ok ? looked.uid : null
  const decision = decidePeerAccess({
    localPort,
    peerUid,
    ownerUidForPort: hooks.ownerUidForPort,
  })
  if (!decision.allow) socket.destroy()
  return decision
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

function helperSourcePath(): string {
  return join(packageRoot(), 'native', 'inet-diag-helper.c')
}

function helperBinaryPath(): string {
  const src = helperSourcePath()
  const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12)
  const dir = join(tmpdir(), 'dsh-plugins-inet-diag')
  mkdirSync(dir, { recursive: true })
  return join(dir, `inet-diag-helper-${hash}`)
}

/** Compile the helper when missing; returns binary path or null. */
export function ensureInetDiagHelperBinary(): string | null {
  const src = helperSourcePath()
  if (!existsSync(src)) return null
  const bin = helperBinaryPath()
  if (existsSync(bin)) return bin
  const result = spawnSync('cc', ['-O2', '-o', bin, src], { encoding: 'utf8' })
  if (result.status !== 0 || !existsSync(bin)) return null
  return bin
}

function queryHelperOnce(request: Buffer): Buffer {
  const bin = ensureInetDiagHelperBinary()
  if (bin === null) return Buffer.alloc(0)
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(request.byteLength, 0)
  const result = spawnSync(bin, [], {
    input: Buffer.concat([lenBuf, request]),
    encoding: 'buffer',
    maxBuffer: 1_000_000,
  })
  if (result.status !== 0 || !result.stdout || result.stdout.byteLength < 4) return Buffer.alloc(0)
  const respLen = result.stdout.readUInt32LE(0)
  if (respLen === 0) return Buffer.alloc(0)
  return result.stdout.subarray(4, 4 + respLen)
}

/**
 * Live sock_diag transport via a small compiled helper (no Node native addon).
 * Returns null when `cc` cannot build the helper; callers fall back to /proc/net/tcp.
 */
export function tryCreateLinuxSockDiagTransport(): SockDiagTransport | null {
  if (ensureInetDiagHelperBinary() === null) return null
  return { query: queryHelperOnce }
}

/** Default production lookup options: live inet_diag helper when available, else /proc. */
export function defaultLookupOptions(): LookupPeerUidOptions {
  return { transport: tryCreateLinuxSockDiagTransport() }
}
