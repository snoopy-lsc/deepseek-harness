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

  it('P0.8 plan exercises the fatal loader and the per-owner market_owner set', () => {
    const result = run(['--dry-run', '--only', 'P0.8'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('/usr/lib/dsh-public/load-dsh-market.sh <rules> as a fatal ExecStartPost')
    expect(result.stdout).toMatch(/no market_owner element: connecting to the market port must be denied/)
    expect(result.stdout).toMatch(/rerun \/usr\/lib\/dsh-public\/load-dsh-market\.sh <rules>: exit 0 and the element survives/)
    expect(result.stdout).toMatch(/a second market port \(not owned\) is denied/)
    expect(result.stdout).toMatch(/the account is denied again/)
    expect(result.stdout).toMatch(/dsh_market table itself is never flushed or deleted/)
    expect(run(['--dry-run', '--only', 'P0.8', '--market-loader', '/opt/x/load.sh']).stdout).toContain('/opt/x/load.sh <rules>')
  })

  it('P0.8 run removes only its own temporary element and never flushes dsh_market', async () => {
    const text = await readFile(script, 'utf8')
    expect(text).toMatch(/nft delete element inet "\$MARKET_TABLE" market_owner "\{ \$market_element \}"/)
    expect(text).not.toMatch(/(flush|delete) (table|chain|set) inet "?\$MARKET_TABLE/)
    expect(text).not.toMatch(/flush ruleset/)
    // The owner checks need the loader wired fatally; a "-" prefix is a failure, not a pass.
    expect(text).toContain('has a non-fatal ExecStartPost')
  })

  it('P0.4 requires the plain install to fail because the hostile pnpmfile ran', async () => {
    const text = await readFile(script, 'utf8')
    expect(text).toMatch(/elif \[\[ \$CAPTURED != \*"hostile pnpmfile executed"\* \]\]; then\n.*\n\s*failures\+=\("plain install failed without running the hostile pnpmfile"\)/)
    expect(run(['--dry-run', '--only', 'P0.4']).stdout).toContain("the failure must show 'hostile pnpmfile executed'")
  })

  it('P0.5 never reuses a probe port held by another process', async () => {
    const text = await readFile(script, 'utf8')
    expect(text).not.toMatch(/grep -q \. \|\| start_listener/)
    expect(text).toMatch(/if listener_ours; then return 0; fi\n\s*if port_busy "\$probe_port"; then LISTENER_ERROR=.*already in use by another process/)
    const p05 = text.slice(text.indexOf('p05_run() {'), text.indexOf('# ---------------------------------------------------------------- P0.8'))
    expect(p05).toContain('start_listener || { record $probe BLOCKED "$LISTENER_ERROR"; return; }')
    expect(run(['--dry-run', '--only', 'P0.5']).stdout).toMatch(/held by any other process is BLOCKED, never reused/)
  })

  it('explains why errexit is off', async () => {
    const text = await readFile(script, 'utf8')
    const head = text.slice(0, text.indexOf('set -uo pipefail'))
    expect(head).toMatch(/No `set -e`, deliberately/)
    expect(text).not.toMatch(/^set -[a-z]*e/m)
  })

  it('unsets model credential variables before any probe runs', async () => {
    const text = await readFile(script, 'utf8')
    const block = /^for name in \$\(compgen -e\); do\n[\s\S]*?^unset name$/m.exec(text)
    expect(block).not.toBeNull()
    expect(text.indexOf(block![0])).toBeLessThan(text.indexOf('trap cleanup EXIT'))
    // Run just that block with planted variables and report only which names survive (never values).
    const probe = spawnSync('bash', ['-c', `${block![0]}\nfor n in DSH_MODEL_API_KEY OPENAI_API_KEY DEEPSEEK_API_KEY X_API_KEY ANTHROPIC_AUTH_TOKEN KEEP_ME; do [[ -v $n ]] && echo "$n"; done`],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DSH_MODEL_API_KEY: 'v', OPENAI_API_KEY: 'v', DEEPSEEK_API_KEY: 'v', X_API_KEY: 'v', ANTHROPIC_AUTH_TOKEN: 'v', KEEP_ME: 'v' } })
    expect(probe.stdout.trim().split('\n')).toEqual(['KEEP_ME'])
    expect(run(['--dry-run']).stdout).toMatch(/model credential variables .* are unset before any probe runs/)
  })

  it('never echoes secrets from the environment or arguments', () => {
    const secret = 'sk-p0rehearsalsecret123456'
    const result = run(['--dry-run', '--evidence-dir', `/tmp/${secret}`], { DSH_MODEL_API_KEY: secret })
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(result.stdout).toContain('sk-[REDACTED]')
  })

  it('rejects bad usage', () => {
    for (const args of [['--bogus'], ['--only', 'P0.9'], ['--probe-port', '80'], ['--account', 'a;b'], ['--container', '--dry-run'], ['--evidence-dir', 'relative'],
      ['--market-loader', 'load.sh', '--dry-run'], ['--market-loader', '/x;y', '--dry-run']]) {
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
