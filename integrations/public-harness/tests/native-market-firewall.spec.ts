/** Native market firewall: rendered `inet dsh_market` semantics, the loader script, the installer renderer and the
 * fatal socket wiring. The real-kernel cases run only with NFT_BIN set and an unprivileged user+net namespace. */
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKET_LISTENER_CGROUP, checkMarketRulesFile, marketOwnerArgv, parseMarketListenerCgroup,
  parseMarketOwnerElements, renderMarketRulesFile, renderMarketTable, type MarketEndpoint,
} from '../packages/runtime-systemd/src/market-firewall.ts'
import { renderMarketFirewallFiles, main as renderMain } from '../deploy/native/scripts/render-market-firewall.ts'
import { MARKET_FIREWALL_PATHS, preflight } from '../deploy/native/scripts/host-preflight.ts'

const root = new URL('../', import.meta.url).pathname
const loader = join(root, 'deploy/native/scripts/load-dsh-market.sh')
const json = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8')) as unknown

/** One loopback TCP SYN as `inet dsh_market input` sees it. */
interface Packet { readonly iif: string; readonly dport: number; readonly ctMark: number; readonly listenerCgroup: string }

/** Evaluate the rendered ruleset for one packet. Only the statement shapes the renderer emits are understood; any
 * other rule makes the evaluator throw, so a renderer change cannot silently bypass these semantics. */
function evaluate(script: string, owners: readonly MarketEndpoint[], packet: Packet): 'accept' | 'drop' {
  const define = /^define MARKET_PORTS = (\d+)-(\d+)$/m.exec(script)
  if (define === null) throw new Error('no MARKET_PORTS')
  const [min, max] = [Number(define[1]), Number(define[2])]
  const chains = new Map<string, string[]>()
  for (const line of script.split('\n')) {
    const rule = /^add rule inet dsh_market (\S+) (.*)$/.exec(line)
    if (rule !== null) chains.set(rule[1]!, [...chains.get(rule[1]!) ?? [], rule[2]!])
  }
  const inRange = packet.dport >= min && packet.dport <= max
  const owned = owners.some(row => row.uid === packet.ctMark && row.port === packet.dport)
  const run = (name: string): 'accept' | 'drop' | 'return' => {
    for (const body of chains.get(name) ?? []) {
      let m: RegExpExecArray | null
      if (body === 'iif "lo" tcp dport $MARKET_PORTS jump market_listener') {
        if (packet.iif === 'lo' && inRange) { const verdict = run('market_listener'); if (verdict !== 'return') return verdict }
      } else if (body === 'iif "lo" tcp dport $MARKET_PORTS ct mark . tcp dport != @market_owner drop') {
        if (packet.iif === 'lo' && inRange && !owned) return 'drop'
      } else if ((m = /^socket cgroupv2 level (\d+) "([^"]+)" return$/.exec(body)) !== null) {
        if (packet.listenerCgroup.split('/').slice(0, Number(m[1])).join('/') === m[2]) return 'return'
      } else if (body === 'drop') return 'drop'
      else throw new Error(`unmodelled rule: ${body}`)
    }
    return 'return'
  }
  return run('input') === 'drop' ? 'drop' : 'accept'
}

describe('rendered inet dsh_market: per-owner isolation', () => {
  const marketPorts = { min: 31_000, max: 31_099 }
  const listener = DEFAULT_MARKET_LISTENER_CGROUP.path
  const owners: MarketEndpoint[] = [{ uid: 1201, port: 31_000 }, { uid: 1202, port: 31_001 }, { uid: 1203, port: 31_099 }]
  const script = renderMarketTable({ marketPorts, listenerCgroup: DEFAULT_MARKET_LISTENER_CGROUP })
  const syn = (ctMark: number, dport: number, extra: Partial<Packet> = {}): Packet => ({ iif: 'lo', dport, ctMark, listenerCgroup: listener, ...extra })

  it('admits each owner to its own port only', () => {
    for (const row of owners) expect(evaluate(script, owners, syn(row.uid, row.port))).toBe('accept')
  })

  it('denies every cross-owner pair', () => {
    for (const from of owners) for (const to of owners) {
      if (from === to) continue
      expect(evaluate(script, owners, syn(from.uid, to.port)), `${from.uid} -> ${to.port}`).toBe('drop')
    }
  })

  it('denies unowned ports, unmarked flows and accounts without an element', () => {
    expect(evaluate(script, owners, syn(1201, 31_050))).toBe('drop')
    expect(evaluate(script, owners, syn(0, 31_000))).toBe('drop')
    expect(evaluate(script, owners, syn(4242, 31_000))).toBe('drop')
    expect(evaluate(script, [], syn(1201, 31_000))).toBe('drop')
  })

  it('denies an owner reaching its port when the listener is not the market socket', () => {
    expect(evaluate(script, owners, syn(1201, 31_000, { listenerCgroup: 'dsh.slice/dsh-user.slice/dsh-user-x.slice/x.service' }))).toBe('drop')
    expect(evaluate(script, owners, syn(1201, 31_000, { listenerCgroup: 'system.slice/dsh-plugins.socket.evil' }))).toBe('drop')
  })

  it('leaves traffic outside the market range and off loopback alone', () => {
    expect(evaluate(script, owners, syn(1201, 29_100))).toBe('accept')
    expect(evaluate(script, owners, syn(1201, 30_999))).toBe('accept')
    expect(evaluate(script, owners, syn(1201, 31_100))).toBe('accept')
    expect(evaluate(script, owners, syn(1201, 31_001, { iif: 'eth0' }))).toBe('accept')
  })
})

const scratch = async (text: string) => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-market-check-')), 'dsh-market.nft')
  await writeFile(path, text)
  return path
}
const loaderCheck = (path: string) => spawnSync('bash', [loader, '--check', path], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })

/** Rendered-file mutations both the TS check and the loader must refuse (S3: the old per-line allowlist let `;`
 * chains, comments and extra rules through). */
function injectedRules(text: string): [string, string][] {
  const table = 'add table inet dsh_market\n'
  return [
    ['semicolon chain on an allowed line', text.replace(table, 'add table inet dsh_market ; flush ruleset\n')],
    ['appended semicolon chain', `${text}add table inet dsh_market ; flush ruleset\n`],
    ['semicolon chain to another table', text.replace(table, `${table}add rule inet dsh_market input accept; add rule inet filter input accept\n`)],
    ['semicolon inside the define', text.replace(/^define MARKET_PORTS = (.*)$/m, 'define MARKET_PORTS = $1 ; flush ruleset')],
    ['semicolon in the listener cgroup', text.replace('"system.slice/dsh-plugins.socket" return', '"system.slice/dsh-plugins.socket" return ; flush ruleset')],
    ['quote break in the listener cgroup', text.replace('"system.slice/dsh-plugins.socket"', '"x" accept ; flush ruleset ; add rule inet dsh_market market_listener socket cgroupv2 level 1 "y"')],
    ['trailing comment', text.replace(table, 'add table inet dsh_market # ; flush ruleset\n')],
    ['extra comment line', text.replace(table, `# hand edited\n${table}`)],
    ['comment line hiding nothing', `${text}# trailing note\n`],
    ['extra allowed-looking rule', `${text}add rule inet dsh_market input iif "lo" accept\n`],
    ['flush ruleset', `${text}flush ruleset\n`],
    ['include', `${text}include "/tmp/x"\n`],
    ['delete table', `${text}delete table inet dsh_market\n`],
    ['foreign table rule', `${text}add rule inet dsh_native input accept\n`],
    ['CRLF line endings', text.replaceAll('\n', '\r\n')],
    ['missing trailing newline', text.slice(0, -1)],
    ['extra blank line', `${text}\n`],
    ['newline split statement', text.replace('add table inet dsh_market\n', 'add table inet\ndsh_market\n')],
    ['leading-zero define', text.replace('= 28672-', '= 028672-')],
    ['level mismatch', text.replace('level 2 "system.slice', 'level 1 "system.slice')],
    ['dot-dot cgroup', text.replace('"system.slice/dsh-plugins.socket"', '"system.slice/.."')],
    ['out-of-range define', text.replace('28672-32767', '28672-40000')],
    ['missing listener drop', text.replace(/^add rule inet dsh_market market_listener drop\n/m, '')],
    ['missing define', text.replace(/^define .*\n/m, '')],
  ]
}

describe('market ruleset file, listener cgroup and owner argv', () => {
  const marketPorts = { min: 28_672, max: 32_767 }

  it('rules file passes its own check and the loader renders the same bytes for every range and cgroup', async () => {
    const text = renderMarketRulesFile({ marketPorts, listenerCgroup: DEFAULT_MARKET_LISTENER_CGROUP })
    expect(checkMarketRulesFile(text, marketPorts)).toEqual([])
    for (const [ports, cgroup] of [[{ min: 1024, max: 1024 }, 'init.scope'], [marketPorts, 'system.slice/dsh-plugins.socket'],
      [{ min: 31_000, max: 31_001 }, 'a/b.c/d:e@f_g-h']] as const) {
      const sample = renderMarketRulesFile({ marketPorts: ports, listenerCgroup: parseMarketListenerCgroup(cgroup) })
      expect(checkMarketRulesFile(sample, ports)).toEqual([])
      const result = loaderCheck(await scratch(sample))
      expect(result.status, result.stderr).toBe(0)
    }
  })

  it('rules check (TS and loader) refuses anything but the exact rendered text', async () => {
    const text = renderMarketRulesFile({ marketPorts, listenerCgroup: DEFAULT_MARKET_LISTENER_CGROUP })
    for (const [name, bad] of injectedRules(text)) {
      expect(checkMarketRulesFile(bad), name).not.toEqual([])
      const result = loaderCheck(await scratch(bad))
      expect(result.status, `${name}: ${result.stderr}`).toBe(2)
      expect(result.stderr, name).toMatch(/refusing/)
    }
    expect(checkMarketRulesFile(text, { min: 28_672, max: 30_000 }).join()).toMatch(/differs from ports.market/)
    expect(checkMarketRulesFile(text.replace(/^.*@market_owner drop\n/m, '')).join()).toMatch(/not the rendered/)
  })

  it('listener cgroup paths are validated and their level derived', () => {
    expect(parseMarketListenerCgroup('init.scope')).toEqual({ path: 'init.scope', level: 1 })
    expect(parseMarketListenerCgroup('system.slice/dsh-plugins.socket')).toEqual({ path: 'system.slice/dsh-plugins.socket', level: 2 })
    for (const bad of ['', '/system.slice', 'a//b', '../x', 'a/./b', 'x"y', 'x\\y', 'a b']) expect(() => parseMarketListenerCgroup(bad), bad).toThrow()
    expect(() => renderMarketTable({ marketPorts, listenerCgroup: { path: 'init.scope', level: 2 } })).toThrow(/level/)
    expect(() => renderMarketTable({ marketPorts: { min: 2, max: 1 }, listenerCgroup: DEFAULT_MARKET_LISTENER_CGROUP })).toThrow()
  })

  it('owner argv adds and deletes uid . port pairs in one nft command', () => {
    expect(marketOwnerArgv('add', [{ uid: 1201, port: 31_000 }, { uid: 1202, port: 31_001 }]))
      .toEqual(['add', 'element', 'inet', 'dsh_market', 'market_owner', '{ 1201 . 31000, 1202 . 31001 }'])
    expect(marketOwnerArgv('delete', [{ uid: 1201, port: 31_000 }])[0]).toBe('delete')
    expect(() => marketOwnerArgv('add', [])).toThrow()
    expect(() => marketOwnerArgv('add', [{ uid: 0, port: 31_000 }])).toThrow()
    expect(() => marketOwnerArgv('add', [{ uid: 1201, port: 70_000 }])).toThrow()
  })

  it('parses the hex mark keys nft prints for market_owner', () => {
    expect(parseMarketOwnerElements('set market_owner {\n\ttype mark . inet_service\n\telements = { 0x000004b1 . 31000,\n\t\t     0x000004b2 . 31001 }\n}'))
      .toEqual([{ uid: 1201, port: 31_000 }, { uid: 1202, port: 31_001 }])
  })
})

describe('render-market-firewall installer step', () => {
  it('renders the rules file and fatal socket unit from the shipped examples', async () => {
    const files = renderMarketFirewallFiles(await json('deploy/native/config/provisioner.json.example'), await json('deploy/native/config/plugins.json.example'))
    expect(files.marketPorts).toEqual({ min: 28_672, max: 32_767 })
    expect(files.rules).toContain('define MARKET_PORTS = 28672-32767')
    expect(files.rules).toContain('socket cgroupv2 level 2 "system.slice/dsh-plugins.socket" return')
    expect(files.socket.match(/^ListenStream=/gm)).toHaveLength(4096)
    expect(files.socket).toMatch(/^ExecStartPost=\/usr\/lib\/dsh-public\/load-dsh-market\.sh \/etc\/dsh-public\/dsh-market\.nft$/m)
    expect(files.socket).not.toMatch(/^ExecStartPost=-/m)
  })

  it('refuses when the market is disabled or the ranges disagree', async () => {
    const provisioner = await json('deploy/native/config/provisioner.json.example') as { provisioner: { ports: Record<string, unknown> } }
    const plugins = await json('deploy/native/config/plugins.json.example') as { ports: Record<string, unknown> }
    const { market: _market, ...withoutMarket } = provisioner.provisioner.ports
    expect(() => renderMarketFirewallFiles({ provisioner: { ...provisioner.provisioner, ports: withoutMarket } }, plugins)).toThrow(/disabled/)
    expect(() => renderMarketFirewallFiles(provisioner, { ports: { market: { min: 28_672, max: 30_000 } } })).toThrow(/differs/)
    expect(() => renderMarketFirewallFiles(provisioner, plugins, { listenerCgroup: '../etc' })).toThrow()
    expect(renderMarketFirewallFiles(provisioner, plugins, { listenerCgroup: 'init.scope' }).rules).toContain('level 1 "init.scope"')
  })

  it('CLI writes both files with tight modes and refuses relative outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-market-render-'))
    const args = [join(root, 'deploy/native/config/provisioner.json.example'), join(root, 'deploy/native/config/plugins.json.example')]
    const write = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    const error = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      expect(await renderMain([...args, '--rules', join(dir, 'm.nft'), '--socket', join(dir, 'p.socket')])).toBe(0)
      expect(await renderMain([...args, '--rules', 'm.nft', '--socket', join(dir, 'q.socket')])).toBe(2)
      expect(await renderMain([args[0]!, '--rules', join(dir, 'x.nft'), '--socket', join(dir, 'x.socket')])).toBe(2)
    } finally { process.stdout.write = write; process.stderr.write = error }
    expect((await stat(join(dir, 'm.nft'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'p.socket'))).mode & 0o777).toBe(0o644)
    expect(checkMarketRulesFile(await readFile(join(dir, 'm.nft'), 'utf8'), { min: 28_672, max: 32_767 })).toEqual([])
  })
})

describe('host preflight market-firewall check', () => {
  const native = async () => ({
    provisioner: await json('deploy/native/config/provisioner.json.example') as { provisioner: Record<string, unknown> },
    nativeOptions: await json('deploy/native/config/native.json.example'),
  })
  const files = async () => renderMarketFirewallFiles(await json('deploy/native/config/provisioner.json.example'), await json('deploy/native/config/plugins.json.example'))
  const marketCheck = async (overrides: { rules?: string; socket?: string; loaderMode?: number; loaderUid?: number; table?: string;
    dropIn?: string; fragment?: string; cat?: 'fail' } = {}) => {
    const { provisioner, nativeOptions } = await native(), rendered = await files()
    const results = await preflight(provisioner.provisioner, nativeOptions, {
      read: async path => path === MARKET_FIREWALL_PATHS.rules ? overrides.rules ?? rendered.rules
        : path === MARKET_FIREWALL_PATHS.socket ? overrides.socket ?? rendered.socket : 'cpu memory pids\n',
      run: (command, args) => {
        if (args.join(' ') === 'list table inet dsh_market') { if (overrides.table === undefined) throw new Error('no table'); return overrides.table }
        if (args.join(' ') === 'cat --no-pager dsh-plugins.socket') {
          if (overrides.cat === 'fail') throw new Error('Unit dsh-plugins.socket not found.')
          const merged = `# ${overrides.fragment ?? MARKET_FIREWALL_PATHS.socket}\n${overrides.socket ?? rendered.socket}`
          return overrides.dropIn === undefined ? merged : `${merged}\n# /etc/systemd/system/dsh-plugins.socket.d/override.conf\n${overrides.dropIn}`
        }
        return 'Enforcement: ON'
      },
      stat: async path => path === MARKET_FIREWALL_PATHS.loader ? { uid: overrides.loaderUid ?? 0, mode: overrides.loaderMode ?? 0o755, file: true } : { uid: 0, mode: 0o600, file: true },
    })
    return results.find(result => result.check === 'market-firewall')
  }

  it('passes with the rendered files and reports whether the table is loaded', async () => {
    expect(await marketCheck()).toMatchObject({ ok: true, detail: expect.stringMatching(/not loaded yet/) })
    expect(await marketCheck({ table: 'ct mark . tcp dport != @market_owner drop' })).toMatchObject({ ok: true, detail: expect.stringMatching(/table loaded/) })
  })

  it('fails on a non-fatal or missing loader hook, a foreign rules file, or a writable loader', async () => {
    const rendered = await files()
    expect((await marketCheck({ socket: rendered.socket.replace('ExecStartPost=/', 'ExecStartPost=-/') }))?.ok).toBe(false)
    expect((await marketCheck({ socket: rendered.socket.replace(/^ExecStartPost=.*$/m, '') }))?.ok).toBe(false)
    expect((await marketCheck({ rules: `${rendered.rules}\nflush ruleset\n` }))?.ok).toBe(false)
    for (const [name, bad] of injectedRules(rendered.rules))
      expect((await marketCheck({ rules: bad }))?.ok, name).toBe(false)
    expect((await marketCheck({ rules: rendered.rules.replace('28672-32767', '28672-30000') }))?.ok).toBe(false)
    expect((await marketCheck({ loaderMode: 0o775 }))?.ok).toBe(false)
    // S7: every listener loopback-only, exactly the ports of ports.market.
    for (const [name, socket] of [
      ['wildcard address', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream=0.0.0.0:28672\n')],
      ['port only', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream=28672\n')],
      ['spaced directive', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream = 0.0.0.0:28672\n')],
      ['missing port', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', '')],
      ['duplicate port', rendered.socket.replace('ListenStream=127.0.0.1:28673\n', 'ListenStream=127.0.0.1:28672\n')],
      ['out-of-range port', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream=127.0.0.1:28671\n')],
      ['reset line', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream=127.0.0.1:28672\nListenStream=\n')],
      ['datagram listener', rendered.socket.replace('ListenStream=127.0.0.1:28672\n', 'ListenStream=127.0.0.1:28672\nListenDatagram=0.0.0.0:28672\n')],
    ] as const) {
      expect(socket, name).not.toBe(rendered.socket)
      expect((await marketCheck({ socket }))?.ok, name).toBe(false)
    }
    expect((await marketCheck({ loaderMode: 0o644 }))?.ok).toBe(false)
    expect((await marketCheck({ loaderUid: 1000 }))?.ok).toBe(false)
  })

  // N3: drop-ins and overriding fragments are part of the unit systemd runs.
  it('checks the merged unit, so a drop-in cannot add a listener, reset them or drop the loader hook', async () => {
    const rendered = await files()
    expect((await marketCheck({ dropIn: '[Socket]\nBacklog=64\n' }))?.ok).toBe(true)
    for (const [name, dropIn] of [
      ['wildcard listener', '[Socket]\nListenStream=0.0.0.0:28672\n'],
      ['extra port', '[Socket]\nListenStream=127.0.0.1:40000\n'],
      ['listener reset', '[Socket]\nListenStream=\nListenStream=0.0.0.0:28672\n'],
      ['loader reset', '[Socket]\nExecStartPost=\n'],
      ['non-fatal loader', `[Socket]\nExecStartPost=-${MARKET_FIREWALL_PATHS.loader} ${MARKET_FIREWALL_PATHS.rules}\n`],
    ] as const) {
      const result = await marketCheck({ dropIn })
      expect(result?.ok, name).toBe(false)
      expect(result?.detail, name).toMatch(/merged with drop-ins/)
    }
    const shadowed = await marketCheck({ fragment: '/run/systemd/system/dsh-plugins.socket' })
    expect(shadowed).toMatchObject({ ok: false, detail: expect.stringMatching(/\/run\/systemd\/system/) })
    expect((await marketCheck({ cat: 'fail' }))?.ok).toBe(false)
    expect(rendered.socket).toContain('ListenStream=127.0.0.1:28672\n')
  })

  it('is skipped when ports.market is not configured', async () => {
    const { provisioner, nativeOptions } = await native()
    const { market: _market, ...ports } = provisioner.provisioner.ports as Record<string, unknown>
    const results = await preflight({ ...provisioner.provisioner, ports }, nativeOptions, { read: async () => '', run: () => '', stat: async () => ({ uid: 0, mode: 0o755, file: true }) })
    expect(results.map(result => result.check)).not.toContain('market-firewall')
  })
})

describe('load-dsh-market.sh', () => {
  it('is executable bash that parses and never uses a non-fatal or ruleset-wide nft command', async () => {
    expect((await stat(loader)).mode & 0o111).not.toBe(0)
    const text = await readFile(loader, 'utf8')
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true)
    expect(text).toMatch(/^set -euo pipefail$/m)
    expect(spawnSync('bash', ['-n', loader]).status).toBe(0)
    expect(text).not.toMatch(/flush ruleset|delete table|printenv|declare -p|set -x|API_KEY/)
  })

  it.skipIf(process.getuid?.() === 0)('refuses to run without root', () => {
    const result = spawnSync('bash', [loader, '/etc/dsh-public/dsh-market.nft'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/root is required/)
  })

  it('refuses bad usage', () => {
    expect(spawnSync('bash', [loader, 'a', 'b'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync('bash', [loader, 'relative.nft'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync('bash', [loader, '--check', 'relative.nft'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync('bash', [loader, '--check', '/nonexistent/dsh-market.nft'], { encoding: 'utf8' }).status).toBe(2)
  })
})

// N2: the loader reads the rules file once into a private copy and only loads that copy; the source and its parent
// directory must be root-owned and writable by root only. A user namespace maps this uid to root; a fake nft records
// what it was given and, on the check pass, overwrites the source as a racing writer would.
const unsharable = spawnSync('unshare', ['-Urn', 'true']).status === 0
describe.skipIf(!unsharable)('load-dsh-market.sh private copy and source permissions (unshare -Urn, fake nft)', () => {
  const sample = renderMarketRulesFile({ marketPorts: { min: 31_000, max: 31_001 }, listenerCgroup: parseMarketListenerCgroup('system.slice/dsh-plugins.socket') })
  const setup = async (dirMode = 0o700, fileMode = 0o600) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-market-copy-'))
    const rules = join(dir, 'dsh-market.nft'), log = join(dir, 'nft.log'), fake = join(dir, 'fake-nft')
    await writeFile(rules, sample)
    await chmod(rules, fileMode)
    await writeFile(fake, [
      '#!/usr/bin/env bash',
      `log=${JSON.stringify(log)}; src=${JSON.stringify(rules)}`,
      'printf "%s\\n" "$*" >>"$log"',
      'case "$1 $2" in',
      '  "-c -f") printf "add table inet dsh_market ; flush ruleset\\n" >"$src" ;;',
      '  "-f "*) printf "loaded-dir=%s\\n" "$(dirname "$2")" >>"$log"; cmp -s "$2" <(printf "%s" "$EXPECTED") && echo copy-intact >>"$log" ;;',
      'esac',
      'case "$*" in',
      '  "list chain inet dsh_market input") echo "ct mark . tcp dport != @market_owner drop" ;;',
      '  "list chain inet dsh_market market_listener") printf "socket cgroupv2 level 2 \\"x/y\\" return\\n\\tdrop\\n" ;;',
      'esac',
    ].join('\n'), { mode: 0o755 })
    await chmod(dir, dirMode)
    return { dir, rules, log, fake }
  }
  const run = (rules: string, fake: string) => spawnSync('unshare', ['-Urn', 'bash', loader, rules], {
    encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', DSH_NFT: fake, EXPECTED: sample, TMPDIR: tmpdir() } })

  it('checks and loads one private copy, so swapping the source after the read changes nothing', async () => {
    const { dir, rules, log, fake } = await setup()
    const result = run(rules, fake)
    expect(result.status, result.stderr).toBe(0)
    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    const checked = lines.find(line => line.startsWith('-c -f '))!.slice('-c -f '.length)
    const loaded = lines.find(line => /^-f /.test(line))!.slice('-f '.length)
    expect(checked).toBe(loaded)
    expect(loaded).not.toBe(rules)
    expect(loaded.startsWith(`${dir}/`)).toBe(false)
    expect(lines).toContain('copy-intact')
    // The work directory is removed on exit.
    expect(spawnSync('test', ['-e', loaded]).status).not.toBe(0)
  })

  it('refuses a source whose parent directory or file is group- or world-writable', async () => {
    for (const [dirMode, fileMode] of [[0o770, 0o600], [0o707, 0o600], [0o700, 0o620], [0o700, 0o602]] as const) {
      const { rules, log, fake } = await setup(dirMode, fileMode)
      const result = run(rules, fake)
      expect(result.status, `${dirMode.toString(8)} ${fileMode.toString(8)}`).toBe(2)
      expect(result.stderr).toMatch(/group- or world-writable/)
      expect(spawnSync('test', ['-e', log]).status).not.toBe(0)
    }
  })

  it('refuses a source in a directory not owned by root', () => {
    // /tmp belongs to the host root, which is unmapped (nobody) inside the namespace.
    const result = spawnSync('unshare', ['-Urn', 'bash', loader, join(tmpdir(), 'dsh-market-none.nft')], { encoding: 'utf8' })
    expect(result.status).toBe(2)
  })
})

// Real kernel: a user+net namespace maps this uid to 0, so the loader runs as "root" against a private ruleset.
const nft = process.env.NFT_BIN
const userns = nft !== undefined && spawnSync('unshare', ['-Urn', 'true']).status === 0
const ownCgroup = (() => { try { return /^0::\/(.+)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1] } catch { return undefined } })()

describe.skipIf(!userns)('load-dsh-market.sh against a real nftables (NFT_BIN, unshare -Urn)', () => {
  const inNamespace = (script: string) => spawnSync('unshare', ['-Urn', 'bash', '-c', script], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, DSH_NFT: nft!, NFT: nft! } })
  const rulesFile = async (text: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-market-nft-'))
    const path = join(dir, 'dsh-market.nft')
    await writeFile(path, text, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }
  const listener = parseMarketListenerCgroup(ownCgroup ?? 'init.scope')
  const marketPorts = { min: 31_000, max: 31_001 }

  it('loads atomically, is idempotent, keeps market_owner across reloads and leaves state unchanged on failure', async () => {
    const good = await rulesFile(renderMarketRulesFile({ marketPorts, listenerCgroup: listener }))
    // Structurally exact but naming a cgroup that does not exist, so nft itself rejects it (exit 1, nothing changed).
    const broken = await rulesFile(renderMarketRulesFile({ marketPorts: { min: 31_000, max: 31_005 }, listenerCgroup: parseMarketListenerCgroup('no-such-dsh.slice/none.scope') }))
    const foreign = await rulesFile(renderMarketRulesFile({ marketPorts, listenerCgroup: listener }).replace('add table inet dsh_market\n', 'add table inet dsh_market ; flush ruleset\n'))
    const result = inNamespace([
      `"${loader}" "${good}" || exit 10`,
      '"$NFT" add element inet dsh_market market_owner "{ 1201 . 31000 }"',
      `"${loader}" "${good}" || exit 11`,
      `"${loader}" "${broken}"; echo "broken=$?"`,
      `"${loader}" "${foreign}"; echo "foreign=$?"`,
      '"$NFT" list table inet dsh_market',
    ].join('\n'))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('broken=1')
    expect(result.stdout).toContain('foreign=2')
    expect(result.stdout).toMatch(/elements = \{ 0x000004b1 \. 31000 \}/)
    expect(result.stdout).toContain('tcp dport 31000-31001 jump market_listener')
    expect(result.stdout).not.toContain('31000-31005')
    expect((result.stdout.match(/@market_owner drop/g) ?? []).length).toBe(1)
    expect(result.stderr).not.toMatch(/API_KEY/)
  })

  it.skipIf(ownCgroup === undefined)('denies cross-owner connections on a real loopback (marks simulated per source port)', async () => {
    const rules = await rulesFile(renderMarketRulesFile({ marketPorts, listenerCgroup: listener }))
    // dsh_native would set ct mark from meta skuid; without extra uids in the namespace a test-only table marks new
    // flows by source port instead: 40001 acts as uid 1201, 40002 as uid 1202, 40003 as an account with no element.
    const probe = `const net = require('node:net')
const servers = [31000, 31001].map(port => net.createServer(socket => socket.destroy()).listen(port, '127.0.0.1'))
const attempt = (localPort, port) => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port, localPort, localAddress: '127.0.0.1', timeout: 700 })
  socket.on('connect', () => { socket.destroy(); resolve('connect') })
  socket.on('timeout', () => { socket.destroy(); resolve('denied') })
  socket.on('error', () => resolve('denied'))
})
setTimeout(async () => {
  for (const [from, to] of [[40001, 31000], [40002, 31001], [40002, 31000], [40001, 31001], [40003, 31000]]) console.log(from + '>' + to + '=' + await attempt(from, to))
  servers.forEach(server => server.close())
}, 100)`
    const result = inNamespace([
      'ip link set lo up 2>/dev/null || true',
      `"${loader}" "${rules}" || exit 10`,
      '"$NFT" add table inet probe',
      '"$NFT" add chain inet probe out "{ type filter hook output priority filter; }"',
      '"$NFT" add rule inet probe out ct state new tcp sport 40001 ct mark set 1201',
      '"$NFT" add rule inet probe out ct state new tcp sport 40002 ct mark set 1202',
      '"$NFT" add element inet dsh_market market_owner "{ 1201 . 31000, 1202 . 31001 }"',
      `"${process.execPath}" -e "$PROBE"`,
    ].join('\n').replace('"$PROBE"', `'${probe.replaceAll("'", "'\\''")}'`))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['40001>31000=connect', '40002>31001=connect', '40002>31000=denied', '40001>31001=denied', '40003>31000=denied'])
  })
})
