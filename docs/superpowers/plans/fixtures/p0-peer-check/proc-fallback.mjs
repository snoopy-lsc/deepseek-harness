import net from 'node:net'
import fs from 'node:fs'
function peerUidFromProc(localPort, remotePort) {
  // /proc/net/tcp: sl local_address rem_address ... uid
  const lines = fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)
  const lp = localPort.toString(16).padStart(4, '0').toUpperCase()
  const rp = remotePort.toString(16).padStart(4, '0').toUpperCase()
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    const [lip, lport] = parts[1].split(':')
    const [rip, rport] = parts[2].split(':')
    // For accepted conn on server: local is server port, rem is client
    if (lport.toUpperCase() === lp && rport.toUpperCase() === rp && lip === '0100007F') {
      return Number(parts[7])
    }
  }
  return null
}
const server = net.createServer((sock) => {
  const { port: rp } = sock.remoteAddress === '127.0.0.1' ? { port: sock.remotePort } : { port: sock.remotePort }
  const lp = sock.localPort
  const t0 = process.hrtime.bigint()
  const uid = peerUidFromProc(lp, rp)
  const us = Number(process.hrtime.bigint() - t0) / 1e3
  sock.end(JSON.stringify({ uid, us }))
})
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const n = 200
  let total = 0
  let i = 0
  const next = () => {
    if (i++ >= n) {
      console.log(JSON.stringify({ method: 'proc_net_tcp', n, mean_us: total / n, uid_sample: process.getuid() }))
      server.close()
      return
    }
    const c = net.connect({ host: '127.0.0.1', port }, () => {})
    let buf = ''
    c.on('data', d => { buf += d })
    c.on('end', () => {
      const j = JSON.parse(buf)
      total += j.us
      next()
    })
  }
  next()
})
