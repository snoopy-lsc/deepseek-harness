/** Separately loaded `inet dsh_market` table: listener cgroup drop + owner set; never part of network.install. */
import type { PortRange } from '@public-harness/contracts'

/** The only nftables table that holds market port drops; host and per-instance tables are never touched. */
export const MARKET_TABLE = 'dsh_market'

/** Listening sockets' cgroup as measured (or configured); the loader renders whatever string it is given. */
export interface MarketListenerCgroup {
  readonly path: string
  readonly level: number
}

/** Inputs for the socket-unit loader script. */
export interface MarketFirewallOptions {
  readonly marketPorts: PortRange
  readonly listenerCgroup: MarketListenerCgroup
}

/** One `plugin_endpoint` row as a uid/port pair for the `market_owner` set. */
export interface MarketEndpoint {
  readonly uid: number
  readonly port: number
}

/** Inclusive port range as an nft define / dport expression (`min-max`). */
export function formatMarketPorts(range: PortRange): string {
  return `${range.min}-${range.max}`
}

/**
 * Loader script for `dsh-plugins.socket` ExecStartPost: create table and set if absent, flush and refill
 * only the chains so `market_owner` elements survive a reload. Outside `network.install`.
 */
export function renderMarketTable(options: MarketFirewallOptions): string {
  const ports = formatMarketPorts(options.marketPorts)
  const { path, level } = options.listenerCgroup
  return [
    `define MARKET_PORTS = ${ports}`,
    `add table inet ${MARKET_TABLE}`,
    `add set inet ${MARKET_TABLE} market_owner { type mark . inet_service ; }`,
    `add chain inet ${MARKET_TABLE} input { type filter hook input priority filter - 2 ; policy accept ; }`,
    `add chain inet ${MARKET_TABLE} market_listener`,
    `flush chain inet ${MARKET_TABLE} input`,
    `flush chain inet ${MARKET_TABLE} market_listener`,
    `add rule inet ${MARKET_TABLE} input iif "lo" tcp dport $MARKET_PORTS jump market_listener`,
    `add rule inet ${MARKET_TABLE} input iif "lo" tcp dport $MARKET_PORTS ct mark . tcp dport != @market_owner drop`,
    `add rule inet ${MARKET_TABLE} market_listener socket cgroupv2 level ${level} "${path}" return`,
    `add rule inet ${MARKET_TABLE} market_listener drop`,
    '',
  ].join('\n')
}

/** Add one owner pair; callers run this under the same provisioner lock as the probe. */
export function renderMarketOwnerAdd(uid: number, port: number): string {
  return `add element inet ${MARKET_TABLE} market_owner { ${uid} . ${port} }`
}

/** Delete one owner pair (stale element or endpoint row removal). */
export function renderMarketOwnerDelete(uid: number, port: number): string {
  return `delete element inet ${MARKET_TABLE} market_owner { ${uid} . ${port} }`
}

/** Parse `nft list set inet dsh_market market_owner` (or list table) stdout into uid/port pairs. */
export function parseMarketOwnerElements(output: string): MarketEndpoint[] {
  const match = /elements\s*=\s*\{\s*([^}]*)\}/s.exec(output)
  if (match === null) return []
  const body = match[1]!.trim()
  if (body.length === 0) return []
  const rows: MarketEndpoint[] = []
  for (const part of body.split(',')) {
    const pair = /^\s*(\d+)\s*\.\s*(\d+)\s*$/.exec(part)
    if (pair === null) continue
    rows.push({ uid: Number(pair[1]), port: Number(pair[2]) })
  }
  return rows
}

/** Stable key for set equality (`uid.port`). */
export function marketEndpointKey(row: MarketEndpoint): string {
  return `${row.uid}.${row.port}`
}
