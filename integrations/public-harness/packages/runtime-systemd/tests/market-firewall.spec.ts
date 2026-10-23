import { describe, expect, it } from 'vitest'
import { KeyedLock } from '@public-harness/provisioner/system'
import {
  MARKET_TABLE,
  parseMarketOwnerElements,
  renderMarketOwnerAdd,
  renderMarketOwnerDelete,
  renderMarketTable,
  type MarketEndpoint,
  type MarketFirewallOptions,
} from '../src/market-firewall.ts'
import { renderUserNetwork } from '../src/network.ts'
import {
  reconcileMarketFirewall,
  type MarketProbeHost,
  type MarketProbeState,
} from '../src/probe.ts'
import { config, instance } from './fixture.ts'

const marketPorts = { min: 31_000, max: 35_095 }
const listener = { path: 'system.slice/dsh-plugins.socket', level: 2 }
const options = (): MarketFirewallOptions => ({ marketPorts, listenerCgroup: listener })

describe('dsh_market firewall render', () => {
  it('renders owned table, market_owner set, listener and owner-drop chains', () => {
    const script = renderMarketTable(options())
    expect(script).toContain(`add table inet ${MARKET_TABLE}`)
    expect(script).toContain(`add set inet ${MARKET_TABLE} market_owner { type mark . inet_service ; }`)
    expect(script).toMatch(/add chain inet dsh_market input \{ type filter hook input priority filter - 2 ; policy accept ; \}/)
    expect(script).toContain(`add chain inet ${MARKET_TABLE} market_listener`)
    // Chains are flushed and refilled; the set is never flushed so elements survive reload.
    expect(script).toContain(`flush chain inet ${MARKET_TABLE} input`)
    expect(script).toContain(`flush chain inet ${MARKET_TABLE} market_listener`)
    expect(script).not.toMatch(/flush set inet dsh_market market_owner/)
    expect(script).toContain('define MARKET_PORTS = 31000-35095')
    expect(script).toContain(
      `add rule inet ${MARKET_TABLE} input iif "lo" tcp dport $MARKET_PORTS jump market_listener`,
    )
    expect(script).toContain(
      `add rule inet ${MARKET_TABLE} input iif "lo" tcp dport $MARKET_PORTS ct mark . tcp dport != @market_owner drop`,
    )
    expect(script).toContain(
      `add rule inet ${MARKET_TABLE} market_listener socket cgroupv2 level 2 "system.slice/dsh-plugins.socket" return`,
    )
    expect(script).toContain(`add rule inet ${MARKET_TABLE} market_listener drop`)
    // Parameterized cgroup: whatever config supplies is rendered; no P0.8 claim.
    const alt = renderMarketTable({
      marketPorts,
      listenerCgroup: { path: 'init.scope', level: 1 },
    })
    expect(alt).toContain('socket cgroupv2 level 1 "init.scope" return')
    expect(alt).not.toContain('system.slice/dsh-plugins.socket')
  })

  it('element helpers target market_owner with uid . port pairs', () => {
    expect(renderMarketOwnerAdd(1201, 31_000)).toBe(
      `add element inet ${MARKET_TABLE} market_owner { 1201 . 31000 }`,
    )
    expect(renderMarketOwnerDelete(1201, 31_000)).toBe(
      `delete element inet ${MARKET_TABLE} market_owner { 1201 . 31000 }`,
    )
  })

  it('owner accept sits in in_<uid> before the final loopback drop', () => {
    const i = instance()
    const without = renderUserNetwork(i, config())
    expect(without).toContain(
      'in_1201 ct mark 1201 iif "lo" tcp dport 29100 accept\nadd rule inet dsh_native in_1201 ct mark 1201 iif "lo" counter drop\n',
    )
    expect(without).not.toMatch(/tcp dport 31000-35095 accept/)

    const withMarket = renderUserNetwork(i, config(), { marketPorts })
    const quota = withMarket.indexOf('in_1201 ct mark 1201 iif "lo" tcp dport 29100 accept')
    const market = withMarket.indexOf('in_1201 ct mark 1201 iif "lo" tcp dport 31000-35095 accept')
    const drop = withMarket.indexOf('in_1201 ct mark 1201 iif "lo" counter drop')
    expect(quota).toBeGreaterThanOrEqual(0)
    expect(market).toBeGreaterThan(quota)
    expect(drop).toBeGreaterThan(market)
    // Still only the owned native table in this transaction; never loads dsh_market.
    expect(withMarket).not.toContain(MARKET_TABLE)
  })

  it('parses nft list set elements', () => {
    const listed = `table inet dsh_market {
	set market_owner {
		type mark . inet_service
		elements = { 1201 . 31000, 1202 . 31001 }
	}
}`
    expect(parseMarketOwnerElements(listed)).toEqual([
      { uid: 1201, port: 31_000 },
      { uid: 1202, port: 31_001 },
    ])
    expect(parseMarketOwnerElements('table inet dsh_market {\n\tset market_owner {\n\t\ttype mark . inet_service\n\t}\n}')).toEqual([])
  })
})

function pairKey(row: MarketEndpoint): string {
  return `${row.uid}.${row.port}`
}

describe('dsh_market probe self-heal', () => {
  it('reruns loader and refills set when table or chain is missing', async () => {
    const events: string[] = []
    const endpoints: MarketEndpoint[] = [
      { uid: 1201, port: 31_000 },
      { uid: 1202, port: 31_001 },
    ]
    const host: MarketProbeHost = {
      withLock: async (task) => {
        events.push('lock')
        return task()
      },
      listEndpoints: async () => {
        events.push('endpoints')
        return endpoints
      },
      inspect: async () => {
        events.push('inspect')
        return { table: false, input: false, market_listener: false }
      },
      loadTable: async () => {
        events.push('load')
      },
      listSet: async () => {
        events.push('list-set')
        return []
      },
      addElements: async (rows) => {
        events.push(`add:${rows.map(pairKey).sort().join(',')}`)
      },
      deleteElements: async (rows) => {
        events.push(`del:${rows.map(pairKey).sort().join(',')}`)
      },
      alertExtra: (row) => {
        events.push(`alert:${pairKey(row)}`)
      },
    }
    const next = await reconcileMarketFirewall(host, { previousExtras: new Set() })
    expect(events[0]).toBe('lock')
    expect(events).toContain('load')
    expect(events).toContain('add:1201.31000,1202.31001')
    // Endpoints and set are read only after the lock is taken.
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('endpoints'))
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('list-set'))
    expect(next.previousExtras.size).toBe(0)
  })

  it('deletes extras, alerts on two consecutive, and adds missing', async () => {
    const alerts: string[] = []
    const deleted: string[] = []
    const added: string[] = []
    const host: MarketProbeHost = {
      withLock: (task) => task(),
      listEndpoints: async () => [{ uid: 1201, port: 31_000 }],
      inspect: async () => ({ table: true, input: true, market_listener: true }),
      loadTable: async () => {
        throw new Error('should not reload when present')
      },
      listSet: async () => [
        { uid: 1201, port: 31_000 },
        { uid: 9999, port: 31_099 },
      ],
      addElements: async (rows) => {
        added.push(...rows.map(pairKey))
      },
      deleteElements: async (rows) => {
        deleted.push(...rows.map(pairKey))
      },
      alertExtra: (row) => {
        alerts.push(pairKey(row))
      },
    }
    const first = await reconcileMarketFirewall(host, { previousExtras: new Set() })
    expect(deleted).toEqual(['9999.31099'])
    expect(alerts).toEqual([])
    expect(added).toEqual([])
    expect([...first.previousExtras]).toEqual(['9999.31099'])

    deleted.length = 0
    // Same stale element still present on the next probe → security alert.
    const second = await reconcileMarketFirewall(host, first)
    expect(deleted).toEqual(['9999.31099'])
    expect(alerts).toEqual(['9999.31099'])
    expect([...second.previousExtras]).toEqual(['9999.31099'])
  })

  it('adds a missing owner element without treating it as global failure', async () => {
    const added: string[] = []
    const host: MarketProbeHost = {
      withLock: (task) => task(),
      listEndpoints: async () => [
        { uid: 1201, port: 31_000 },
        { uid: 1202, port: 31_001 },
      ],
      inspect: async () => ({ table: true, input: true, market_listener: true }),
      loadTable: async () => {
        throw new Error('present')
      },
      listSet: async () => [{ uid: 1201, port: 31_000 }],
      addElements: async (rows) => {
        added.push(...rows.map(pairKey))
      },
      deleteElements: async () => {
        throw new Error('no extras')
      },
      alertExtra: () => {
        throw new Error('no alert')
      },
    }
    const next = await reconcileMarketFirewall(host, { previousExtras: new Set() })
    expect(added).toEqual(['1202.31001'])
    expect(next.previousExtras.size).toBe(0)
  })

  it('serializes compare and mutate under one lock', async () => {
    const lock = new KeyedLock()
    let hold!: () => void
    const gate = new Promise<void>((resolve) => {
      hold = resolve
    })
    let endpoints: MarketEndpoint[] = [{ uid: 1201, port: 31_000 }]
    let setRows: MarketEndpoint[] = [{ uid: 1201, port: 31_000 }, { uid: 9999, port: 31_099 }]
    const order: string[] = []
    const host: MarketProbeHost = {
      withLock: (task) => lock.run('market', task),
      listEndpoints: async () => {
        order.push(`ep:${endpoints.map(pairKey).join('|')}`)
        return endpoints
      },
      inspect: async () => ({ table: true, input: true, market_listener: true }),
      loadTable: async () => undefined,
      listSet: async () => {
        order.push(`set:${setRows.map(pairKey).sort().join('|')}`)
        return setRows
      },
      addElements: async (rows) => {
        order.push(`add:${rows.map(pairKey).join('|')}`)
        setRows = [...setRows, ...rows]
      },
      deleteElements: async (rows) => {
        order.push(`del:${rows.map(pairKey).join('|')}`)
        const drop = new Set(rows.map(pairKey))
        setRows = setRows.filter((row) => !drop.has(pairKey(row)))
        // While the first probe holds the lock, a second mutation of endpoints is staged.
        endpoints = [{ uid: 1201, port: 31_000 }, { uid: 1203, port: 31_002 }]
        await gate
      },
      alertExtra: () => undefined,
    }
    const first = reconcileMarketFirewall(host, { previousExtras: new Set() })
    // Wait until the first probe is inside deleteElements (still holding the lock).
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (order.some((line) => line.startsWith('del:'))) resolve()
        else setTimeout(tick, 1)
      }
      tick()
    })
    const secondPromise = reconcileMarketFirewall(host, { previousExtras: new Set() })
    // Second must not have started inspect/list yet while first holds the lock.
    expect(order.filter((line) => line.startsWith('ep:')).length).toBe(1)
    hold()
    const [a, b] = await Promise.all([first, secondPromise])
    expect(order.filter((line) => line.startsWith('ep:')).length).toBe(2)
    // Second probe sees the updated endpoints and adds the new owner; stale already deleted.
    expect(order.some((line) => line === 'add:1203.31002')).toBe(true)
    expect(a.previousExtras.has('9999.31099')).toBe(true)
    expect(b.previousExtras.size).toBe(0)
    void a
  })
})

// Keep the type import used when assertions need the shape.
void (null as unknown as MarketProbeState)
