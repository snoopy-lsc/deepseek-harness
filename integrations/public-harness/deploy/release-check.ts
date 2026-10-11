/** Public enrollment release gate: enrollment opens only when configuration and recorded real-Linux evidence all pass. */
import { isAbsolute } from 'node:path'

/** Evidence names; each is a recorded result from a rehearsal on the production host. */
export const REQUIRED_EVIDENCE = [
  'caddy-tls-header-stripping', 'authentik-security-version', 'authentik-email-captcha', 'tool-execution-under-gvisor',
  'two-user-isolation', 'loopback-isolation', 'sandbox-kill-recovery', 'quota-fail-closed', 'account-lifecycle', 'restart-recovery', 'backup-restore', 'capacity',
] as const

export type EvidenceName = typeof REQUIRED_EVIDENCE[number]

/** One recorded check result; `detail` is short free text and must not carry secrets or user data. */
export interface EvidenceItem {
  readonly passed: boolean
  readonly host: string
  readonly recordedAt: string
  /** The `release` string of the manifest this was proven against. */
  readonly release: string
  readonly detail?: string
}

/** Operator-recorded evidence file. */
export interface ReleaseEvidence {
  readonly schema: 1
  readonly checks: Readonly<Partial<Record<EvidenceName, EvidenceItem>>>
}

/** Facts derived by the machine from deployed files. */
export interface ConfigFacts {
  readonly caddyForwardAuth: boolean
  readonly caddyStripsIdentityHeaders: boolean
  readonly caddyUnixUpstream: boolean
  readonly caddyAdminPrivate: boolean
  readonly caddyKeepsHostPort: boolean
  readonly routerSecureUnixIngress: boolean
  readonly limitsConfigured: boolean
  readonly quotaPositiveLimits: boolean
  readonly enrollmentRequiresVerification: boolean
  readonly enrollmentClosedInManifest: boolean
}

/** Decision returned to the operator; `allow` is the only value that may be acted on. */
export interface ReleaseDecision {
  readonly decision: 'allow' | 'deny'
  readonly reasons: readonly string[]
}

export interface ReleaseContext {
  /** Host name the evidence must have been recorded on. */
  readonly expectedHost: string
  readonly release: string
  readonly now: Date
  readonly maxAgeMs: number
  readonly config: ConfigFacts
}

const SECRET = /(?:sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+\/=-]{8,}|-----BEGIN [A-Z ]*KEY|(?:password|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i

const CONFIG_FAILURES: Readonly<Record<keyof ConfigFacts, string>> = {
  caddyForwardAuth: 'config: Caddy does not authenticate every request with forward_auth',
  caddyStripsIdentityHeaders: 'config: Caddy does not strip client identity headers before authentication',
  caddyUnixUpstream: 'config: Caddy upstream is not the router Unix socket',
  caddyAdminPrivate: 'config: Caddy admin API is reachable over TCP',
  caddyKeepsHostPort: 'config: Caddy does not forward the Host header with its port',
  routerSecureUnixIngress: 'config: router ingress is not a Unix socket with Secure cookies and a public authority',
  limitsConfigured: 'config: instance resource limits are missing',
  quotaPositiveLimits: 'config: quota limits are missing or non-positive',
  enrollmentRequiresVerification: 'config: enrollment lacks email verification and CAPTCHA',
  enrollmentClosedInManifest: 'config: manifest does not keep enrollment closed',
}

/** Decide whether public enrollment may open. Anything missing, stale, from another host, or unverified denies. */
export async function checkPublicEnrollment(evidence: unknown, context: ReleaseContext): Promise<ReleaseDecision> {
  const reasons: string[] = []
  for (const [name, message] of Object.entries(CONFIG_FAILURES)) if (context.config[name as keyof ConfigFacts] !== true) reasons.push(message)
  const record = typeof evidence === 'object' && evidence !== null ? evidence as Record<string, unknown> : undefined
  const checks = typeof record?.checks === 'object' && record.checks !== null ? record.checks as Record<string, unknown> : undefined
  if (record?.schema !== 1 || checks === undefined) return { decision: 'deny', reasons: [...reasons, 'evidence: missing or malformed'] }
  for (const name of Object.keys(checks)) if (!(REQUIRED_EVIDENCE as readonly string[]).includes(name)) reasons.push(`evidence: unknown check ${name.slice(0, 40)}`)
  for (const name of REQUIRED_EVIDENCE) {
    const item = checks[name]
    if (typeof item !== 'object' || item === null) { reasons.push(`evidence: ${name} is missing`); continue }
    const value = item as Record<string, unknown>
    const recorded = typeof value.recordedAt === 'string' ? Date.parse(value.recordedAt) : Number.NaN
    if (value.passed !== true) reasons.push(`evidence: ${name} did not pass`)
    else if (value.host !== context.expectedHost) reasons.push(`evidence: ${name} was recorded on a different host`)
    else if (value.release !== context.release) reasons.push(`evidence: ${name} was recorded for a different release`)
    else if (!Number.isFinite(recorded) || recorded > context.now.valueOf() + 60_000) reasons.push(`evidence: ${name} has an invalid time`)
    else if (context.now.valueOf() - recorded > context.maxAgeMs) reasons.push(`evidence: ${name} is stale`)
    else if (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 500 || SECRET.test(value.detail) || isAbsolute(value.detail))) {
      reasons.push(`evidence: ${name} detail may contain secrets or user data`)
    }
  }
  return reasons.length === 0 ? { decision: 'allow', reasons: [] } : { decision: 'deny', reasons }
}

const LOWER = (text: string): string => text.replace(/#.*$/gm, '').toLowerCase()

/** Machine-checked facts from the deployed files; every input is file text or parsed JSON, never a secret. */
export function collectConfigFacts(files: { readonly caddyfile: string; readonly router: Record<string, unknown>;
  readonly provisioner: Record<string, unknown>; readonly quota: Record<string, unknown>; readonly blueprint: string;
  readonly manifestEnrollment: unknown }): ConfigFacts {
  const caddy = LOWER(files.caddyfile)
  const strip = ['x-authentik-uid', 'x-authentik-jwt', 'x-forwarded-user', 'x-real-ip', 'forwarded']
  const authAt = caddy.indexOf('forward_auth')
  const positive = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  const limits = (files.provisioner.provisioner as { limits?: Record<string, unknown> } | undefined)?.limits
  const service = files.quota.service as Record<string, unknown> | undefined
  const blueprint = LOWER(files.blueprint)
  return {
    caddyForwardAuth: authAt >= 0 && /copy_headers\s+x-authentik-uid\s+x-authentik-jwt/.test(caddy) && /uri \/outpost\.goauthentik\.io\/auth\/caddy/.test(caddy),
    caddyStripsIdentityHeaders: authAt >= 0 && strip.every(header => { const at = caddy.indexOf(`request_header -${header}`); return at >= 0 && at < authAt }),
    caddyUnixUpstream: /reverse_proxy unix\//.test(caddy) && !/reverse_proxy\s+(?!unix\/)(?!\{\$dsh_outpost_addr\})\S+/.test(caddy),
    routerSecureUnixIngress: isAbsolute(String(files.router.routerSocket)) && typeof files.router.publicAuthority === 'string' && files.router.publicAuthority.length > 0,
    caddyAdminPrivate: /^\s*admin (?:off|unix\/)/m.test(caddy),
    caddyKeepsHostPort: /header_up host \{hostport\}/.test(caddy),
    limitsConfigured: limits !== undefined && ['cpus', 'memoryBytes', 'pids', 'openFiles', 'diskBytes'].every(key => positive(limits[key])),
    quotaPositiveLimits: service !== undefined && ['personalDailyTokens', 'siteDailyTokens', 'personalConcurrency', 'siteConcurrency'].every(key => positive(service[key])),
    enrollmentRequiresVerification: blueprint.includes('captchastage') && blueprint.includes('emailstage') && blueprint.includes('create_users_as_inactive: true'),
    enrollmentClosedInManifest: files.manifestEnrollment === 'closed',
  }
}
