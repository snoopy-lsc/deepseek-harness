/** One-request framing for the fetch service (KB root-helper shape, no userId). */
import {
  FETCH_VERBS,
  FetchError,
  plain,
  validateFetchArgs,
  type FetchPolicy,
  type FetchVerb,
  type ValidatedArgs,
} from './verbs.ts'

/** Header line limit. */
export const MAX_HEADER_BYTES = 16 * 1024
/** Largest binary input (upload tarball, 200 MiB design cap, plus framing slack). */
export const MAX_INPUT_BYTES = 210 * 1024 * 1024

/** One validated request after allowlist checks. */
export interface FetchRequest {
  readonly verb: FetchVerb
  readonly args: ValidatedArgs['args']
  readonly input: number
  readonly validated: ValidatedArgs
}

/** Per verb: whether binary input is allowed (required for upload-check when input > 0). */
const INPUT_ALLOWED: Record<FetchVerb, boolean> = {
  'npm-version': false,
  'git-commit': true, // deploy token as input for admin git
  'upload-check': true,
  closure: true,
  artifact: true,
}

/** Parse and validate one header line against the policy.
 * @param line JSON header (with or without trailing newline).
 */
export function parseFetchRequest(line: string, policy: FetchPolicy): FetchRequest {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { throw new FetchError('request') }
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'args,input,verb') throw new FetchError('request')
  const verbRaw = raw.verb
  if (typeof verbRaw !== 'string' || !(FETCH_VERBS as readonly string[]).includes(verbRaw)) throw new FetchError('verb')
  const verb = verbRaw as FetchVerb
  if (!plain(raw.args)) throw new FetchError('args')
  const validated = validateFetchArgs(verb, raw.args, policy)
  const input = raw.input
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > MAX_INPUT_BYTES) throw new FetchError('input')
  if (input > 0 && !INPUT_ALLOWED[verb]) throw new FetchError('input')
  if (verb === 'upload-check' && input === 0) throw new FetchError('input')
  return { verb, args: validated.args, input, validated }
}

export type FetchHandlerResult = Buffer | { readonly body: Buffer; readonly report?: Readonly<Record<string, unknown>> }

/** Handlers invoked only after framing and allowlist validation. Network work lives here (mocked in unit tests). */
export type FetchHandlers = {
  readonly [V in FetchVerb]: (args: Extract<ValidatedArgs, { verb: V }>['args'], input: Buffer) => Promise<FetchHandlerResult>
}

export interface FetchConnectionDeps {
  readonly policy: FetchPolicy
  readonly handlers: FetchHandlers
}

const reply = (write: (chunk: Buffer) => void, value: unknown) => write(Buffer.from(`${JSON.stringify(value)}\n`))

function asResult(value: FetchHandlerResult): { body: Buffer; report?: Record<string, unknown> } {
  if (Buffer.isBuffer(value)) return { body: value }
  return { body: value.body, ...value.report === undefined ? {} : { report: { ...value.report } } }
}

/** Serve one connection: read header + exact input, validate, run handler, reply.
 * Unknown verbs / bad args are refused before any handler (hence before network).
 */
export async function serveFetchConnection(
  input: AsyncIterable<Buffer>,
  write: (chunk: Buffer) => void,
  deps: FetchConnectionDeps,
): Promise<void> {
  const iterator = input[Symbol.asyncIterator]()
  let buffered = Buffer.alloc(0), newline = -1
  while (newline === -1) {
    const next = await iterator.next()
    if (next.done) break
    buffered = Buffer.concat([buffered, next.value])
    newline = buffered.subarray(0, MAX_HEADER_BYTES + 1).indexOf(0x0a)
    if (newline === -1 && buffered.length > MAX_HEADER_BYTES) break
  }
  if (newline === -1) { await iterator.return?.(); reply(write, { ok: false, error: 'request' }); return }

  let request: FetchRequest | undefined
  let refusal: FetchError | undefined
  try {
    request = parseFetchRequest(buffered.subarray(0, newline).toString('utf8'), deps.policy)
  } catch (error) {
    refusal = error instanceof FetchError ? error : new FetchError('request')
  }

  const want = request?.input ?? 0
  const chunks: Buffer[] = [buffered.subarray(newline + 1)]
  let size = chunks[0]!.length
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    size += next.value.length
    if (size <= want) chunks.push(next.value)
    if (size > MAX_INPUT_BYTES + 1) { await iterator.return?.(); break }
  }
  if (refusal === undefined && size !== want) refusal = new FetchError('input')
  if (refusal !== undefined || request === undefined) {
    reply(write, { ok: false, error: refusal?.message ?? 'request' })
    return
  }

  const handler = deps.handlers[request.verb] as (args: FetchRequest['args'], input: Buffer) => Promise<FetchHandlerResult>
  let result: { body: Buffer; report?: Record<string, unknown> }
  try {
    result = asResult(await handler(request.args, Buffer.concat(chunks)))
  } catch (error) {
    const detail = error instanceof FetchError ? error.detail : undefined
    reply(write, { ok: false, error: 'handler', ...detail === undefined ? {} : { detail: detail.slice(0, 300) } })
    return
  }
  reply(write, { ok: true, bytes: result.body.length, ...result.report === undefined ? {} : { report: result.report } })
  write(result.body)
}
