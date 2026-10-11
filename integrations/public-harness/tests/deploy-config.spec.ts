import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parse, parseDocument, type Document } from 'yaml'
import { describe, expect, it } from 'vitest'
import { collectConfigFacts } from '../deploy/release-check.ts'
import { PRODUCTION_PROFILES, writeProductionProfile } from '../deploy/production-profile.ts'
import { parseReleaseManifest } from '../deploy/upgrade.ts'
import { networkArgument } from '../packages/provisioner/src/limits.ts'
import { parseProvisionerProfileConfig } from '../packages/production/src/provisioner-service.ts'
import { parseQuotaProfileConfig } from '../packages/production/src/quota-service.ts'
import { parseTeamRouterConfig } from '../packages/production/src/team-router.ts'

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

  it('selects the pasta stack and leaves its options (--no-splice, host loopback) to the provisioner', async () => {
    const provisioner = parseProvisionerProfileConfig(await json('deploy/production/config/provisioner.example.json')).provisioner
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
    const manifest = parseReleaseManifest(await json('deploy/release-manifest.json'))
    expect(manifest.publicEnrollment).toBe('closed')
    for (const [name, version] of Object.entries(manifest.bundles)) {
      const directory = name.replace('@public-harness/', '')
      expect((await json(`packages/${directory}/package.json`)).version, name).toBe(version)
    }
    const packages = (await readdir(join(root, 'packages'))).filter(name => name !== 'node_modules')
    expect(Object.keys(manifest.bundles).map(name => name.replace('@public-harness/', '')).sort()).toEqual(packages.sort())
    expect(manifest.image).toBe((await json('deploy/production/config/provisioner.example.json') as { provisioner: { image: string } }).provisioner.image)
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

  const nft = process.env.NFT_BIN
  it.skipIf(nft === undefined)('is accepted by the real nft parser', () => {
    // `nft -c` needs CAP_NET_ADMIN, so it runs inside an unprivileged user and network namespace.
    const checked = spawnSync('unshare', ['-Urn', nft!, '-c', '-f', join(root, 'deploy/production/nftables/dsh-public.nft')], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
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
      expect(patch[0]!.insert[0]!.config.configFile).toBe(`/etc/dsh-public/${name}.json`)
      expect(patch[0]!.insert[0]!.name).toMatch(/^file:\/\/\/opt\/dsh-public\/integration\/packages\/production\/lib\/.+\.js$/)
    }
    await writeFile(join(home, 'profiles', 'quota', 'cordis.patch.yml'), '[]\n')
    await expect(writeProductionProfile(home, 'quota', { configFile: '/etc/dsh-public/quota.json', installRoot: '/opt/dsh-public/integration/' })).rejects.toThrow(/differs/)
    await expect(writeProductionProfile(home, 'quota', { configFile: 'relative.json' })).rejects.toThrow(/absolute/)
  })
})
