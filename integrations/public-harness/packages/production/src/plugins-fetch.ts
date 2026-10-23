#!/usr/bin/env node
/** Production entry for `dsh-plugins-fetch@.service`: one validated fetch verb per socket connection.
 *
 * Reads `/etc/dsh-public/plugins.json` (allowlist + egress port), speaks the KB-helper framing on
 * stdin/stdout (`StandardInput=socket`), and refuses unknown verbs / args before any network work.
 * Real mirror handlers land in 1A.4; this entry wires policy and unimplemented stubs until then.
 * Usage: `plugins-fetch <plugins.json>` with the connection on stdin and stdout. */
import {
  createFetchDeps,
  parseFetchPolicy,
  serveFetchConnection,
  unimplementedHandlers,
} from '@public-harness/plugins'
import { exactRecord, readConfigFile } from './config-file.ts'

/** Fetch-relevant slice of `plugins.json`. */
export interface PluginsFetchConfig {
  readonly egressPort: number
  readonly allow: readonly string[]
  readonly gitPathPrefixes: Readonly<Record<string, readonly string[]>>
  readonly intranet: Readonly<Record<string, readonly string[]>>
}

function port(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port`)
  }
  return value
}

/** Read `egressPort`, `egress.allow`, optional `egress.gitPathPrefixes` / `egress.intranet`. */
export function parsePluginsFetchConfig(value: unknown): PluginsFetchConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('plugins fetch configuration must be an object')
  }
  const record = value as Record<string, unknown>
  if (!('egressPort' in record) || !('egress' in record)) {
    throw new Error('plugins fetch configuration needs egressPort and egress')
  }
  const egressKeys = Object.keys(record.egress as object)
  const optional = ['intranet', 'gitPathPrefixes'].filter(key => egressKeys.includes(key))
  const egress = exactRecord(record.egress, ['allow', ...optional], 'egress')
  if (!Array.isArray(egress.allow) || egress.allow.some(host => typeof host !== 'string' || host.length === 0)) {
    throw new Error('egress.allow must be a list of host names')
  }
  const gitPathPrefixes: Record<string, string[]> = {}
  if (egress.gitPathPrefixes !== undefined) {
    if (typeof egress.gitPathPrefixes !== 'object' || egress.gitPathPrefixes === null || Array.isArray(egress.gitPathPrefixes)) {
      throw new Error('egress.gitPathPrefixes must be a host-to-prefix map')
    }
    for (const [host, prefixes] of Object.entries(egress.gitPathPrefixes)) {
      if (!Array.isArray(prefixes) || prefixes.some(p => typeof p !== 'string' || !p.startsWith('/'))) {
        throw new Error(`egress.gitPathPrefixes[${host}] must be a list of absolute path prefixes`)
      }
      gitPathPrefixes[host] = prefixes as string[]
    }
  }
  const intranet: Record<string, string[]> = {}
  if (egress.intranet !== undefined) {
    if (typeof egress.intranet !== 'object' || egress.intranet === null || Array.isArray(egress.intranet)) {
      throw new Error('egress.intranet must be a host-to-CIDR map')
    }
    for (const [host, cidrs] of Object.entries(egress.intranet)) {
      if (!Array.isArray(cidrs) || cidrs.some(cidr => typeof cidr !== 'string' || !cidr.includes('/'))) {
        throw new Error(`egress.intranet[${host}] must be a list of CIDRs`)
      }
      intranet[host] = cidrs as string[]
    }
  }
  return {
    egressPort: port(record.egressPort, 'egressPort'),
    allow: egress.allow as string[],
    gitPathPrefixes,
    intranet,
  }
}

const invoked = process.argv[1] !== undefined && /plugins-fetch\.(?:js|ts)$/.test(process.argv[1])
if (invoked) {
  void (async () => {
    try {
      const [file] = process.argv.slice(2)
      if (file === undefined) throw new Error('usage: plugins-fetch <plugins.json>')
      const parsed = parsePluginsFetchConfig(await readConfigFile(file))
      const policy = parseFetchPolicy({
        allow: parsed.allow,
        ...Object.keys(parsed.gitPathPrefixes).length === 0 ? {} : { gitPathPrefixes: parsed.gitPathPrefixes },
      })
      // HTTPS_PROXY is set by the unit to 127.0.0.1:<egressPort>; handlers in 1A.4 honour it.
      void parsed.egressPort
      const deps = createFetchDeps(policy, unimplementedHandlers())
      await serveFetchConnection(
        process.stdin.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>,
        chunk => process.stdout.write(chunk),
        deps,
      )
    } catch (error) {
      process.stderr.write(`plugins-fetch: ${(error as Error).message.slice(0, 300)}\n`)
      process.exitCode = 1
    }
  })()
}
