import { describe, expect, it } from 'vitest'
import { checkPublicEnrollment, collectConfigFacts, REQUIRED_EVIDENCE, type ConfigFacts, type ReleaseContext, type ReleaseEvidence } from '../deploy/release-check.ts'

const now = new Date('2026-10-20T00:00:00Z')
const goodConfig: ConfigFacts = { caddyForwardAuth: true, caddyStripsIdentityHeaders: true, caddyUnixUpstream: true, routerSecureUnixIngress: true,
  limitsConfigured: true, quotaPositiveLimits: true, enrollmentRequiresVerification: true, enrollmentClosedInManifest: true }
const context = (overrides: Partial<ReleaseContext> = {}): ReleaseContext => ({ expectedHost: 'harness-prod-1', release: '2026.10.0', now,
  maxAgeMs: 7 * 86_400_000, config: goodConfig, ...overrides })
const item = (overrides: Record<string, unknown> = {}) => ({ passed: true, host: 'harness-prod-1', recordedAt: '2026-10-19T12:00:00Z', release: '2026.10.0', ...overrides })
const evidence = (overrides: Record<string, unknown> = {}): ReleaseEvidence =>
  ({ schema: 1, checks: Object.fromEntries(REQUIRED_EVIDENCE.map(name => [name, item(overrides)])) })

describe('public enrollment release check', () => {
  it('allows only complete, fresh, same-host, same-release evidence with passing configuration', async () => {
    expect(await checkPublicEnrollment(evidence(), context())).toEqual({ decision: 'allow', reasons: [] })
  })

  it.each(REQUIRED_EVIDENCE)('denies when %s is missing', async name => {
    const value = evidence()
    const { [name]: _removed, ...checks } = value.checks
    const decision = await checkPublicEnrollment({ ...value, checks }, context())
    expect(decision.decision).toBe('deny')
    expect(decision.reasons).toContain(`evidence: ${name} is missing`)
  })

  it('denies failed, stale, future, wrong-host, and wrong-release evidence', async () => {
    expect((await checkPublicEnrollment(evidence({ passed: false }), context())).decision).toBe('deny')
    expect((await checkPublicEnrollment(evidence({ recordedAt: '2026-09-01T00:00:00Z' }), context())).reasons[0]).toMatch(/stale/)
    expect((await checkPublicEnrollment(evidence({ recordedAt: '2026-12-01T00:00:00Z' }), context())).reasons[0]).toMatch(/invalid time/)
    expect((await checkPublicEnrollment(evidence({ host: 'laptop' }), context())).reasons[0]).toMatch(/different host/)
    expect((await checkPublicEnrollment(evidence({ release: '2026.09.0' }), context())).reasons[0]).toMatch(/different release/)
  })

  it.each(Object.keys(goodConfig) as Array<keyof ConfigFacts>)('denies when configuration fact %s fails', async fact => {
    const decision = await checkPublicEnrollment(evidence(), context({ config: { ...goodConfig, [fact]: false } }))
    expect(decision.decision).toBe('deny')
    expect(decision.reasons).toHaveLength(1)
  })

  it('denies malformed input and unknown checks, and rejects secrets in details', async () => {
    for (const bad of [undefined, null, 'allow', { schema: 2, checks: {} }, { schema: 1 }]) expect((await checkPublicEnrollment(bad, context())).decision).toBe('deny')
    const unknown = { schema: 1, checks: { ...evidence().checks, 'skip-everything': item() } }
    expect((await checkPublicEnrollment(unknown, context())).reasons[0]).toMatch(/unknown check/)
    for (const detail of ['Bearer abcdefghijklmnop', 'key sk-abcdefghijkl', 'password=hunter22', 'admin@example.com', '/home/alice/data', 'x'.repeat(501)]) {
      expect((await checkPublicEnrollment(evidence({ detail }), context())).reasons[0]).toMatch(/secrets or user data/)
    }
    expect((await checkPublicEnrollment(evidence({ detail: 'ran at 2026-10-19 on release candidate' }), context())).decision).toBe('allow')
  })
})

describe('machine-checked configuration facts', () => {
  const caddyfile = `x {\n route {\n request_header -X-Authentik-Uid\n request_header -X-Authentik-Jwt\n request_header -X-Forwarded-User\n request_header -X-Real-Ip\n request_header -Forwarded\n forward_auth {$DSH_OUTPOST_ADDR} {\n uri /outpost.goauthentik.io/auth/caddy\n copy_headers X-Authentik-Uid X-Authentik-Jwt\n }\n reverse_proxy unix/{$DSH_ROUTER_SOCKET}\n }\n}`
  const files = { caddyfile, router: { routerSocket: '/run/r.sock', publicAuthority: 'h.example.com' },
    provisioner: { provisioner: { limits: { cpus: 1, memoryBytes: 1, pids: 1, openFiles: 1, diskBytes: 1 } } },
    quota: { service: { personalDailyTokens: 1, siteDailyTokens: 1, personalConcurrency: 1, siteConcurrency: 1 } },
    blueprint: 'authentik_stages_captcha.captchastage\nauthentik_stages_email.emailstage\ncreate_users_as_inactive: true', manifestEnrollment: 'closed' }

  it('passes for a sound set and flags each regression', () => {
    expect(Object.values(collectConfigFacts(files)).every(Boolean)).toBe(true)
    expect(collectConfigFacts({ ...files, caddyfile: caddyfile.replace('forward_auth', 'basicauth') }).caddyForwardAuth).toBe(false)
    expect(collectConfigFacts({ ...files, caddyfile: caddyfile.replace('request_header -X-Authentik-Uid\n', '') }).caddyStripsIdentityHeaders).toBe(false)
    // stripping after authentication would delete the verified identity
    const late = caddyfile.replace(/ request_header -X-Real-Ip\n request_header -Forwarded\n/, '') + '\n# request_header -X-Real-Ip'
    expect(collectConfigFacts({ ...files, caddyfile: late }).caddyStripsIdentityHeaders).toBe(false)
    expect(collectConfigFacts({ ...files, caddyfile: caddyfile.replace('unix/{$DSH_ROUTER_SOCKET}', '127.0.0.1:8080') }).caddyUnixUpstream).toBe(false)
    expect(collectConfigFacts({ ...files, quota: { service: { personalDailyTokens: 0 } } }).quotaPositiveLimits).toBe(false)
    expect(collectConfigFacts({ ...files, provisioner: { provisioner: {} } }).limitsConfigured).toBe(false)
    expect(collectConfigFacts({ ...files, blueprint: 'captchastage' }).enrollmentRequiresVerification).toBe(false)
    expect(collectConfigFacts({ ...files, manifestEnrollment: 'open' }).enrollmentClosedInManifest).toBe(false)
  })
})
