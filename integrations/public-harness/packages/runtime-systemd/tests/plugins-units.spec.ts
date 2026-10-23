import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MARKET_LOADER_PATH, renderPluginsSocketUnit } from '../src/plugins-units.ts'
import { parseSystemdConfig } from '../src/config.ts'
import { common, native } from './fixture.ts'

const deploySystemd = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/native/systemd',
)

describe('dsh-plugins systemd unit sketches', () => {
  it('service_sets_LimitNOFILE_AF_NETLINK_and_loopback_sandbox', () => {
    const text = readFileSync(join(deploySystemd, 'dsh-plugins.service'), 'utf8')
    expect(text).toContain('LimitNOFILE=16384')
    expect(text).toContain('AF_NETLINK')
    expect(text).toContain('User=dsh-plugins')
    expect(text).toContain('Sockets=dsh-plugins.socket')
    expect(text).toContain('IPAddressDeny=any')
    expect(text).toContain('IPAddressAllow=localhost')
    expect(text).toContain('CapabilityBoundingSet=')
  })

  it('socket_listens_on_loopback_and_loads_dsh_market_via_ExecStartPost', () => {
    const text = readFileSync(join(deploySystemd, 'dsh-plugins.socket'), 'utf8')
    expect(text).toContain('ListenStream=127.0.0.1:')
    expect(text).toContain('Service=dsh-plugins.service')
    expect(text).toMatch(/ExecStartPost=-/)
    expect(text).toContain('dsh_market')
  })

  it('renderPluginsSocketUnit_emits_one_ListenStream_per_port_and_loader', () => {
    const unit = renderPluginsSocketUnit({
      marketPorts: { min: 31000, max: 31002 },
      loaderPath: DEFAULT_MARKET_LOADER_PATH,
    })
    expect(unit).toContain('ListenStream=127.0.0.1:31000')
    expect(unit).toContain('ListenStream=127.0.0.1:31001')
    expect(unit).toContain('ListenStream=127.0.0.1:31002')
    expect(unit).toContain(`ExecStartPost=-${DEFAULT_MARKET_LOADER_PATH}`)
    expect(unit).toContain('Service=dsh-plugins.service')
  })
})

describe('ports.market on native config', () => {
  it('accepts_market_range_and_rejects_overlap_or_oversized', () => {
    const withMarket = {
      common: { ...common, ports: { ...common.ports, market: { min: 30_000, max: 30_099 } } },
      native,
    }
    expect(parseSystemdConfig(withMarket).ports.market).toEqual({ min: 30_000, max: 30_099 })

    expect(() => parseSystemdConfig({
      common: { ...common, ports: { ...common.ports, market: { min: 29_200, max: 29_250 } } },
      native,
    })).toThrow(/overlap/i)

    expect(() => parseSystemdConfig({
      common: { ...common, ports: { ...common.ports, market: { min: 10_000, max: 10_000 + 4096 } } },
      native,
    })).toThrow()
  })
})
