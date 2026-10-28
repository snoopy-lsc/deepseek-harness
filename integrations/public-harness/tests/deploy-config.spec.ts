import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parse, parseDocument, type Document } from 'yaml'
import { describe, expect, it } from 'vitest'
import { collectConfigFacts } from '../deploy/release-check.ts'
import { DEFAULT_RUNTIME, FROZEN_RUNTIMES, PRODUCTION_PROFILES, RUNTIME_PROVIDERS, writeProductionProfile } from '../deploy/production-profile.ts'
import { portRangesOverlap } from '../packages/contracts/src/ports.ts'
import { parseAnyReleaseManifest, requireRuntime } from '../deploy/native-release.ts'
import { resolveContainerConfig } from '../packages/provisioner/src/config.ts'
import { INSTANCE_USER } from '../packages/provisioner/src/runtime.ts'
import { networkArgument } from '../packages/provisioner/src/limits.ts'
import { parseProvisionerProfileConfig } from '../packages/production/src/provisioner-service.ts'
import { parseQuotaProfileConfig } from '../packages/production/src/quota-service.ts'
import { parseTeamRouterConfig } from '../packages/production/src/team-router.ts'
import { parseIdentityConfig } from '../packages/identity/src/config.ts'
import { parseSystemdConfig } from '../packages/runtime-systemd/src/config.ts'
import { parseKbProfileConfig } from '../packages/production/src/kb-service.ts'
import { parseKbRootConfig } from '../packages/production/src/kb-root-helper.ts'
import { preflight } from '../deploy/native/scripts/host-preflight.ts'

const root = new URL('../', import.meta.url).pathname
const text = (path: string): Promise<string> => readFile(join(root, path), 'utf8')
const json = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await text(path)) as Record<string, unknown>

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]))
  return nested.flat()
}

const tags = ['!Env', '!KeyOf', '!Find', '!Format'].map(tag => ({ tag, resolve: (value: unknown) => value }))

describe('production configuration examples', () => {
  it('parse with the same strict validators the services use', async () => {
    expect(parseTeamRouterConfig(await json('deploy/production/config/router.example.json')).routerSocket).toBe('/run/dsh-public/router/router.sock')
    expect(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner.limits.pids).toBeGreaterThan(0)
    expect(parseQuotaProfileConfig(await json('deploy/production/config/quota.example.json')).service.siteDailyTokens).toBeGreaterThan(0)
  })

  it('loads the image archive that build-image.sh exports', async () => {
    const provisioner = resolveContainerConfig(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner)
    expect(provisioner.imageArchive).toBeDefined()
    const script = await text('deploy/production/scripts/build-image.sh')
    expect(script).toContain(`archive=\${3:-${provisioner.imageArchive}}`)
    expect(script).toMatch(/podman save --format docker-archive/)
    expect(script).toMatch(/chmod 0644/)
  })

  it('selects the pasta stack and leaves its options (--no-splice, host loopback) to the provisioner', async () => {
    const provisioner = resolveContainerConfig(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner)
    expect(provisioner.limits.network).toBe('pasta')
    expect(networkArgument(provisioner.limits.network, provisioner.quota.hostAddress)).toContain('--no-splice')
  })

  it('contain no secrets, public binds, or non-private addresses', async () => {
    for (const path of await files('deploy/production')) {
      const body = await text(path)
      expect(body, path).not.toMatch(/(?<![0-9.])0\.0\.0\.0(?![0-9])|\[::\]/)
      expect(body, path).not.toMatch(/sk-[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{12,}/)
    }
  })

  it('pins bundle versions that match the workspace packages and keeps enrollment closed', async () => {
    const manifest = parseAnyReleaseManifest(await json('deploy/release-manifest.json'))
    const container = requireRuntime(parseAnyReleaseManifest(await json('deploy/production/release-manifest.json')), 'podman-gvisor')
    expect(manifest.publicEnrollment).toBe('closed')
    expect(container.publicEnrollment).toBe('closed')
    for (const [name, version] of Object.entries(manifest.bundles)) {
      const directory = name.replace('@public-harness/', '')
      expect((await json(`packages/${directory}/package.json`)).version, name).toBe(version)
    }
    const packages = (await readdir(join(root, 'packages'))).filter(name => name !== 'node_modules')
    expect(Object.keys(manifest.bundles).map(name => name.replace('@public-harness/', '')).sort()).toEqual(packages.sort())
    expect(container.runtime.image).toBe((await json('deploy/production/config/provisioner.example.json') as { provisioner: { runtime: { image: string } } }).provisioner.runtime.image)
  })
})

describe('Caddy edge', () => {
  it('authenticates every request, strips identity headers first, and forwards only to the router socket', async () => {
    const facts = collectConfigFacts({ caddyfile: await text('deploy/production/Caddyfile'), router: await json('deploy/production/config/router.example.json'),
      provisioner: await json('deploy/production/config/provisioner.example.json'), quota: await json('deploy/production/config/quota.example.json'),
      blueprint: await text('deploy/authentik/public-harness.yaml'), manifestEnrollment: 'closed' })
    expect(facts).toEqual({ caddyForwardAuth: true, caddyStripsIdentityHeaders: true, caddyUnixUpstream: true, caddyAdminPrivate: true, caddyKeepsHostPort: true, routerSecureUnixIngress: true,
      limitsConfigured: true, quotaPositiveLimits: true, enrollmentRequiresVerification: true, enrollmentClosedInManifest: true })
  })

  it('never exposes the admin API over TCP and keeps the Host port', async () => {
    const caddyfile = await text('deploy/production/Caddyfile')
    const admin = caddyfile.split('\n').filter(line => /^\s*admin\s/.test(line))
    expect(admin).toHaveLength(1)
    expect(admin[0]).toMatch(/^\s*admin (?:off|unix\/\/[^\s|]+(?:\|0[0-7]{3})?)\s*$/)
    expect(caddyfile).toMatch(/header_up Host \{hostport\}/)
    expect(caddyfile).not.toMatch(/2019/)
    expect(await text('deploy/production/caddy-dropin/dsh-public.conf')).toMatch(/^RuntimeDirectory=caddy$/m)
  })

  const caddy = process.env.CADDY_BIN
  it.skipIf(caddy === undefined)('is accepted by the real Caddy adapter with the documented environment', async () => {
    const adapted = spawnSync(caddy!, ['adapt', '--config', join(root, 'deploy/production/Caddyfile'), '--adapter', 'caddyfile'], { encoding: 'utf8',
      env: { PATH: process.env.PATH, DSH_PUBLIC_HOST: 'harness.example.test', DSH_ACME_EMAIL: 'ops@example.test', DSH_OUTPOST_ADDR: '127.0.0.1:9000', DSH_ROUTER_SOCKET: '/run/dsh-public/router/router.sock' } })
    expect(adapted.status, adapted.stderr).toBe(0)
    const server = Object.values((JSON.parse(adapted.stdout) as { apps: { http: { servers: Record<string, { routes: unknown[] }> } } }).apps.http.servers)[0]!
    const handlers: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>
        if (typeof record.handler === 'string') handlers.push(record.handler === 'headers' ? `headers:${JSON.stringify((record.request as { delete?: string[] } | undefined)?.delete ?? [])}` : `${record.handler}:${JSON.stringify(record.upstreams ?? '')}`)
        Object.values(record).forEach(walk)
      }
    }
    walk(server.routes)
    const strip = handlers.findIndex(item => item.startsWith('headers:["X-Authentik-Uid"]'))
    const router = handlers.findIndex(item => item.includes('unix//run/dsh-public/router/router.sock'))
    // The admin API is Unix-only and Host keeps its port.
    expect(JSON.parse(adapted.stdout).admin.listen).toMatch(/^unix\//)
    expect(adapted.stdout).toContain('{http.request.hostport}')
    expect(strip).toBeGreaterThanOrEqual(0)
    expect(router).toBeGreaterThan(strip)
  })
})

describe('authentik blueprint', () => {
  const load = async (): Promise<Document.Parsed> => {
    const document = parseDocument(await text('deploy/authentik/public-harness.yaml'), { customTags: tags as never })
    expect(document.errors).toEqual([])
    return document
  }

  it('defines a verified, CAPTCHA-protected enrollment whose references all resolve', async () => {
    const document = await load()
    const entries = (document.toJS() as { entries: Array<{ model: string; id?: string; attrs?: Record<string, unknown>; identifiers: Record<string, unknown> }> }).entries
    const ids = new Set(entries.flatMap(entry => entry.id ? [entry.id] : []))
    const refs: string[] = []
    const collect = (node: unknown): void => {
      if (isScalar(node) && node.tag === '!KeyOf') refs.push(String(node.value))
      else if (isSeq(node) || isMap(node)) for (const item of node.items) collect(isMap(node) ? (item as { value: unknown }).value : item)
    }
    collect(document.contents)
    expect(refs.length).toBeGreaterThan(5)
    for (const reference of refs) expect(ids.has(reference), reference).toBe(true)
    const stages = entries.filter(entry => entry.model === 'authentik_flows.flowstagebinding').length
    expect(stages).toBe(5)
    const attrs = (model: string): Record<string, unknown> => entries.find(entry => entry.model === model)!.attrs!
    expect(attrs('authentik_stages_user_write.userwritestage').create_users_as_inactive).toBe(true)
    expect(attrs('authentik_stages_email.emailstage').activate_user_on_success).toBe(true)
    expect(attrs('authentik_providers_proxy.proxyprovider').sub_mode).toBe('hashed_user_id')
    expect(attrs('authentik_providers_proxy.proxyprovider').mode).toBe('forward_single')
    expect(attrs('authentik_flows.flow').authentication).toBe('require_unauthenticated')
  })

  it('reads keys from the environment and never embeds them', async () => {
    const body = await text('deploy/authentik/public-harness.yaml')
    expect(body).toMatch(/public_key: !Env DSH_CAPTCHA_SITE_KEY/)
    expect(body).toMatch(/private_key: !Env DSH_CAPTCHA_SECRET_KEY/)
    expect(parse(await text('deploy/authentik/brand.yml'), { customTags: tags as never }).entries[0].attrs.branding_title).toBe('Team Harness')
  })
})

describe('host artifacts', () => {
  it('confines each service unit and keeps the router off TCP', async () => {
    const router = await text('deploy/production/systemd/dsh-router.service')
    expect(router).toMatch(/^User=dsh-router$/m)
    expect(router).toMatch(/^RestrictAddressFamilies=AF_UNIX$/m)
    expect(router).toMatch(/^NoNewPrivileges=yes$/m)
    expect(router).toMatch(/^ProtectSystem=strict$/m)
    const quota = await text('deploy/production/systemd/dsh-quota.service')
    expect(quota).toMatch(/^User=dsh-quota$/m)
    expect(quota).toMatch(/^NoNewPrivileges=yes$/m)
    const provisioner = await text('deploy/production/systemd/dsh-provisioner.service')
    expect(provisioner).toMatch(/^User=root$/m)
    expect(provisioner).toMatch(/^ProtectSystem=strict$/m)
    // A systemd-managed RuntimeDirectory would delete the router's sockets when the provisioner stops.
    expect(provisioner).not.toMatch(/^RuntimeDirectory=/m)
  })

  it('runs every unit from a generated profile that exists', async () => {
    for (const [unit, profile] of [['dsh-router', 'team-router'], ['dsh-provisioner', 'provisioner'], ['dsh-quota', 'quota']] as const) {
      expect(await text(`deploy/production/systemd/${unit}.service`)).toContain(`--profile ${profile}`)
      expect(profile in PRODUCTION_PROFILES).toBe(true)
    }
  })

  it('loads the egress table the provisioner requires and drops by default', async () => {
    const nft = await text('deploy/production/nftables/dsh-public.nft')
    expect(nft).toMatch(/table inet dsh_instances \{/)
    expect(nft).toMatch(/169\.254\.0\.0\/16/)
    expect(nft).toMatch(/counter drop\n/)
    expect(nft).toMatch(/oif "lo" drop/)
  })

  /** Active rule lines of the output chain, in evaluation order. */
  const rules = async (): Promise<string[]> => (await text('deploy/production/nftables/dsh-public.nft')).split('\n')
    .map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#') && /^(meta|ct|oif|ip6?|tcp|udp|counter)\b/.test(line))

  it('accepts the resolvers before it drops private ranges, so a private resolver keeps working', async () => {
    const list = await rules()
    const at = (pattern: RegExp): number => list.findIndex(line => pattern.test(line))
    const resolverUdp = at(/^ip daddr \$RESOLVERS udp dport 53 accept$/)
    const resolverTcp = at(/^ip daddr \$RESOLVERS tcp dport 53 accept$/)
    const privateDrop = at(/^ip daddr \{[^}]*10\.0\.0\.0\/8[^}]*\} drop$/)
    const webAccept = at(/^tcp dport \{ 80, 443 \} accept$/)
    const finalDrop = at(/^counter drop$/)
    expect(resolverUdp).toBeGreaterThanOrEqual(0)
    expect(resolverTcp).toBeGreaterThanOrEqual(0)
    expect(privateDrop).toBeGreaterThan(resolverUdp)
    expect(privateDrop).toBeGreaterThan(resolverTcp)
    // Web egress is accepted only after the private ranges were dropped, and the table ends in a drop.
    expect(webAccept).toBeGreaterThan(privateDrop)
    expect(finalDrop).toBe(list.length - 1)
  })

  it('allows instances only the quota listener range on loopback and keeps all three configurations in step', async () => {
    const file = await text('deploy/production/nftables/dsh-public.nft')
    const defined = /^define QUOTA_PORTS = (\d+)-(\d+)$/m.exec(file)
    expect(defined).not.toBeNull()
    const range = { min: Number(defined![1]), max: Number(defined![2]) }
    const provisioner = resolveContainerConfig(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner)
    const quota = parseQuotaProfileConfig(await json('deploy/production/config/quota.example.json')).service
    expect(quota.listenPorts).toEqual(range)
    expect(provisioner.ports.quota).toEqual(range)
    // The sidecar range is published for the host-side forwarder only; instances must not be able to reach it.
    expect(portRangesOverlap(provisioner.ports.sidecar, range)).toBe(false)
    const loopback = (await rules()).filter(line => line.startsWith('oif "lo"'))
    // Market accept (Q7) sits with quota before the final loopback drop; covered in detail below.
    expect(loopback[0]).toBe('oif "lo" ip daddr 127.0.0.1 tcp dport $QUOTA_PORTS accept')
    expect(loopback.at(-1)).toBe('oif "lo" drop')
    expect(file).not.toMatch(/1024-65535/)
    expect(file).not.toContain(String(provisioner.ports.sidecar.min))
  })

  describe('plugin market firewall (Q7)', () => {
    it('accepts MARKET_PORTS on loopback before the final lo drop and matches ports.market', async () => {
      const file = await text('deploy/production/nftables/dsh-public.nft')
      const defined = /^define MARKET_PORTS = (\d+)-(\d+)$/m.exec(file)
      expect(defined).not.toBeNull()
      const market = { min: Number(defined![1]), max: Number(defined![2]) }
      expect(market.max - market.min + 1).toBeLessThanOrEqual(4096)
      const provisioner = resolveContainerConfig(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner)
      expect(provisioner.ports.market).toEqual(market)
      expect(portRangesOverlap(provisioner.ports.quota, market)).toBe(false)
      expect(portRangesOverlap(provisioner.ports.sidecar, market)).toBe(false)
      const loopback = (await rules()).filter(line => line.startsWith('oif "lo"'))
      expect(loopback).toEqual([
        'oif "lo" ip daddr 127.0.0.1 tcp dport $QUOTA_PORTS accept',
        'oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept',
        'oif "lo" drop',
      ])
      // Phase 2 only: do not land egress_locked drops here.
      expect(file).not.toMatch(/egress_locked/)
    })

    it('keeps dsh-plugins-fetch to egressPort only', async () => {
      const file = await text('deploy/production/nftables/dsh-public.nft')
      expect(file).toMatch(/^define EGRESS_PORT = \d+$/m)
      expect(file).toMatch(/^define PLUGINS_FETCH_UID = /m)
      expect(file).toContain('meta skuid $PLUGINS_FETCH_UID ip daddr 127.0.0.1 tcp dport $EGRESS_PORT accept')
      expect(file).toContain('meta skuid $PLUGINS_FETCH_UID drop')
      const list = await rules()
      const fetchAccept = list.findIndex(line => /meta skuid \$PLUGINS_FETCH_UID.*EGRESS_PORT accept/.test(line))
      const fetchDrop = list.findIndex(line => line === 'meta skuid $PLUGINS_FETCH_UID drop')
      const instanceMin = list.findIndex(line => line.startsWith('meta skuid < $INSTANCE_UID_MIN'))
      expect(fetchAccept).toBeGreaterThanOrEqual(0)
      expect(fetchDrop).toBeGreaterThan(fetchAccept)
      // Fetch rules must run before the instance-UID early accepts, or the fetch UID would fall through.
      expect(instanceMin).toBeGreaterThan(fetchDrop)
    })

    it('ships a separately loaded dsh_market table with listener and owner-drop chains', async () => {
      const market = await text('deploy/production/nftables/dsh-market.nft')
      const publicNft = await text('deploy/production/nftables/dsh-public.nft')
      expect(market).toMatch(/table inet dsh_market \{/)
      expect(market).toMatch(/set market_owner \{[\s\S]*?type uid \. inet_service/)
      expect(market).toMatch(/chain market_listener/)
      expect(market).toMatch(/chain input \{[\s\S]*?type filter hook input priority filter - 2/)
      expect(market).toMatch(/chain output \{[\s\S]*?type filter hook output priority filter - 2/)
      expect(market).toContain('iif "lo" tcp dport $MARKET_PORTS jump market_listener')
      expect(market).toContain('oif "lo" tcp dport $MARKET_PORTS meta skuid . tcp dport != @market_owner drop')
      expect(market).toMatch(/socket cgroupv2 level \d+ "/)
      expect(market).toMatch(/^define MARKET_PORTS = (\d+)-(\d+)$/m)
      const defined = /^define MARKET_PORTS = (\d+)-(\d+)$/m.exec(market)!
      const range = { min: Number(defined[1]), max: Number(defined[2]) }
      expect(range.max - range.min + 1).toBeLessThanOrEqual(4096)
      const provisioner = resolveContainerConfig(parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner)
      expect(provisioner.ports.market).toEqual(range)
      // Never defines/loads the market table; comments may name it as a separate file.
      expect(publicNft).not.toMatch(/table\s+inet\s+dsh_market/)
      expect(publicNft).not.toMatch(/add\s+table\s+inet\s+dsh_market/)
      expect(publicNft).not.toContain('include "dsh-market.nft"')
      expect(publicNft).not.toContain('include "/etc/nftables.d/dsh-market.nft"')
      const readme = await text('deploy/production/README.md')
      expect(readme).toMatch(/ExecStartPost=-/)
      expect(readme).toMatch(/dsh-market\.nft|dsh_market/)
      expect(readme).not.toMatch(/nft -f [^\n]*dsh-market\.nft/)
    })

    it('records the Q7 market-range firewall exception in the production README', async () => {
      const readme = await text('deploy/production/README.md')
      expect(readme.toLowerCase()).toMatch(/market[- ]range/)
      expect(readme).toMatch(/market_owner|per-user/)
      expect(readme).toMatch(/receiving-socket|receiving socket|socket cgroup/i)
      expect(readme).toMatch(/dsh-router/)
      expect(readme).toMatch(/dsh-identity/)
      expect(readme).toMatch(/flush ruleset/)
      expect(readme).toMatch(/peer check|inet_diag/i)
      expect(readme).toMatch(/MARKET_PORTS|ports\.market/)
    })
  })

  const nft = process.env.NFT_BIN
  it.skipIf(nft === undefined)('is accepted by the real nft parser', () => {
    // `nft -c` needs CAP_NET_ADMIN, so it runs inside an unprivileged user and network namespace.
    const checked = spawnSync('unshare', ['-Urn', nft!, '-c', '-f', join(root, 'deploy/production/nftables/dsh-public.nft')], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
  })

  it.skipIf(nft === undefined)('accepts the market table file with the real nft parser', () => {
    const checked = spawnSync('unshare', ['-Urn', nft!, '-c', '-f', join(root, 'deploy/production/nftables/dsh-market.nft')], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
  })

  it('mounts /proc with hidepid, exempting only the dsh-procview group and logind', async () => {
    const sysusers = await text('deploy/production/systemd/sysusers.conf')
    expect(sysusers).toMatch(/^g dsh-procview -$/m)
    expect(sysusers).not.toMatch(/^m \S+ dsh-procview/m)
    expect(await text('deploy/production/logind-dropin/dsh-public.conf')).toMatch(/^SupplementaryGroups=dsh-procview$/m)
    const enable = await text('deploy/production/scripts/enable-hidepid.sh')
    expect(enable).toContain('group=dsh-procview')
    expect(enable).toContain('options="nosuid,nodev,noexec,hidepid=2,gid=$gid"')
    expect(enable).toMatch(/proc \/proc proc \$options 0 0/)
    expect(enable).toMatch(/mount -o "remount,\$options" \/proc/)
    expect(enable).toContain('verify-hidepid.sh')
  })

  describe('enable-hidepid.sh', () => {
    const enable = async (fstabText: string, runs: number): Promise<{ fstab: string; backup: string | undefined; statuses: Array<number | null>; dropin: string }> => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-enable-'))
      const bin = join(dir, 'bin')
      await mkdir(bin)
      const stub = async (name: string, body: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }) }
      await stub('getent', 'echo "dsh-procview:x:991:"')
      await stub('systemctl', 'true')
      await stub('mount', 'true')
      await stub('findmnt', 'echo "rw,nosuid,nodev,noexec,relatime,hidepid=invisible,gid=991"')
      const fstab = join(dir, 'fstab')
      await writeFile(fstab, fstabText)
      const statuses: Array<number | null> = []
      for (let run = 0; run < runs; run += 1) {
        statuses.push(spawnSync('bash', [join(root, 'deploy/production/scripts/enable-hidepid.sh')],
          { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, DSH_FSTAB: fstab, DSH_SYSTEMD_DIR: join(dir, 'systemd') } }).status)
      }
      return { fstab: await readFile(fstab, 'utf8'), backup: await readFile(`${fstab}.dsh-backup`, 'utf8').catch(() => undefined), statuses,
        dropin: await readFile(join(dir, 'systemd/systemd-logind.service.d/dsh-public.conf'), 'utf8') }
    }
    const original = 'UUID=abc / ext4 defaults 0 1\nproc /proc proc defaults 0 0\n'

    it('writes one hidepid line and keeps the original fstab as the backup', async () => {
      const result = await enable(original, 1)
      expect(result.statuses).toEqual([0])
      expect(result.backup).toBe(original)
      expect(result.fstab.split('\n').filter(line => line.startsWith('proc /proc'))).toEqual(['proc /proc proc nosuid,nodev,noexec,hidepid=2,gid=991 0 0'])
      expect(result.fstab).toContain('UUID=abc / ext4 defaults 0 1')
      expect(result.dropin).toContain('SupplementaryGroups=dsh-procview')
    })

    it('never overwrites the backup on later runs, and stays idempotent', async () => {
      const result = await enable(original, 3)
      expect(result.statuses).toEqual([0, 0, 0])
      expect(result.backup).toBe(original)
      expect(result.backup).not.toContain('hidepid')
      expect(result.fstab.split('\n').filter(line => line.startsWith('proc /proc'))).toHaveLength(1)
      expect(result.fstab.match(/UUID=abc/g)).toHaveLength(1)
    })

    it('keeps an existing backup even when the live fstab was edited in between', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-enable-'))
      const fstab = join(dir, 'fstab')
      await writeFile(fstab, original)
      await writeFile(`${fstab}.dsh-backup`, 'ORIGINAL-OF-RECORD\n')
      const bin = join(dir, 'bin')
      await mkdir(bin)
      for (const [name, body] of [['getent', 'echo "dsh-procview:x:991:"'], ['systemctl', 'true'], ['mount', 'true'],
        ['findmnt', 'echo "hidepid=2,gid=991"']] as const) await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
      const status = spawnSync('bash', [join(root, 'deploy/production/scripts/enable-hidepid.sh')],
        { env: { PATH: `${bin}:/usr/bin:/bin`, DSH_FSTAB: fstab, DSH_SYSTEMD_DIR: join(dir, 'systemd') } }).status
      expect(status).toBe(0)
      expect(await readFile(`${fstab}.dsh-backup`, 'utf8')).toBe('ORIGINAL-OF-RECORD\n')
    })

    it('fails closed without touching fstab when the group is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-enable-'))
      const bin = join(dir, 'bin')
      await mkdir(bin)
      await writeFile(join(bin, 'getent'), '#!/bin/bash\nexit 2\n', { mode: 0o755 })
      const fstab = join(dir, 'fstab')
      await writeFile(fstab, original)
      const result = spawnSync('bash', [join(root, 'deploy/production/scripts/enable-hidepid.sh')],
        { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, DSH_FSTAB: fstab, DSH_SYSTEMD_DIR: join(dir, 'systemd') } })
      expect(result.status).toBe(1)
      expect(await readFile(fstab, 'utf8')).toBe(original)
    })
  })

  describe('verify-hidepid.sh', () => {
    const run = async (env: Record<string, string>, ...accounts: string[]): Promise<{ status: number | null; stderr: string; stdout: string }> => {
      const bin = await mkdtemp(join(tmpdir(), 'dsh-stubs-'))
      const stub = async (name: string, body: string): Promise<void> => { await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }) }
      await stub('findmnt', 'echo "$FAKE_OPTIONS"')
      await stub('getent', 'echo "dsh-procview:x:991:"')
      await stub('id', 'if [ "$1" = -u ]; then echo 2001; else echo "$FAKE_GROUPS"; fi')
      await stub('runuser', 'shift 3; exec "$@"')
      await stub('ps', 'printf "%s" "$FAKE_PS"')
      const subuid = join(bin, 'subuid')
      await writeFile(subuid, env.FAKE_SUBUID ?? '')
      const result = spawnSync('bash', [join(root, 'deploy/production/scripts/verify-hidepid.sh'), ...accounts],
        { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_GROUPS: 'dsh-instances', FAKE_PS: '2001 sleep 1\n', DSH_SUBUID_FILE: subuid, ...env } })
      return { status: result.status, stderr: result.stderr, stdout: result.stdout }
    }
    const hidden = 'rw,nosuid,nodev,noexec,relatime,hidepid=invisible,gid=991'

    it('passes when /proc hides other users and the account sees only itself', async () => {
      expect((await run({ FAKE_OPTIONS: hidden }, 'dsh-abc')).status).toBe(0)
      expect((await run({ FAKE_OPTIONS: 'rw,nosuid,hidepid=2,gid=991' })).status).toBe(0)
    })

    describe('rootless sandbox processes under the account\'s own subuid range', () => {
      const own = 'dsh-abc:165536:65536\ndsh-def:231072:65536\n'
      const ps = (...uids: number[]): string => ['2001 podman run x', ...uids.map(uid => `${uid} runsc-sandbox`)].join('\n') + '\n'

      it('does not count them as another user, including both ends of the range', async () => {
        for (const uid of [165536, 200000, 231071]) {
          expect((await run({ FAKE_OPTIONS: hidden, FAKE_SUBUID: own, FAKE_PS: ps(uid) }, 'dsh-abc')).status, String(uid)).toBe(0)
        }
        expect((await run({ FAKE_OPTIONS: hidden, FAKE_SUBUID: own, FAKE_PS: ps(165536, 165537, 231071) }, 'dsh-abc')).status).toBe(0)
        // Entries keyed by numeric uid count too, and several entries for one account add up.
        expect((await run({ FAKE_OPTIONS: hidden, FAKE_SUBUID: '2001:300000:10\ndsh-abc:165536:2\n', FAKE_PS: ps(300009, 165537) }, 'dsh-abc')).status).toBe(0)
      })

      it.each([
        ["another account's range", own, ps(231072)],
        ["just below the account's own range", own, ps(165535)],
        ['just above the account\'s own range', own, ps(231072, 165536)],
        ['an own sandbox process mixed with a foreign one', own, ps(165536, 231080)],
        ['no subuid entry for the account at all', 'dsh-def:231072:65536\n', ps(165536)],
        ['an empty subuid file', '', ps(165536)],
        ["another user's ordinary uid", own, ps(1002)],
        ['root', own, ps(0)],
      ])('still fails for %s', async (_name, subuid, output) => {
        const result = await run({ FAKE_OPTIONS: hidden, FAKE_SUBUID: subuid, FAKE_PS: output }, 'dsh-abc')
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/^FAIL: dsh-abc can see another user/)
      })
    })

    it.each([
      ['no hidepid', { FAKE_OPTIONS: 'rw,nosuid,nodev,noexec,relatime' }],
      ['hidepid=1 only', { FAKE_OPTIONS: 'rw,hidepid=1,gid=991' }],
      ['wrong exempt group', { FAKE_OPTIONS: 'rw,hidepid=2,gid=5' }],
      ['no exempt group', { FAKE_OPTIONS: 'rw,hidepid=2' }],
      ['another user visible', { FAKE_OPTIONS: hidden, FAKE_PS: '2001 sleep 1\n2002 podman run --name x\n' }],
      ['account in the exempt group', { FAKE_OPTIONS: hidden, FAKE_GROUPS: 'dsh-instances dsh-procview' }],
    ])('fails closed: %s', async (_name, env) => {
      const result = await run(env, 'dsh-abc')
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/^FAIL/)
    })
  })

  it('ships syntactically valid operator scripts that fail closed', async () => {
    for (const script of await files('deploy/production/scripts')) {
      const body = await text(script)
      expect(body).toMatch(/^set -euo pipefail$/m)
      execFileSync('bash', ['-n', join(root, script)])
    }
    expect(await text('deploy/production/scripts/restore.sh')).toMatch(/target state is not empty/)
    expect(await text('deploy/production/scripts/backup.sh')).toMatch(/sqlite3 .*\.backup/)
  })

  it('keeps the userns mapping in step with the image user', async () => {
    const containerfile = await text('deploy/production/Containerfile')
    expect(containerfile).toMatch(new RegExp(`useradd --uid ${INSTANCE_USER.uid} `))
    expect(containerfile).toContain(`USER ${INSTANCE_USER.uid}:${INSTANCE_USER.gid}`)
  })

  it('runs the instance image unprivileged and without secrets', async () => {
    const containerfile = await text('deploy/production/Containerfile')
    expect(containerfile).toMatch(/^USER 10001:10001$/m)
    expect(containerfile).not.toMatch(/API_KEY|SECRET|TOKEN/)
  })
})

describe('production profile generation', () => {
  it('writes a profile per service, is idempotent, and refuses edits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-prod-profile-'))
    for (const name of Object.keys(PRODUCTION_PROFILES) as Array<keyof typeof PRODUCTION_PROFILES>) {
      const profile = await writeProductionProfile(home, name, { configFile: `/etc/dsh-public/${name}.json`, installRoot: '/opt/dsh-public/integration/' })
      expect(await writeProductionProfile(home, name, { configFile: `/etc/dsh-public/${name}.json`, installRoot: '/opt/dsh-public/integration/' })).toBe(profile)
      const patch = JSON.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ name: string; config: { configFile: string } }> }>
      if (name === 'provisioner') {
        // Native (systemd) is the mainline: with no runtime the provisioner mounts the systemd provider.
        expect(patch[0]!.insert.map(row => row.name.split('/').at(-1))).toEqual(['systemd-runtime.js', 'provisioner-service.js'])
      }
      expect(patch[0]!.insert[0]!.config.configFile).toBe(`/etc/dsh-public/${name}.json`)
      expect(patch[0]!.insert[0]!.name).toMatch(/^file:\/\/\/opt\/dsh-public\/integration\/packages\/production\/lib\/.+\.js$/)
    }
    await writeFile(join(home, 'profiles', 'quota', 'cordis.patch.yml'), '[]\n')
    await expect(writeProductionProfile(home, 'provisioner', { configFile: '/etc/dsh-public/provisioner.json', installRoot: '/opt/dsh-public/integration/', runtime: 'nope' as never })).rejects.toThrow(/unknown runtime/)
    await expect(writeProductionProfile(home, 'quota', { configFile: '/etc/dsh-public/quota.json', installRoot: '/opt/dsh-public/integration/' })).rejects.toThrow(/differs/)
    await expect(writeProductionProfile(home, 'quota', { configFile: 'relative.json' })).rejects.toThrow(/absolute/)
  })
})

describe('runtime mainline', () => {
  it('defaults to the native systemd runtime and keeps the frozen container runtime selectable', async () => {
    expect(DEFAULT_RUNTIME).toBe('systemd')
    expect(Object.keys(RUNTIME_PROVIDERS).sort()).toEqual(['podman-gvisor', 'systemd'])
    expect(FROZEN_RUNTIMES).toEqual(['podman-gvisor'])
    const home = await mkdtemp(join(tmpdir(), 'dsh-container-profile-'))
    const container = await writeProductionProfile(home, 'provisioner', { configFile: '/etc/dsh-public/provisioner.json', installRoot: '/opt/dsh-public/integration/', runtime: 'podman-gvisor' })
    const patch = JSON.parse(await readFile(join(container, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patch[0]!.insert.map(row => row.name.split('/').at(-1))).toEqual(['container-runtime.js', 'provisioner-service.js'])
    expect(patch[0]!.insert[0]!.id).toBe('public-harness-container-runtime')
    // identity and kb stay native-only; the default runtime is accepted for them.
    for (const name of ['identity', 'kb'] as const) {
      await expect(writeProductionProfile(home, name, { configFile: `/etc/dsh-public/${name}.json`, installRoot: '/opt/dsh-public/integration/' })).resolves.toContain(name)
    }
  })

  it('documents native as the mainline and the container runtime as frozen in both languages', async () => {
    for (const path of ['README.md', 'deploy/production/README.md', 'deploy/native/README.md']) {
      expect(await text(path), path).toMatch(/frozen/i)
      expect(await text(path.replace(/\.md$/, '.zh.md')), path).toContain('冻结')
    }
    expect(await text('README.md')).toMatch(/native systemd deployment[^\n]*is the mainline runtime/i)
    expect(await text('README.zh.md')).toContain('主线')
  })
})

describe('install-browser.sh', () => {
  const script = join(root, 'deploy/production/scripts/install-browser.sh')
  it('pins one Chrome for Testing build by version, URL and SHA-256 and never disables the sandbox', async () => {
    const pin = await text('deploy/production/browser.pin')
    const version = /^CFT_VERSION=(\S+)$/m.exec(pin)?.[1]
    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(pin).toContain(`CFT_URL=https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip\n`)
    expect(pin).toMatch(/^CFT_SHA256=[0-9a-f]{64}$/m)
    expect(await text('deploy/production/scripts/install-browser.sh')).not.toMatch(/no-sandbox|apparmor_parser|unconfined|disable-setuid/)
  })
  it('refuses a mismatched archive and a non-root install before creating anything', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
    const zip = join(base, 'chrome.zip'); await writeFile(zip, 'not the pinned archive')
    const sha = execFileSync('sha256sum', [zip], { encoding: 'utf8' }).slice(0, 64)
    const pin = join(base, 'pin')
    const run = (pinSha: string) => {
      execFileSync('bash', ['-c', `printf 'CFT_VERSION=1.2.3.4\\nCFT_URL=https://storage.googleapis.com/chrome-for-testing-public/1.2.3.4/linux64/chrome-linux64.zip\\nCFT_SHA256=%s\\n' ${pinSha} > ${pin}`])
      return spawnSync('bash', [script, 'install', join(base, 'browser'), zip], { encoding: 'utf8', env: { ...process.env, DSH_BROWSER_PIN: pin } })
    }
    const mismatch = run('0'.repeat(64))
    expect(mismatch.status).not.toBe(0); expect(mismatch.stderr).toContain('checksum mismatch')
    if (process.getuid?.() !== 0) {
      const nonRoot = run(sha)
      expect(nonRoot.status).not.toBe(0); expect(nonRoot.stderr).toContain('must run as root')
    }
    expect((await readdir(base)).sort()).toEqual(['chrome.zip', 'pin'])
    const tampered = spawnSync('bash', [script, 'verify', base], { encoding: 'utf8', env: { ...process.env, DSH_BROWSER_PIN: pin } })
    expect(tampered.status).not.toBe(0); expect(tampered.stderr).toContain('missing pin record')
    const relative = spawnSync('bash', [script, 'verify', 'browser'], { encoding: 'utf8' })
    expect(relative.stderr).toContain('plain absolute path')
  })
})

describe('native deployment composition', () => {
  const native = async () => ({
    provisioner: await json('deploy/native/config/provisioner.json.example') as { provisioner: Record<string, unknown> },
    nativeOptions: await json('deploy/native/config/native.json.example'),
  })

  it('native_profile_omits_container_requirements', async () => {
    const { provisioner, nativeOptions } = await native()
    const parsed = parseProvisionerProfileConfig(provisioner)
    expect(parsed.provisioner.runtime.kind).toBe('systemd')
    const config = parseSystemdConfig({ common: provisioner.provisioner, native: nativeOptions })
    expect(JSON.stringify([provisioner, nativeOptions])).not.toMatch(/podman|runsc|"image"|gvisor/i)
    expect(config.tools.systemdRun).toBe('/usr/bin/systemd-run')
    const home = await mkdtemp(join(tmpdir(), 'dsh-native-profile-'))
    const profile = await writeProductionProfile(home, 'provisioner', { configFile: '/etc/dsh-public/provisioner.json', installRoot: '/opt/dsh-public/integration/', runtime: 'systemd' })
    const patch = JSON.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patch[0]!.insert.map(row => row.name.split('/').at(-1))).toEqual(['systemd-runtime.js', 'provisioner-service.js'])
    expect(patch[0]!.insert[0]!.id).toBe('public-harness-systemd-runtime')
    await expect(writeProductionProfile(home, 'identity', { configFile: '/etc/dsh-public/identity.json', runtime: 'podman-gvisor' })).rejects.toThrow(/native/)
  })

  it('all_services_launch_through_dsh', async () => {
    for (const [unit, profile] of [['dsh-identity', 'identity'], ['dsh-router', 'team-router'], ['dsh-provisioner', 'provisioner'], ['dsh-quota', 'quota']] as const) {
      const text_ = await text(`deploy/native/systemd/${unit}.service`)
      expect(text_).toMatch(new RegExp(`^ExecStart=/usr/bin/node /opt/dsh-public/harness/apps/cli/lib/bin\\.js --profile ${profile}$`, 'm'))
      expect(profile in PRODUCTION_PROFILES).toBe(true)
    }
  })

  it('private_services_are_not_public', async () => {
    const units = Object.fromEntries(await Promise.all(['dsh-identity', 'dsh-router', 'dsh-quota', 'dsh-provisioner'].map(async unit => [unit, await text(`deploy/native/systemd/${unit}.service`)])))
    // Separate service accounts; only the provisioner is root, and it never runs tenant code.
    expect(units['dsh-identity']).toMatch(/^User=dsh-identity$/m)
    expect(units['dsh-router']).toMatch(/^User=dsh-router$/m)
    expect(units['dsh-quota']).toMatch(/^User=dsh-quota$/m)
    expect(units['dsh-router']).toMatch(/^RestrictAddressFamilies=AF_UNIX$/m)
    expect(units['dsh-identity']).toMatch(/^UnsetEnvironment=BETTER_AUTH_TELEMETRY$/m)
    // Providers come from the operator's environment file; parse the example file with the example environment's shape.
    const pairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^DSH_[A-Z_]+=/.test(line)).map(line => line.split('=') as [string, string])
    // The shipped example carries no secret values; the host fills them in.
    expect(pairs.filter(([key, value]) => /SECRET|PASSWORD|ACCESS_KEY_ID/.test(key) && value !== '')).toEqual([])
    const env = Object.fromEntries(pairs.map(([key, value]) => [key, value || 'placeholder0']))
    const identity = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), env)
    expect(identity.captcha.kind).toBe('aliyun')
    expect(identity.sso).toEqual({ kind: 'off' })
    // The commented enterprise SSO block parses once uncommented, and carries no secret value either.
    const ssoPairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_(SSO|OIDC)_[A-Z_]+=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(ssoPairs.filter(([key, value]) => /SECRET/.test(key) && value !== '')).toEqual([])
    const enterprise = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, ...Object.fromEntries(ssoPairs.map(([key, value]) => [key, value || 'placeholder0'])) })
    expect(enterprise.sso).toMatchObject({ kind: 'oidc', issuer: 'https://idp.corp.example/realms/corp', allowedGroups: ['engineering'] })
    expect(enterprise.emergency).toEqual({ enabled: true, allowedIps: ['10.0.0.0/24'] })
    const wecomPairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_WECOM_[A-Z_]+=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(wecomPairs.filter(([key, value]) => /SECRET/.test(key) && value !== '')).toEqual([])
    const wecom = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, DSH_SSO_PROVIDER: 'wecom', DSH_SSO_ALLOWED_GROUPS: '2',
      ...Object.fromEntries(wecomPairs.map(([key, value]) => [key, value || (key === 'DSH_WECOM_AGENT_ID' ? '1000002' : 'placeholder0')])) })
    expect(wecom.sso).toMatchObject({ kind: 'wecom', apiBase: 'https://qyapi.weixin.qq.com', recursiveDepartments: true })
    const dingPairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_DINGTALK_[A-Z_]+=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(dingPairs.filter(([key, value]) => /SECRET/.test(key) && value !== '')).toEqual([])
    const ding = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, DSH_SSO_PROVIDER: 'dingtalk', DSH_SSO_ALLOWED_GROUPS: '2',
      ...Object.fromEntries(dingPairs.map(([key, value]) => [key, value || 'placeholder0'])) })
    expect(ding.sso).toMatchObject({ kind: 'dingtalk', oapiBase: 'https://oapi.dingtalk.com', exclusiveLogin: false, recursiveDepartments: true })
    const samlPairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_SAML_[A-Z_]+=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(samlPairs.map(([key]) => key)).toContain('DSH_SAML_IDP_CERT_FILE')
    const certDir = mkdtempSync(join(tmpdir(), 'dsh-saml-example-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=example-idp.test', '-keyout', join(certDir, 'k'), '-out', join(certDir, 'c')], { stdio: 'ignore' })
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=example-sp.test', '-keyout', join(certDir, 'sk'), '-out', join(certDir, 'sc')], { stdio: 'ignore' })
      chmodSync(join(certDir, 'sk'), 0o600)
      const saml = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, DSH_SSO_PROVIDER: 'saml', DSH_SSO_ALLOWED_GROUPS: 'engineering',
        ...Object.fromEntries(samlPairs), DSH_SAML_IDP_CERT_FILE: join(certDir, 'c'), DSH_SAML_SP_SIGNING_KEY_FILE: join(certDir, 'sk'), DSH_SAML_SP_SIGNING_CERT_FILE: join(certDir, 'sc'),
        DSH_SAML_SP_DECRYPTION_KEY_FILE: join(certDir, 'sk'), DSH_SAML_SP_DECRYPTION_CERT_FILE: join(certDir, 'sc') })
      expect(saml.sso).toMatchObject({ kind: 'saml', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', wantAssertionsSigned: false, clockSkewMs: 60_000 })
      expect(saml.sso.kind === 'saml' && saml.sso.signing !== undefined && saml.sso.decryption !== undefined).toBe(true)
    } finally { rmSync(certDir, { recursive: true, force: true }) }
    const ldapPairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_LDAP_[A-Z_]+=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(ldapPairs.map(([key]) => key)).toContain('DSH_LDAP_CA_FILE')
    const ldap = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, DSH_SSO_PROVIDER: 'ldap', DSH_SSO_ALLOWED_GROUPS: 'CN=Harness,OU=Groups,DC=corp,DC=example',
      ...Object.fromEntries(ldapPairs), DSH_LDAP_CA_FILE: undefined, DSH_LDAP_BIND_PASSWORD: 'placeholder0' })
    expect(ldap.sso).toMatchObject({ kind: 'ldap', startTls: false, groupMode: 'nested', activeDirectory: true, serverId: 'dc1.corp.example:636', timeoutMs: 5000 })
    const reconcilePairs = (await text('deploy/native/config/identity.env.example')).split('\n').filter(line => /^# DSH_SSO_(RECONCILE|MAX_INACTIVE)[A-Z_]*=/.test(line))
      .map(line => { const [key, ...rest] = line.slice(2).split('='); return [key!, rest.join('=')] as [string, string] })
    expect(reconcilePairs.map(([key]) => key)).toEqual(['DSH_SSO_RECONCILE_INTERVAL_MINUTES', 'DSH_SSO_MAX_INACTIVE_DAYS', 'DSH_SSO_RECONCILE_MAX_DISABLE'])
    const reconciled = parseIdentityConfig(await json('deploy/native/config/identity.json.example'), { ...env, DSH_SSO_PROVIDER: 'ldap', DSH_SSO_ALLOWED_GROUPS: 'CN=Harness,OU=Groups,DC=corp,DC=example',
      ...Object.fromEntries(ldapPairs), DSH_LDAP_CA_FILE: undefined, DSH_LDAP_BIND_PASSWORD: 'placeholder0', ...Object.fromEntries(reconcilePairs) })
    expect(reconciled.deprovision).toEqual({ intervalMs: 3_600_000, maxInactiveDays: 90, maxDisablePerRun: 10 })
    expect(units['dsh-identity']).toMatch(/^EnvironmentFile=\/etc\/dsh-public\/identity-secrets\/identity\.env$/m)
    expect(identity.mode).toBe('production')
    expect(identity.enrollmentOpen).toBe(false)
    const router = parseTeamRouterConfig(await json('deploy/native/config/router.json.example'))
    expect(router.identity).toMatchObject({ kind: 'better-auth', sessionSocket: identity.sessionSocket })
    expect(identity.sessionSocketGid).toBe(router.routerSocketGid)
    // Caddy reaches the identity public socket; only the router group reaches the session socket.
    const tmpfiles = await text('deploy/native/systemd/tmpfiles.conf')
    expect(tmpfiles).toMatch(/^d \/run\/dsh-public\/identity\s+0750 dsh-identity dsh-ingress$/m)
    expect(tmpfiles).toMatch(/^d \/run\/dsh-public\/identity-session\s+0750 dsh-identity dsh-router$/m)
    expect(identity.publicSocket.startsWith('/run/dsh-public/identity/')).toBe(true)
    expect(identity.sessionSocket.startsWith('/run/dsh-public/identity-session/')).toBe(true)
    const caddy = await text('deploy/native/Caddyfile')
    expect(caddy).not.toContain('identity-session')
    expect(caddy).not.toMatch(/forward_auth/)
    for (const header of ['X-Authentik-Uid', 'X-Authentik-Jwt', 'Forwarded', 'X-Dsh-Client-Ip']) expect(caddy).toContain(`request_header -${header}`)
    expect(caddy).toMatch(/@account path \/account\/\* \/api\/auth\/\*/)
    expect(caddy).toMatch(/header_up Host \{hostport\}/)
    expect(caddy).toMatch(/admin unix\/\/run\/caddy\/admin\.sock\|0600/)
    expect(caddy).toMatch(/trusted_proxies static\n/)
  })

  it('runs_the_knowledge_base_service_as_its_own_account_and_splits_out_a_socket_activated_root_helper', async () => {
    const unit = await text('deploy/native/systemd/dsh-kb.service')
    const lines = (body: string, key: string) => body.split('\n').filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1))
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/node \/opt\/dsh-public\/harness\/apps\/cli\/lib\/bin\.js --profile kb$/m)
    expect('kb' in PRODUCTION_PROFILES).toBe(true)
    for (const [key, value] of [['User', 'dsh-kb'], ['Group', 'dsh-kb'], ['NoNewPrivileges', 'yes'], ['ProtectSystem', 'strict'], ['ProtectHome', 'yes'], ['PrivateTmp', 'yes'],
      ['PrivateNetwork', 'yes'], ['RestrictAddressFamilies', 'AF_UNIX'], ['CapabilityBoundingSet', ''], ['AmbientCapabilities', ''], ['RestrictSUIDSGID', 'yes']] as const) {
      expect(lines(unit, key), key).toEqual([value])
    }
    expect(lines(unit, 'SystemCallFilter')).toEqual(['@system-service', '~@mount @setuid'])
    expect(lines(unit, 'ReadWritePaths')).toEqual(['/var/lib/dsh-public/kb /run/dsh-public/kb'])
    // Tenant storage, secrets and provisioner state are not even visible to the service.
    expect(lines(unit, 'InaccessiblePaths')[0]!.split(' ')).toEqual(expect.arrayContaining(['-/srv/dsh-public', '-/etc/dsh-public/secrets', '-/var/lib/dsh-public/state']))
    expect(unit).not.toMatch(/^(User=root|SupplementaryGroups=.*dsh-kb\b)/m)

    const socket = await text('deploy/native/systemd/dsh-kb-root.socket')
    for (const [key, value] of [['ListenStream', '/run/dsh-public/kb-root.sock'], ['SocketUser', 'root'], ['SocketGroup', 'dsh-kb'], ['SocketMode', '0660'], ['Accept', 'yes']] as const) {
      expect(lines(socket, key), key).toEqual([value])
    }
    const root = await text('deploy/native/systemd/dsh-kb-root@.service')
    expect(lines(root, 'ExecStart')).toEqual(['/usr/bin/node /opt/dsh-public/integration/packages/production/lib/kb-root-helper.js /etc/dsh-public/kb-root.json'])
    for (const [key, value] of [['StandardInput', 'socket'], ['StandardOutput', 'socket'], ['NoNewPrivileges', 'yes'], ['ProtectSystem', 'strict'], ['PrivateNetwork', 'yes'],
      ['RestrictAddressFamilies', 'AF_UNIX'], ['CapabilityBoundingSet', 'CAP_SYS_ADMIN']] as const) {
      expect(lines(root, key), key).toEqual([value])
    }
    expect(lines(root, 'SystemCallFilter')[1]).toMatch(/^~@mount /)
    expect(lines(root, 'InaccessiblePaths')[0]!.split(' ')).toContain('-/var/lib/dsh-public/kb')
    expect(root).not.toMatch(/sudo|pkexec|polkit/i)

    // Only dsh-kb is in the dsh-kb group; identity reaches the kb socket and quota the job socket through their own groups.
    const sysusers = await text('deploy/native/systemd/sysusers.conf')
    expect(sysusers).toMatch(/^u dsh-kb\s/m)
    expect(sysusers.split('\n').filter(line => /^m \S+ dsh-kb$/.test(line))).toEqual([])
    for (const line of ['m dsh-kb dsh-kb-clients', 'm dsh-identity dsh-kb-clients', 'm dsh-kb dsh-kb-quota', 'm dsh-quota dsh-kb-quota']) expect(sysusers).toContain(line)
    const tmpfiles = await text('deploy/native/systemd/tmpfiles.conf')
    expect(tmpfiles).toMatch(/^d \/run\/dsh-public\/kb\s+0750 dsh-kb\s+dsh-kb-clients$/m)
    expect(tmpfiles).toMatch(/^d \/run\/dsh-public\/quota-jobs\s+0750 dsh-quota\s+dsh-kb-quota$/m)
    expect(lines(await text('deploy/native/systemd/dsh-quota.service'), 'ReadWritePaths')[0]).toContain('/run/dsh-public/quota-jobs')

    // The examples agree with the units.
    const kb = parseKbProfileConfig(await json('deploy/production/config/kb.example.json'))
    const kbRoot = parseKbRootConfig(await json('deploy/production/config/kb-root.example.json'))
    expect(kb.rootHelperSocket).toBe('/run/dsh-public/kb-root.sock')
    expect(kb.socket.startsWith('/run/dsh-public/kb/')).toBe(true)
    expect(kb.compile?.quotaSocket.startsWith('/run/dsh-public/quota-jobs/')).toBe(true)
    expect([kb.root, kbRoot.kbRoot]).toEqual(['/var/lib/dsh-public/kb', '/var/lib/dsh-public/kb'])
    expect(kb.storageRoot).toBe(kbRoot.storageRoot)
    expect(kbRoot.inaccessible).toContain(kb.root)
  })

  it('host preflight reports failures without touching the host', async () => {
    const { provisioner, nativeOptions } = await native()
    const reads: string[] = [], runs: string[] = []
    const results = await preflight(provisioner.provisioner, nativeOptions, {
      read: async path => { reads.push(path); return path.endsWith('os-release') ? 'ID=debian\n' : path.endsWith('enabled') ? 'Y\n' : path.endsWith('userns') ? '0\n' : 'cpu memory pids\n' },
      run: (command, args) => { runs.push(`${command} ${args.join(' ')}`); return 'Enforcement: ON' },
    })
    const byName = Object.fromEntries(results.map(result => [result.check, result.ok]))
    expect(byName).toMatchObject({ os: false, cgroup2: true, apparmor: false, 'xfs-quota': true, nftables: true })
    expect(runs.every(line => /xfs_quota -x -c state -u|nft --version|--version$/.test(line))).toBe(true)
  })
})
