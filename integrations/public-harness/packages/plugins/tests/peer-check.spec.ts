/** 1B.2: inet_diag peer UID check with /proc/net/tcp fallback; wire into market accept. */
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInetDiagRequestV2,
  decidePeerAccess,
  fourTupleFromAccepted,
  lookupPeerUid,
  lookupPeerUidInetDiag,
  lookupPeerUidProcNetTcp,
  parseInetDiagUid,
  parseProcNetTcpUid,
  tryCreateLinuxSockDiagTransport,
  type SockDiagTransport,
} from '../src/peer-check.ts'
import { startMarketHttpServer, type MarketHttpServer } from '../src/listen.ts'
import { mintMarketToken } from '../src/token.ts'

const servers: MarketHttpServer[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.destroy()
  }
  for (const server of servers.splice(0)) await server.close()
})

/** Fixture table row shape matching /proc/net/tcp (IPv4 loopback). */
function procLine(opts: {
  localPort: number
  remotePort: number
  uid: number
  localIp?: string
  remoteIp?: string
  sl?: number
}): string {
  const lip = opts.localIp ?? '0100007F' // 127.0.0.1 LE hex
  const rip = opts.remoteIp ?? '0100007F'
  const lp = opts.localPort.toString(16).padStart(4, '0').toUpperCase()
  const rp = opts.remotePort.toString(16).padStart(4, '0').toUpperCase()
  // sl local rem st tx rx tr tm->when retrnsmt uid timeout inode
  return `${String(opts.sl ?? 0).padStart(4, '0')}: ${lip}:${lp} ${rip}:${rp} 01 00000000:00000000 00:00000000 00000000 ${String(opts.uid).padStart(8, ' ')}        0 12345 1 0000000000000000 100 0 0 10 0`
}

describe('inet_diag packing', () => {
  it('builds_exact_four_tuple_request_bytes', () => {
    const req = buildInetDiagRequestV2({
      sport: 56332,
      dport: 41837,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, { seq: 1 })
    // Validated against a live NETLINK_SOCK_DIAG success on this host (P0.9 follow-up).
    expect(req.toString('hex')).toBe(
      '4800000014000100010000000000000002060000ff0f0000dc0ca36d7f0000010000000000000000000000007f00000100000000000000000000000000000000ffffffffffffffff',
    )
  })

  it('parses_uid_from_inet_diag_msg', () => {
    // Minimal nlmsghdr + inet_diag_msg with uid 2001 at the documented offset.
    const msgPayload = Buffer.alloc(72)
    msgPayload[0] = 2 // AF_INET
    msgPayload[1] = 1 // TCP_ESTABLISHED
    msgPayload.writeUInt32LE(2001, 4 + 48 + 12) // after expires,rqueue,wqueue
    const nlmsgLen = 16 + 72
    const hdr = Buffer.alloc(16)
    hdr.writeUInt32LE(nlmsgLen, 0)
    hdr.writeUInt16LE(20, 4) // SOCK_DIAG_BY_FAMILY
    hdr.writeUInt16LE(0, 6)
    hdr.writeUInt32LE(1, 8)
    const buf = Buffer.concat([hdr, msgPayload])
    expect(parseInetDiagUid(buf)).toBe(2001)
  })

  it('lookup_via_injectable_transport', () => {
    const transport: SockDiagTransport = {
      query(request) {
        expect(request.byteLength).toBe(72)
        const msgPayload = Buffer.alloc(72)
        msgPayload.writeUInt32LE(4242, 4 + 48 + 12)
        const nlmsgLen = 16 + 72
        const hdr = Buffer.alloc(16)
        hdr.writeUInt32LE(nlmsgLen, 0)
        hdr.writeUInt16LE(20, 4)
        return Buffer.concat([hdr, msgPayload])
      },
    }
    const uid = lookupPeerUidInetDiag({
      sport: 1,
      dport: 2,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, transport)
    expect(uid).toBe(4242)
  })
})

describe('proc_net_tcp fallback', () => {
  it('parses_fixture_table_for_matching_four_tuple', () => {
    // Each /proc/net/tcp row is one endpoint. Peer UID comes from the *client* row
    // (local=client port, rem=server port), i.e. the peer four-tuple.
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      procLine({ localPort: 0xDC0C, remotePort: 0xA36D, uid: 1000 }),
      procLine({ localPort: 0x5678, remotePort: 0x1234, uid: 2002 }),
    ].join('\n')
    expect(parseProcNetTcpUid(table, {
      sport: 0xDC0C,
      dport: 0xA36D,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    })).toBe(1000)
    expect(lookupPeerUidProcNetTcp({
      sport: 0x5678,
      dport: 0x1234,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, table)).toBe(2002)
    expect(lookupPeerUidProcNetTcp({
      sport: 1,
      dport: 2,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, table)).toBeNull()
  })

  it('live_loopback_accept_returns_same_uid', async () => {
    const tcp = createNetServer()
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = tcp.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected AddressInfo')
    const sock = await new Promise<Socket>((resolve, reject) => {
      tcp.once('connection', resolve)
      const client = netConnect({ host: '127.0.0.1', port: addr.port })
      client.once('error', reject)
      sockets.push(client)
    })
    sockets.push(sock)
    const tuple = fourTupleFromAccepted(sock)
    const uid = lookupPeerUidProcNetTcp(tuple)
    expect(uid).toBe(process.getuid())
    sock.destroy()
    tcp.close()
    await once(tcp, 'close')
  }, 10_000)

  it('live_inet_diag_helper_returns_same_uid_when_cc_available', async () => {
    const transport = tryCreateLinuxSockDiagTransport()
    if (transport === null) {
      // Helper compile unavailable in this environment — packing is still covered by mocks.
      return
    }
    const tcp = createNetServer()
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = tcp.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected AddressInfo')
    const sock = await new Promise<Socket>((resolve, reject) => {
      tcp.once('connection', resolve)
      const client = netConnect({ host: '127.0.0.1', port: addr.port })
      client.once('error', reject)
      sockets.push(client)
    })
    sockets.push(sock)
    const uid = lookupPeerUidInetDiag(fourTupleFromAccepted(sock), transport)
    expect(uid).toBe(process.getuid())
    sock.destroy()
    tcp.close()
    await once(tcp, 'close')
  }, 15_000)
})

describe('decidePeerAccess', () => {
  it('allows_matching_uid', () => {
    expect(decidePeerAccess({
      localPort: 31000,
      peerUid: 2001,
      ownerUidForPort: (p) => (p === 31000 ? 2001 : undefined),
    })).toEqual({ allow: true, uid: 2001 })
  })

  it('refuses_foreign_uid_unmapped_and_lookup_failure', () => {
    expect(decidePeerAccess({
      localPort: 31000,
      peerUid: 2002,
      ownerUidForPort: () => 2001,
    })).toEqual({ allow: false, reason: 'foreign-uid' })
    expect(decidePeerAccess({
      localPort: 31000,
      peerUid: 2001,
      ownerUidForPort: () => undefined,
    })).toEqual({ allow: false, reason: 'unmapped-port' })
    expect(decidePeerAccess({
      localPort: 31000,
      peerUid: null,
      ownerUidForPort: () => 2001,
    })).toEqual({ allow: false, reason: 'lookup-failed' })
  })
})

describe('lookupPeerUid fallback order', () => {
  it('uses_inet_diag_then_proc', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      procLine({ localPort: 0xAAAA, remotePort: 0xBBBB, uid: 7 }),
    ].join('\n')
    const transport: SockDiagTransport = {
      query() {
        const msgPayload = Buffer.alloc(72)
        msgPayload.writeUInt32LE(9, 4 + 48 + 12)
        const hdr = Buffer.alloc(16)
        hdr.writeUInt32LE(16 + 72, 0)
        hdr.writeUInt16LE(20, 4)
        return Buffer.concat([hdr, msgPayload])
      },
    }
    const result = lookupPeerUid({
      sport: 0xAAAA,
      dport: 0xBBBB,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, { transport, procTable: table })
    expect(result).toEqual({ ok: true, uid: 9, method: 'inet_diag' })

    const procOnly = lookupPeerUid({
      sport: 0xAAAA,
      dport: 0xBBBB,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, { transport: null, procTable: table })
    expect(procOnly).toEqual({ ok: true, uid: 7, method: 'proc_net_tcp' })

    const failed = lookupPeerUid({
      sport: 1,
      dport: 2,
      src: '127.0.0.1',
      dst: '127.0.0.1',
    }, { transport: { query: () => Buffer.alloc(0) }, procTable: table })
    expect(failed.ok).toBe(false)
  })
})

describe('market accept peer check', () => {
  it('closes_foreign_uid_before_http_body_allows_matching', async () => {
    const minted = mintMarketToken()
    const ownerUid = 2100
    let lookups = 0
    const server = await startMarketHttpServer({
      host: '127.0.0.1',
      port: 0,
      lookup: () => ({
        userId: 'user-peer',
        accountUid: ownerUid,
        tokenSha256: minted.tokenSha256,
      }),
      buildIndex: () => ({ format: 1, plugins: [] }),
      lookupPackument: () => undefined,
      lookupTarball: () => undefined,
      peerCheck: {
        ownerUidForPort: () => ownerUid,
        lookupPeerUid: () => {
          lookups += 1
          // First connection: foreign; second: matching.
          if (lookups === 1) return { ok: true, uid: ownerUid + 1, method: 'inet_diag' as const }
          return { ok: true, uid: ownerUid, method: 'inet_diag' as const }
        },
      },
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    // Foreign peer: connection should be destroyed — fetch fails or empty/reset, no 200 JSON.
    let foreignStatus: number | 'reset' = 'reset'
    try {
      const response = await fetch(`${base}/index.json`)
      foreignStatus = response.status
      const body = await response.text()
      // Must not look like a successful index.
      expect(body).not.toContain('"format"')
    } catch {
      foreignStatus = 'reset'
    }
    expect(foreignStatus === 'reset' || foreignStatus >= 400 || foreignStatus === 0).toBe(true)

    const ok = await fetch(`${base}/index.json`)
    expect(ok.status).toBe(200)
    expect(JSON.parse(await ok.text())).toEqual({ format: 1, plugins: [] })
    expect(lookups).toBeGreaterThanOrEqual(2)
  })

  it('refuses_unmapped_port_and_lookup_failure', async () => {
    const minted = mintMarketToken()
    const cases: Array<{
      name: string
      ownerUidForPort: (p: number) => number | undefined
      lookupPeerUid: () => { ok: false; reason: 'lookup-failed' } | { ok: true; uid: number; method: 'inet_diag' }
    }> = [
      {
        name: 'unmapped',
        ownerUidForPort: () => undefined,
        lookupPeerUid: () => ({ ok: true, uid: 1, method: 'inet_diag' }),
      },
      {
        name: 'lookup-failed',
        ownerUidForPort: () => 1,
        lookupPeerUid: () => ({ ok: false, reason: 'lookup-failed' }),
      },
    ]
    for (const c of cases) {
      const server = await startMarketHttpServer({
        host: '127.0.0.1',
        port: 0,
        lookup: () => ({
          userId: 'u',
          accountUid: 1,
          tokenSha256: minted.tokenSha256,
        }),
        buildIndex: () => ({ format: 1, plugins: [] }),
        lookupPackument: () => undefined,
        lookupTarball: () => undefined,
        peerCheck: {
          ownerUidForPort: c.ownerUidForPort,
          lookupPeerUid: c.lookupPeerUid,
        },
      })
      servers.push(server)
      let sawSuccess = false
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/index.json`)
        const body = await response.text()
        if (response.status === 200 && body.includes('"format"')) sawSuccess = true
      } catch {
        // connection reset — expected
      }
      expect(sawSuccess, c.name).toBe(false)
      await server.close()
      servers.pop()
    }
  })
})
