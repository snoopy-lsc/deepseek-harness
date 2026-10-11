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
    ['bad quota address', (c: any) => ({ ...c, quota: { hostAddress: 'localhost' } })],
  ])('rejects %s', async (_name, mutate) => {
    const config = mutate(await makeConfig())
    expect(() => validateProvisionerConfig(config)).toThrow()
  })
})
