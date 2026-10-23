/** Per-verb argument allowlists for the socket-activated fetch service. */
import { ID_PATTERN } from '../ids.ts'

/** Fixed verbs the fetch unit accepts. */
export const FETCH_VERBS = ['npm-version', 'git-commit', 'upload-check', 'closure', 'artifact'] as const
export type FetchVerb = (typeof FETCH_VERBS)[number]

/** Host allowlist and optional git path prefixes (design: fetch checks prefixes). */
export interface FetchPolicy {
  readonly allow: readonly string[]
  /** Host → allowed URL path prefixes (each must start with `/` and end with `/` or be `/`). */
  readonly gitPathPrefixes?: Readonly<Record<string, readonly string[]>>
}

/** A refused request; `message` is the wire error code. */
export class FetchError extends Error {
  readonly detail: string | undefined
  constructor(code: 'request' | 'verb' | 'args' | 'input' | 'handler', detail?: string) {
    super(code)
    this.detail = detail
  }
}

/** Exact SemVer 2.0.0 core + optional prerelease + build (no ranges, no `v` prefix). */
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** npm package name: unscoped or `@scope/name`. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Relative path without empty, `.`, or `..` segments. */
const relativePath = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value) >= 1
  && Buffer.byteLength(value) <= 400
  && !/[\0-\x1f\x7f\\]/.test(value)
  && !value.startsWith('/')
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Normalize a registry host or https URL to a hostname in `policy.allow`. */
export function registryHost(registry: unknown, allow: readonly string[]): string {
  if (typeof registry !== 'string' || registry.length < 1 || registry.length > 256) throw new FetchError('args')
  let host: string
  if (registry.includes('://')) {
    let url: URL
    try { url = new URL(registry) } catch { throw new FetchError('args') }
    if (url.protocol !== 'https:') throw new FetchError('args')
    if (url.username || url.password || url.port) throw new FetchError('args')
    host = url.hostname.toLowerCase()
  } else {
    if (!HOST.test(registry) || registry.includes('/') || registry.includes(':')) throw new FetchError('args')
    host = registry.toLowerCase()
  }
  if (!allow.map(h => h.toLowerCase()).includes(host)) throw new FetchError('args')
  return host
}

export function exactSemVer(value: unknown): string {
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value)) throw new FetchError('args')
  return value
}

export function npmName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 214 || !NPM_NAME.test(value)) throw new FetchError('args')
  return value
}

export interface NpmVersionArgs { readonly registry: string; readonly name: string; readonly version: string }
export interface GitCommitArgs {
  readonly url: string
  readonly host: string
  readonly pathPrefix: string
  readonly commit: string
  readonly path: string
}
export interface ClosureArgs { readonly name: string; readonly version: string; readonly registry: string }
export interface ArtifactArgs { readonly versionId: string }
export type ValidatedArgs =
  | { readonly verb: 'npm-version'; readonly args: NpmVersionArgs }
  | { readonly verb: 'git-commit'; readonly args: GitCommitArgs }
  | { readonly verb: 'upload-check'; readonly args: Record<string, never> }
  | { readonly verb: 'closure'; readonly args: ClosureArgs }
  | { readonly verb: 'artifact'; readonly args: ArtifactArgs }

const COMMIT = /^[0-9a-f]{40}$/

function parseGitUrl(url: unknown, policy: FetchPolicy): { url: string; host: string; pathPrefix: string } {
  if (typeof url !== 'string' || url.length < 12 || url.length > 2000) throw new FetchError('args')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new FetchError('args') }
  if (parsed.protocol !== 'https:') throw new FetchError('args')
  if (parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search) throw new FetchError('args')
  const host = parsed.hostname.toLowerCase()
  if (!policy.allow.map(h => h.toLowerCase()).includes(host)) throw new FetchError('args')
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  const prefixes = policy.gitPathPrefixes?.[host] ?? policy.gitPathPrefixes?.[parsed.hostname]
  if (prefixes !== undefined) {
    const match = prefixes.find(prefix => {
      if (prefix === '/') return true
      const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
      return pathname === normalized.slice(0, -1) || pathname.startsWith(normalized)
    })
    if (match === undefined) throw new FetchError('args')
    return { url: `https://${host}${pathname}`, host, pathPrefix: match.endsWith('/') || match === '/' ? match : `${match}/` }
  }
  return { url: `https://${host}${pathname}`, host, pathPrefix: '/' }
}

/** Validate args for a known verb against the allowlist and policy. */
export function validateFetchArgs(verb: FetchVerb, args: Record<string, unknown>, policy: FetchPolicy): ValidatedArgs {
  const keys = Object.keys(args)
  switch (verb) {
    case 'npm-version': {
      if (keys.sort().join(',') !== 'name,registry,version') throw new FetchError('args')
      return {
        verb,
        args: {
          registry: registryHost(args.registry, policy.allow),
          name: npmName(args.name),
          version: exactSemVer(args.version),
        },
      }
    }
    case 'git-commit': {
      if (keys.sort().join(',') !== 'commit,path,url') throw new FetchError('args')
      if (typeof args.commit !== 'string' || !COMMIT.test(args.commit)) throw new FetchError('args')
      if (!relativePath(args.path)) throw new FetchError('args')
      const git = parseGitUrl(args.url, policy)
      return { verb, args: { ...git, commit: args.commit, path: args.path } }
    }
    case 'upload-check': {
      if (keys.length !== 0) throw new FetchError('args')
      return { verb, args: {} }
    }
    case 'closure': {
      if (keys.sort().join(',') !== 'name,registry,version') throw new FetchError('args')
      return {
        verb,
        args: {
          name: npmName(args.name),
          version: exactSemVer(args.version),
          registry: registryHost(args.registry, policy.allow),
        },
      }
    }
    case 'artifact': {
      if (keys.sort().join(',') !== 'versionId') throw new FetchError('args')
      if (typeof args.versionId !== 'string' || !ID_PATTERN.plv.test(args.versionId)) throw new FetchError('args')
      return { verb, args: { versionId: args.versionId } }
    }
  }
}

export { plain, EXACT_SEMVER, NPM_NAME, relativePath }
