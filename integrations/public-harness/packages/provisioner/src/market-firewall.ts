/** Container `inet dsh_market` owner-set element helpers (fixture argv/text — no live nft in tests). */

/** The only nftables table that holds market port drops for the container runtime. */
export const MARKET_TABLE = 'dsh_market'

/** Add one owner pair (`uid . port`); same text shape as native market-firewall. */
export function renderMarketOwnerAdd(uid: number, port: number): string {
  return `add element inet ${MARKET_TABLE} market_owner { ${uid} . ${port} }`
}

/** Delete one owner pair on instance stop. */
export function renderMarketOwnerDelete(uid: number, port: number): string {
  return `delete element inet ${MARKET_TABLE} market_owner { ${uid} . ${port} }`
}

/** Argv for `nft` that adds one `market_owner` element (no shell, no live nft required in fixtures). */
export function marketOwnerAddArgv(uid: number, port: number): string[] {
  return ['add', 'element', 'inet', MARKET_TABLE, 'market_owner', `{ ${uid} . ${port} }`]
}

/** Argv for `nft` that deletes one `market_owner` element. */
export function marketOwnerDeleteArgv(uid: number, port: number): string[] {
  return ['delete', 'element', 'inet', MARKET_TABLE, 'market_owner', `{ ${uid} . ${port} }`]
}
