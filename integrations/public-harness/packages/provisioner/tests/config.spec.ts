import { describe, expect, it } from 'vitest'
import { validateProvisionerConfig } from '../src/config.ts'
import { makeConfig } from './helpers.ts'

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
