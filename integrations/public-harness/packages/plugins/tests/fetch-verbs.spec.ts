/** Fetch service framing and per-verb allowlists: refuse before any network work. */
import { describe, expect, it, vi } from 'vitest'
import {
  FETCH_VERBS,
  FetchError,
  parseFetchRequest,
  serveFetchConnection,
  type FetchHandlers,
  type FetchPolicy,
} from '../src/fetch/server.ts'

const ALLOW = ['registry.npmjs.org', 'git.corp.example'] as const
const POLICY: FetchPolicy = {
  allow: ALLOW,
  gitPathPrefixes: { 'git.corp.example': ['/team/', '/org/plugins/'] },
}

const header = (value: unknown) => `${JSON.stringify(value)}\n`

function handlers(overrides: Partial<FetchHandlers> = {}): FetchHandlers & { network: ReturnType<typeof vi.fn> } {
  const network = vi.fn(async () => Buffer.from('ok'))
  return {
    network,
    'npm-version': network,
    'git-commit': network,
    'upload-check': network,
    closure: network,
    artifact: network,
    ...overrides,
  }
}

async function serve(
  chunks: string[],
  policy: FetchPolicy = POLICY,
  h: FetchHandlers = handlers(),
): Promise<{ reply: string; h: FetchHandlers }> {
  const out: Buffer[] = []
  const frames = async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk)
  }
  await serveFetchConnection(frames(), chunk => out.push(chunk), { policy, handlers: h })
  return { reply: Buffer.concat(out).toString('utf8'), h }
}

describe('fetch request framing', () => {
  it('accepts_only_the_fixed_verb_set', () => {
    expect([...FETCH_VERBS].sort()).toEqual(['artifact', 'closure', 'git-commit', 'npm-version', 'upload-check'])
    for (const verb of ['rm', 'exec', 'npm', 'NPM-VERSION', ' npm-version', 'npm-version\n', '__proto__']) {
      expect(() => parseFetchRequest(header({ verb, args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0' }, input: 0 }), POLICY)).toThrow(FetchError)
      expect(() => parseFetchRequest(header({ verb, args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0' }, input: 0 }), POLICY)).toThrow(/verb/)
    }
    expect(parseFetchRequest(header({
      verb: 'npm-version',
      args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0' },
      input: 0,
    }), POLICY)).toMatchObject({ verb: 'npm-version', input: 0 })
  })

  it('refuses_unknown_keys_and_extra_args', () => {
    expect(() => parseFetchRequest(header({
      verb: 'npm-version',
      args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0', extra: true },
      input: 0,
    }), POLICY)).toThrow(/args/)
    expect(() => parseFetchRequest(header({
      verb: 'upload-check',
      args: { name: 'x' },
      input: 1,
    }), POLICY)).toThrow(/args/)
    expect(() => parseFetchRequest(header({
      verb: 'npm-version',
      args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0' },
      input: 0,
      userId: 'x',
    }), POLICY)).toThrow(/request/)
    expect(() => parseFetchRequest(header({
      verb: 'stats',
      args: {},
      input: 0,
    }), POLICY)).toThrow(/verb/)
    expect(() => parseFetchRequest('{"verb":"npm-version"', POLICY)).toThrow(/request/)
    expect(() => parseFetchRequest(header({
      verb: 'npm-version',
      args: JSON.parse('{"__proto__":{"x":1},"registry":"registry.npmjs.org","name":"left-pad","version":"1.0.0"}'),
      input: 0,
    }), POLICY)).toThrow(/args/)
  })

  it('refuses_path_dotdot_and_non_semver_before_network', async () => {
    const h = handlers()
    for (const path of ['../etc/passwd', 'pkg/../../x', '/abs', 'a//b', 'a/./b', '']) {
      expect(() => parseFetchRequest(header({
        verb: 'git-commit',
        args: { url: 'https://git.corp.example/team/pkg', commit: 'a'.repeat(40), path },
        input: 0,
      }), POLICY), path).toThrow(/args/)
    }
    for (const version of ['^1.0.0', '~1.0.0', '*', 'latest', '1', '1.0', 'v1.0.0', '1.0.0 ', ' 1.0.0', '>=1.0.0', '']) {
      // ranges, tags, incomplete versions, and v-prefix are not exact SemVer
      expect(() => parseFetchRequest(header({
        verb: 'npm-version',
        args: { registry: 'registry.npmjs.org', name: 'left-pad', version },
        input: 0,
      }), POLICY), version).toThrow(/args/)
    }
    const { reply } = await serve([header({
      verb: 'git-commit',
      args: { url: 'https://git.corp.example/team/pkg', commit: 'a'.repeat(40), path: '../secret' },
      input: 0,
    })], POLICY, h)
    expect(reply).toBe(`${JSON.stringify({ ok: false, error: 'args' })}\n`)
    expect(h.network).not.toHaveBeenCalled()

    const h2 = handlers()
    const bad = await serve([header({
      verb: 'npm-version',
      args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '^1.2.3' },
      input: 0,
    })], POLICY, h2)
    expect(bad.reply).toBe(`${JSON.stringify({ ok: false, error: 'args' })}\n`)
    expect(h2.network).not.toHaveBeenCalled()
  })

  it('refuses_disallowed_registry_host_and_git_url_before_network', async () => {
    const h = handlers()
    expect(() => parseFetchRequest(header({
      verb: 'npm-version',
      args: { registry: 'evil.example', name: 'left-pad', version: '1.0.0' },
      input: 0,
    }), POLICY)).toThrow(/args/)
    expect(() => parseFetchRequest(header({
      verb: 'git-commit',
      args: { url: 'https://evil.example/team/pkg', commit: 'a'.repeat(40), path: 'pkg' },
      input: 0,
    }), POLICY)).toThrow(/args/)
    expect(() => parseFetchRequest(header({
      verb: 'git-commit',
      args: { url: 'https://git.corp.example/other/pkg', commit: 'a'.repeat(40), path: 'pkg' },
      input: 0,
    }), POLICY)).toThrow(/args/)
    expect(() => parseFetchRequest(header({
      verb: 'git-commit',
      args: { url: 'http://git.corp.example/team/pkg', commit: 'a'.repeat(40), path: 'pkg' },
      input: 0,
    }), POLICY)).toThrow(/args/)

    const { reply } = await serve([header({
      verb: 'npm-version',
      args: { registry: 'https://evil.example/', name: 'left-pad', version: '1.0.0' },
      input: 0,
    })], POLICY, h)
    expect(reply).toBe(`${JSON.stringify({ ok: false, error: 'args' })}\n`)
    expect(h.network).not.toHaveBeenCalled()
  })

  it('refuses_unknown_verb_on_the_wire_without_calling_handlers', async () => {
    const h = handlers()
    const { reply } = await serve([header({
      verb: 'exec',
      args: {},
      input: 0,
    })], POLICY, h)
    expect(reply).toBe(`${JSON.stringify({ ok: false, error: 'verb' })}\n`)
    expect(h.network).not.toHaveBeenCalled()
  })
})

describe('fetch request acceptance', () => {
  it('accepts_valid_npm_version_git_commit_upload_closure_artifact', () => {
    expect(parseFetchRequest(header({
      verb: 'npm-version',
      args: { registry: 'https://registry.npmjs.org', name: '@corp-dsh/demo', version: '1.2.3-beta.1+build.4' },
      input: 0,
    }), POLICY).args).toEqual({
      registry: 'registry.npmjs.org',
      name: '@corp-dsh/demo',
      version: '1.2.3-beta.1+build.4',
    })
    expect(parseFetchRequest(header({
      verb: 'git-commit',
      args: { url: 'https://git.corp.example/team/dsh-example', commit: 'b'.repeat(40), path: 'packages/foo' },
      input: 0,
    }), POLICY).args).toMatchObject({
      host: 'git.corp.example',
      pathPrefix: '/team/',
      commit: 'b'.repeat(40),
      path: 'packages/foo',
    })
    expect(parseFetchRequest(header({
      verb: 'upload-check',
      args: {},
      input: 12,
    }), POLICY)).toMatchObject({ verb: 'upload-check', input: 12 })
    expect(parseFetchRequest(header({
      verb: 'closure',
      args: { name: 'left-pad', version: '1.0.0', registry: 'registry.npmjs.org' },
      input: 4,
    }), POLICY).verb).toBe('closure')
    expect(parseFetchRequest(header({
      verb: 'artifact',
      args: { versionId: 'plv_abcdefghijklmnop' },
      input: 8,
    }), POLICY).args).toEqual({ versionId: 'plv_abcdefghijklmnop' })
  })

  it('runs_handler_only_after_validation', async () => {
    const h = handlers()
    const body = Buffer.from('artifact-bytes')
    h['npm-version'] = vi.fn(async () => ({ body, report: { mode: 'stub' } }))
    const { reply } = await serve([header({
      verb: 'npm-version',
      args: { registry: 'registry.npmjs.org', name: 'left-pad', version: '1.0.0' },
      input: 0,
    })], POLICY, h)
    expect(h['npm-version']).toHaveBeenCalledOnce()
    expect(reply.startsWith(`${JSON.stringify({ ok: true, bytes: body.length, report: { mode: 'stub' } })}\n`)).toBe(true)
    expect(reply.endsWith(body.toString('utf8'))).toBe(true)
  })

  it('refuses_input_length_mismatch_without_running_handlers', async () => {
    const h = handlers()
    const { reply } = await serve([
      header({ verb: 'upload-check', args: {}, input: 5 }),
      'abcd',
    ], POLICY, h)
    expect(reply).toBe(`${JSON.stringify({ ok: false, error: 'input' })}\n`)
    expect(h.network).not.toHaveBeenCalled()
  })
})
