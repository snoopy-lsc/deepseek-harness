/** Source-address allow-lists for the emergency path: exact IPv4/IPv6 addresses or CIDR prefixes. */
import { isIP } from 'node:net'

function bytes(address: string): Uint8Array | undefined {
  // IPv4-mapped IPv6 addresses (`::ffff:192.0.2.7`) are compared as the IPv4 address they carry.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) address = mapped[1]!
  const family = isIP(address)
  if (family === 4) return Uint8Array.from(address.split('.').map(Number))
  if (family !== 6) return undefined
  const [head, tail] = address.includes('::') ? address.split('::') as [string, string] : [address, undefined]
  const parse = (part: string | undefined) => part ? part.split(':') : []
  let left = parse(head), right = parse(tail)
  // A trailing dotted quad fills the last two groups.
  const expand = (groups: string[]) => groups.flatMap(group => group.includes('.') ? (() => { const b = group.split('.').map(Number); return [((b[0]! << 8) | b[1]!).toString(16), ((b[2]! << 8) | b[3]!).toString(16)] })() : [group])
  left = expand(left); right = expand(right)
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0') as string[], ...right]
  if (groups.length !== 8) return undefined
  return Uint8Array.from(groups.flatMap(group => { const n = parseInt(group, 16); return [n >> 8, n & 255] }))
}

/** Validate one allow-list entry.
 * @param entry An address or `address/prefix`.
 * @returns True when the entry is a well-formed address or prefix.
 */
export function validIpEntry(entry: string): boolean {
  const [address, prefix, extra] = entry.split('/')
  if (extra !== undefined || address === undefined) return false
  const raw = bytes(address)
  if (raw === undefined) return false
  if (prefix === undefined) return true
  if (!/^[0-9]{1,3}$/.test(prefix)) return false
  return Number(prefix) <= raw.length * 8
}

/** Whether an address is covered by an allow-list.
 * @param ip Client address as reported by the trusted proxy.
 * @param list Validated entries.
 * @returns True on a match; malformed addresses never match.
 */
export function ipAllowed(ip: string, list: readonly string[]): boolean {
  const address = bytes(ip)
  if (address === undefined) return false
  return list.some(entry => {
    const [base, prefix] = entry.split('/')
    const network = bytes(base!)
    if (network === undefined || network.length !== address.length) return false
    const bits = prefix === undefined ? network.length * 8 : Number(prefix)
    for (let i = 0; i < bits; i++) {
      const mask = 0x80 >> (i % 8)
      if ((network[i >> 3]! & mask) !== (address[i >> 3]! & mask)) return false
    }
    return true
  })
}
