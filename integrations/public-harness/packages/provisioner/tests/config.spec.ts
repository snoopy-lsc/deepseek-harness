import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateProvisionerConfig } from '../src/config.ts'
import { makeConfig } from './helpers.ts'

const deployNativeConfig = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/native/config',
)

describe('provisioner configuration', () => {
  it('accepts a complete configuration', async () => { const config = await makeConfig(); expect(() => validateProvisionerConfig(config)).not.toThrow() })

  it.each([
    ['relative path', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, paths: { ...c.paths, stateDir: 'state' } })],
    ['duplicate paths', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, paths: { ...c.paths, stateDir: c.paths.socketDir } })],
    ['zero capacity', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, maxActiveInstances: 0 })],
    ['idle below socket lifetime', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, idleStopMs: 30_000 })],
    ['zero recovery period', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, deletionRecoveryMs: 0 })],
    ['bad group name', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, tools: { ...c.runtime.tools, sharedGroup: '../x' } } })],
    ['missing limit', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, limits: { ...c.limits, pids: 0 } })],
    ['host network', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, network: 'host' } })],
    ['missing ports', (c: Awaited<ReturnType<typeof makeConfig>>) => { const { ports: _ports, ...rest } = c; return rest }],
    ['privileged port range', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, ports: { ...c.ports, quota: { min: 80, max: 90 } } })],
    ['range in the ephemeral space', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, sidecar: { min: 40000, max: 40009 } } })],
    ['range far too wide', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, sidecar: { min: 2000, max: 20000 } } })],
    ['range smaller than capacity', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, ports: { ...c.ports, quota: { min: 29100, max: 29100 } } })],
    ['inverted range', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, ports: { ...c.ports, quota: { min: 29109, max: 29100 } } })],
    ['overlapping ranges', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, sidecar: { min: 29105, max: 29115 } } })],
    ['extra range key', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, ports: { ...c.ports, quota: { min: 29100, max: 29109, step: 2 } } })],
    ['relative image archive', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, imageArchive: 'image.tar' } })],
    ['option-like image archive', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, imageArchive: '-x' } })],
    ['bad quota address', (c: Awaited<ReturnType<typeof makeConfig>>) => ({ ...c, runtime: { ...c.runtime, hostAddress: 'localhost' } })],
  ])('rejects %s', async (_name, mutate) => {
    const config = mutate(await makeConfig())
    expect(() => validateProvisionerConfig(config)).toThrow()
  })
})


describe('explicit backend selection', () => {
  it('parses a native selection without any container tool, asset, image, or sidecar setting', async () => {
    const c = await makeConfig()
    const native = { ...c, runtime: { kind: 'systemd', configFile: '/etc/dsh/native.json' } }
    expect(validateProvisionerConfig(native).runtime.kind).toBe('systemd')
  })
  it('refuses missing and unknown runtime tags', async () => {
    const c = await makeConfig()
    const { runtime: _runtime, ...missing } = c
    expect(() => validateProvisionerConfig(missing)).toThrow()
    expect(() => validateProvisionerConfig({ ...c, runtime: { kind: 'unknown' } })).toThrow()
  })
})

it('rejects native configuration without an absolute companion file', async () => {
  const c = await makeConfig()
  for (const runtime of [{ kind: 'systemd' }, { kind: 'systemd', configFile: 'native.json' }]) {
    expect(() => validateProvisionerConfig({ ...c, runtime })).toThrow()
  }
})

describe('ports.market', () => {
  it('example_provisioner_json_ports_market_passes_validator', () => {
    const raw = JSON.parse(readFileSync(join(deployNativeConfig, 'provisioner.json.example'), 'utf8')) as {
      provisioner: unknown
    }
    const ok = validateProvisionerConfig(raw.provisioner)
    expect(ok.ports.market).toEqual({ min: 28_672, max: 32_767 })
    expect(ok.ports.market!.max - ok.ports.market!.min + 1).toBe(4096)
  })

  it('accepts_optional_market_range_and_rejects_overlap_or_cap', async () => {
    const c = await makeConfig()
    const ok = validateProvisionerConfig({
      ...c,
      ports: { ...c.ports, market: { min: 30_000, max: 30_099 } },
    })
    expect(ok.ports.market).toEqual({ min: 30_000, max: 30_099 })

    expect(() => validateProvisionerConfig({
      ...c,
      ports: { ...c.ports, market: { min: 29_100, max: 29_150 } },
    })).toThrow(/overlap/i)

    expect(() => validateProvisionerConfig({
      ...c,
      ports: { ...c.ports, market: { min: 10_000, max: 10_000 + 4096 } },
    })).toThrow()

    expect(() => validateProvisionerConfig({
      ...c,
      ports: { ...c.ports, market: { min: 40_000, max: 40_010 } },
    })).toThrow()
  })
})
