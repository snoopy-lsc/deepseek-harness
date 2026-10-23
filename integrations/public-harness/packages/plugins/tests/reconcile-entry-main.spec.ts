/** 1D.6-fix: main must take an independent market port (not from plan registry). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/reconcile-entry-main.ts'

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const key of Object.keys(savedEnv)) {
    const prev = savedEnv[key]
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
    delete savedEnv[key]
  }
})

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reconcile-main-'))
  roots.push(home)
  mkdirSync(join(home, 'profiles', 'public-user'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'public-user', 'package.json'),
    `${JSON.stringify({ name: 'dsh', dependencies: {} }, null, 2)}\n`,
  )
  return home
}

function writePlan(home: string, registry: string): string {
  const planPath = join(home, '.dsh-market', 'reconcile-plan.json')
  mkdirSync(join(home, '.dsh-market'), { recursive: true })
  writeFileSync(planPath, `${JSON.stringify({ registry, entries: [] })}\n`)
  return planPath
}

describe('reconcile-entry main independent market port', () => {
  it('rejects_plan_registry_port_that_does_not_match_independent_env_port', async () => {
    const home = fixtureHome()
    // Old bug: deriving expectedPort from the plan URL would accept any port on loopback.
    const planPath = writePlan(home, 'http://127.0.0.1:9999/npm/')
    setEnv('HOME', home)
    setEnv('DSH_HOME', home)
    setEnv('DSH_MARKET_PORT', '31001')
    setEnv('DSH_HOST_ADDRESS', undefined)
    await expect(main([planPath])).rejects.toThrow(/bad-registry/)
  })

  it('rejects_when_no_independent_market_port_is_provided', async () => {
    const home = fixtureHome()
    const planPath = writePlan(home, 'http://127.0.0.1:31001/npm/')
    setEnv('HOME', home)
    setEnv('DSH_HOME', home)
    setEnv('DSH_MARKET_PORT', undefined)
    setEnv('DSH_HOST_ADDRESS', undefined)
    const code = await main([planPath])
    expect(code).toBe(2)
  })

  it('accepts_matching_independent_port_from_env', async () => {
    const home = fixtureHome()
    const planPath = writePlan(home, 'http://127.0.0.1:31001/npm/')
    setEnv('HOME', home)
    setEnv('DSH_HOME', home)
    setEnv('DSH_MARKET_PORT', '31001')
    setEnv('DSH_HOST_ADDRESS', undefined)
    expect(await main([planPath])).toBe(0)
  })

  it('accepts_matching_independent_port_from_argv_flag', async () => {
    const home = fixtureHome()
    const planPath = writePlan(home, 'http://127.0.0.1:31001/npm/')
    setEnv('HOME', home)
    setEnv('DSH_HOME', home)
    setEnv('DSH_MARKET_PORT', undefined)
    setEnv('DSH_HOST_ADDRESS', undefined)
    expect(await main([planPath, '--market-port=31001'])).toBe(0)
  })

  it('accepts_hostAddress_when_DSH_HOST_ADDRESS_is_set', async () => {
    const home = fixtureHome()
    const planPath = writePlan(home, 'http://192.168.200.1:31001/npm/')
    setEnv('HOME', home)
    setEnv('DSH_HOME', home)
    setEnv('DSH_MARKET_PORT', '31001')
    setEnv('DSH_HOST_ADDRESS', '192.168.200.1')
    expect(await main([planPath])).toBe(0)
  })
})
