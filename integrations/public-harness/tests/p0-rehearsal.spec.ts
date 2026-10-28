import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const script = join(root, 'deploy/native/rehearsal/p0-rehearsal.sh')
const isRoot = process.getuid?.() === 0
const run = (args: readonly string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
const shellcheck = spawnSync('shellcheck', ['--version']).status === 0 ? 'shellcheck' : undefined

describe('P0 rehearsal script (static and dry-run only; never run for real here)', () => {
  it('is executable bash that parses', async () => {
    expect((await stat(script)).mode & 0o111).not.toBe(0)
    expect((await readFile(script, 'utf8')).startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
  })

  it.skipIf(shellcheck === undefined)('passes shellcheck', () => {
    const result = spawnSync(shellcheck!, ['-x', script], { encoding: 'utf8' })
    expect(result.stdout + result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('dry-run prints the plan for P0.4, P0.5 and P0.8 and creates nothing', async () => {
    const evidence = join(await mkdtemp(join(tmpdir(), 'dsh-p0-')), 'evidence')
    const result = run(['--dry-run', '--evidence-dir', evidence])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/DRY-RUN/)
    for (const probe of ['P0.4', 'P0.5', 'P0.8']) expect(result.stdout).toContain(`${probe} `)
    expect(result.stdout).toContain('--ignore-pnpmfile --config.userconfig=/dev/null')
    expect(result.stdout).toContain('IPAddressAllow=localhost')
    expect(result.stdout).toMatch(/meta skuid/)
    expect(result.stdout).toMatch(/socket cgroupv2 level 1 "init\.scope"/)
    expect(result.stdout).toMatch(/container part skipped/)
    expect(existsSync(evidence)).toBe(false)
    const only = run(['--dry-run', '--only', 'P0.8'])
    expect(only.stdout).toContain('P0.8 ')
    expect(only.stdout).not.toContain('P0.4 ')
  })

  it('never echoes secrets from the environment or arguments', () => {
    const secret = 'sk-p0rehearsalsecret123456'
    const result = run(['--dry-run', '--evidence-dir', `/tmp/${secret}`], { DSH_MODEL_API_KEY: secret })
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(result.stdout).toContain('sk-[REDACTED]')
  })

  it('rejects bad usage', () => {
    for (const args of [['--bogus'], ['--only', 'P0.9'], ['--probe-port', '80'], ['--account', 'a;b'], ['--container', '--dry-run'], ['--evidence-dir', 'relative']]) {
      const result = run(args)
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.stderr, args.join(' ')).toMatch(/^p0-rehearsal: /)
    }
  })

  it.skipIf(isRoot)('refuses a real run without root', () => {
    const result = run([], { DSH_NATIVE_REHEARSAL: 'dedicated-host' })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/root is required/)
    expect(result.stdout).toBe('')
  })

  it('is documented in both runbooks', async () => {
    for (const path of ['deploy/native/rehearsal/README.md', 'deploy/native/rehearsal/README.zh.md']) {
      const text = await readFile(join(root, path), 'utf8')
      expect(text, path).toContain('p0-rehearsal.sh --dry-run')
      for (const probe of ['P0.4', 'P0.5', 'P0.8']) expect(text, path).toContain(probe)
    }
  })
})
