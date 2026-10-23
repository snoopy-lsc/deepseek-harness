/** Fetch service entry surface: framing, verbs, and stub handlers for pre-network validation. */
export {
  FETCH_VERBS,
  FetchError,
  exactSemVer,
  npmName,
  registryHost,
  validateFetchArgs,
  type ArtifactArgs,
  type ClosureArgs,
  type FetchPolicy,
  type FetchVerb,
  type GitCommitArgs,
  type NpmVersionArgs,
  type ValidatedArgs,
} from './verbs.ts'
export {
  MAX_HEADER_BYTES,
  MAX_INPUT_BYTES,
  parseFetchRequest,
  serveFetchConnection,
  type FetchConnectionDeps,
  type FetchHandlerResult,
  type FetchHandlers,
  type FetchRequest,
} from './framing.ts'

import type { FetchHandlers, FetchHandlerResult } from './framing.ts'
import type { FetchPolicy } from './verbs.ts'
import { FetchError } from './verbs.ts'

/** Stub handlers that throw if invoked — unit tests inject mocks; production wires real mirror work in 1A.4. */
export function unimplementedHandlers(): FetchHandlers {
  const refuse = async (): Promise<FetchHandlerResult> => {
    throw new FetchError('handler', 'not-implemented')
  }
  return {
    'npm-version': refuse,
    'git-commit': refuse,
    'upload-check': refuse,
    closure: refuse,
    artifact: refuse,
  }
}

/** Build connection deps for the fetch unit (policy + handlers). */
export function createFetchDeps(policy: FetchPolicy, handlers: FetchHandlers = unimplementedHandlers()) {
  if (policy.allow.length === 0) throw new FetchError('request', 'empty-allow')
  return { policy, handlers }
}

/** Strict policy object for the fetch service (hosts + optional git path prefixes). */
export function parseFetchPolicy(value: unknown): FetchPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FetchError('request', 'policy')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.allow) || record.allow.length === 0
    || record.allow.some(host => typeof host !== 'string' || host.length === 0)) {
    throw new FetchError('request', 'policy-allow')
  }
  const allow = record.allow as string[]
  if (record.gitPathPrefixes === undefined) return { allow }
  if (typeof record.gitPathPrefixes !== 'object' || record.gitPathPrefixes === null || Array.isArray(record.gitPathPrefixes)) {
    throw new FetchError('request', 'policy-git')
  }
  const gitPathPrefixes: Record<string, string[]> = {}
  for (const [host, prefixes] of Object.entries(record.gitPathPrefixes)) {
    if (!Array.isArray(prefixes) || prefixes.some(p => typeof p !== 'string' || !p.startsWith('/'))) {
      throw new FetchError('request', 'policy-git')
    }
    gitPathPrefixes[host] = prefixes as string[]
  }
  return { allow, gitPathPrefixes }
}
