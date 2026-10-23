/** Decide whether a CONNECT target may proceed and which address to dial. */
import { isIP } from 'node:net'
import { lookup as systemLookup } from 'node:dns/promises'
import { addressInCidrs, allIntranetCidrs, isForbiddenAddress } from './ranges.ts'

export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type EgressResolve = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface EgressPolicyOptions {
  readonly allow: readonly string[]
  readonly intranet: Readonly<Record<string, readonly string[]>>
  readonly allowedTargetPorts?: readonly number[]
  readonly resolve?: EgressResolve
}

export type EgressDecision =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly reason: string }

const DEFAULT_PORTS = [443] as const

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await systemLookup(hostname, { all: true, order: 'verbatim' })
  return answers
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
    .map(entry => ({ address: entry.address, family: entry.family }))
}

/** Strip brackets from an IPv6 literal host. */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Split `host:port` or `[ipv6]:port` into host and port. */
export function parseConnectTarget(target: string): { host: string; port: number } | undefined {
  if (target.startsWith('[')) {
    const end = target.indexOf(']')
    if (end <= 1) return undefined
    const host = target.slice(1, end)
    if (target[end + 1] !== ':') return undefined
    const port = Number(target.slice(end + 2))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return { host, port }
  }
  const colon = target.lastIndexOf(':')
  if (colon <= 0) return undefined
  const host = target.slice(0, colon)
  const port = Number(target.slice(colon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (host.includes(':')) return undefined
  return { host, port }
}

/**
 * Evaluate one CONNECT authority. Allowlisted names must resolve only to public unicast;
 * intranet names must resolve inside their CIDRs; IP literals are admitted only inside the
 * union of intranet CIDRs. The returned address is the one the proxy must dial — never re-resolve.
 */
export async function evaluateConnectTarget(target: string, options: EgressPolicyOptions): Promise<EgressDecision> {
  const parsed = parseConnectTarget(target)
  if (parsed === undefined) return { ok: false, reason: 'malformed-target' }
  const ports = options.allowedTargetPorts ?? DEFAULT_PORTS
  if (!ports.includes(parsed.port)) return { ok: false, reason: 'port-not-allowed' }

  const host = stripBrackets(parsed.host)
  const literalFamily = isIP(host)
  const resolve = options.resolve ?? defaultResolve
  const allow = new Set(options.allow.map(name => name.toLowerCase()))
  const intranetHosts = new Map(Object.entries(options.intranet).map(([name, cidrs]) => [name.toLowerCase(), cidrs]))

  if (literalFamily !== 0) {
    const cidrs = allIntranetCidrs(options.intranet)
    if (cidrs.length === 0 || !addressInCidrs(host, cidrs)) return { ok: false, reason: 'ip-literal-refused' }
    return { ok: true, host, port: parsed.port, address: host, family: literalFamily === 4 ? 4 : 6 }
  }

  const lower = host.toLowerCase()
  const intranetCidrs = intranetHosts.get(lower)
  if (intranetCidrs !== undefined) {
    const answers = await resolve(host)
    if (answers.length === 0) return { ok: false, reason: 'empty-resolution' }
    for (const answer of answers) {
      if (isIP(answer.address) !== answer.family) return { ok: false, reason: 'invalid-resolution' }
      if (!addressInCidrs(answer.address, intranetCidrs)) return { ok: false, reason: 'intranet-cidr-miss' }
    }
    const first = answers[0]!
    return { ok: true, host, port: parsed.port, address: first.address, family: first.family }
  }

  if (!allow.has(lower)) return { ok: false, reason: 'host-not-allowed' }
  const answers = await resolve(host)
  if (answers.length === 0) return { ok: false, reason: 'empty-resolution' }
  for (const answer of answers) {
    if (isIP(answer.address) !== answer.family) return { ok: false, reason: 'invalid-resolution' }
    if (isForbiddenAddress(answer.address)) return { ok: false, reason: 'forbidden-range' }
  }
  const first = answers[0]!
  return { ok: true, host, port: parsed.port, address: first.address, family: first.family }
}
