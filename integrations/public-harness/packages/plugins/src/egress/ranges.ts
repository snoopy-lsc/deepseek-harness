/** Forbidden destination ranges for dsh-plugins-egress (design § Store, egress, and mirror). */
import { BlockList, isIP } from 'node:net'

/**
 * IPv4 and IPv6 lists stay separate: Node's BlockList treats IPv4 checks as
 * IPv4-mapped IPv6, so a single list holding `::ffff:0:0/96` would match every IPv4 address.
 */
const FORBIDDEN_V4 = new BlockList()
const FORBIDDEN_V6 = new BlockList()

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) FORBIDDEN_V4.addSubnet(address, prefix, 'ipv4')

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) FORBIDDEN_V6.addSubnet(address, prefix, 'ipv6')

/** True when the address is loopback, private, link-local, CGNAT, multicast, metadata, or a listed IPv6 transition range. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return FORBIDDEN_V4.check(address, 'ipv4')
  if (family === 6) return FORBIDDEN_V6.check(address, 'ipv6')
  return true
}

export interface ParsedCidr {
  readonly address: string
  readonly prefix: number
  readonly type: 'ipv4' | 'ipv6'
}

/** Parse `a.b.c.d/nn` or `ipv6/nn`. */
export function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.lastIndexOf('/')
  if (slash <= 0) throw new Error(`invalid CIDR: ${cidr}`)
  const address = cidr.slice(0, slash)
  const prefix = Number(cidr.slice(slash + 1))
  const family = isIP(address)
  if (family === 0 || !Number.isInteger(prefix) || prefix < 0) throw new Error(`invalid CIDR: ${cidr}`)
  if (family === 4 && prefix > 32) throw new Error(`invalid CIDR: ${cidr}`)
  if (family === 6 && prefix > 128) throw new Error(`invalid CIDR: ${cidr}`)
  return { address, prefix, type: family === 4 ? 'ipv4' : 'ipv6' }
}

/** True when `address` falls in any of the CIDRs (same address family only). */
export function addressInCidrs(address: string, cidrs: readonly string[]): boolean {
  const family = isIP(address)
  if (family === 0) return false
  const type = family === 4 ? 'ipv4' : 'ipv6'
  const list = new BlockList()
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr)
    if (parsed.type !== type) continue
    list.addSubnet(parsed.address, parsed.prefix, parsed.type)
  }
  return list.check(address, type)
}

/** Union of every CIDR listed under intranet host entries. */
export function allIntranetCidrs(intranet: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const cidrs of Object.values(intranet)) {
    for (const cidr of cidrs) {
      if (seen.has(cidr)) continue
      seen.add(cidr)
      out.push(cidr)
    }
  }
  return out
}
