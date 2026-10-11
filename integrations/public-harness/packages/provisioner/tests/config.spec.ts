import { describe, expect, it } from 'vitest'
import { validateProvisionerConfig } from '../src/config.ts'
import { makeConfig } from './helpers.ts'

describe('provisioner configuration', () => {
  it('accepts a complete configuration', async () => { const config = await makeConfig(); expect(() => validateProvisionerConfig(config)).not.toThrow() })

  it.each([
    ['relative path', (c: any) => ({ ...c, paths: { ...c.paths, stateDir: 'state' } })],
    ['duplicate paths', (c: any) => ({ ...c, paths: { ...c.paths, stateDir: c.paths.socketDir } })],
    ['zero capacity', (c: any) => ({ ...c, maxActiveInstances: 0 })],
    ['idle below socket lifetime', (c: any) => ({ ...c, idleStopMs: 30_000 })],
    ['zero recovery period', (c: any) => ({ ...c, deletionRecoveryMs: 0 })],
    ['bad group name', (c: any) => ({ ...c, tools: { ...c.tools, sharedGroup: '../x' } })],
    ['missing limit', (c: any) => ({ ...c, limits: { ...c.limits, pids: 0 } })],
    ['host network', (c: any) => ({ ...c, limits: { ...c.limits, network: 'host' } })],
    ['missing ports', (c: any) => { const { ports: _ports, ...rest } = c; return rest }],
    ['privileged port range', (c: any) => ({ ...c, ports: { ...c.ports, quota: { min: 80, max: 90 } } })],
    ['range in the ephemeral space', (c: any) => ({ ...c, ports: { ...c.ports, sidecar: { min: 40000, max: 40009 } } })],
    ['range far too wide', (c: any) => ({ ...c, ports: { ...c.ports, sidecar: { min: 2000, max: 20000 } } })],
    ['range smaller than capacity', (c: any) => ({ ...c, ports: { ...c.ports, quota: { min: 29100, max: 29100 } } })],
    ['inverted range', (c: any) => ({ ...c, ports: { ...c.ports, quota: { min: 29109, max: 29100 } } })],
    ['overlapping ranges', (c: any) => ({ ...c, ports: { quota: { min: 29100, max: 29109 }, sidecar: { min: 29105, max: 29115 } } })],
    ['extra range key', (c: any) => ({ ...c, ports: { ...c.ports, quota: { min: 29100, max: 29109, step: 2 } } })],
    ['bad quota address', (c: any) => ({ ...c, quota: { hostAddress: 'localhost' } })],
  ])('rejects %s', async (_name, mutate) => {
    const config = mutate(await makeConfig())
    expect(() => validateProvisionerConfig(config)).toThrow()
  })
})
