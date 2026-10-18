/** The root helper: the only privileged step of the knowledge base service, split out so `dsh-kb` itself runs as an unprivileged account.
 *
 * Starting the user helper as a tree's owner (`systemd-run --uid`) needs root; nothing else does (the service owns `<kbRoot>`, so views
 * and hard-link swaps are its own, and instance units bind the trees when they start). Production runs `serveRootConnection` once per
 * connection of a socket-activated unit (`Accept=yes`) on a socket only the `dsh-kb` group can open. One request per connection:
 * a JSON header line `{verb, userId, args, input}` followed by exactly `input` bytes; one reply: `{ok:true, bytes}` and the bytes, or
 * `{ok:false, error[, detail]}`. The caller names only a user ID: the account, uid, gid and tree are re-derived and checked here, verbs are
 * the fixed helper set, every argument is checked against a per-verb whitelist, and the tree must be the canonical
 * `<storageRoot>/users/<account>/kb` with no symbolic link on the way and the owners of the host layout. */
import { lstat, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve as resolvePath } from 'node:path'
import { HELPER_OPS, type HelperOp } from './helper.ts'
import { HelperError, type HelperRunner, type UserTree } from './runner.ts'

/** Verbs the root helper accepts: exactly the user helper's operations. */
export const ROOT_VERBS: readonly HelperOp[] = HELPER_OPS
/** Header line limit. */
export const MAX_HEADER_BYTES = 16 * 1024
/** Largest binary input (the org conversion tar, 512 MiB, plus framing slack). */
export const MAX_INPUT_BYTES = 520 * 1024 * 1024
const MAX_OUTPUT_BYTES = 700 * 1024 * 1024

/** A refused or failed request; `message` is the wire code. */
export class RootHelperError extends Error {
  readonly detail: string | undefined
  constructor(code: 'request' | 'verb' | 'user' | 'args' | 'input' | 'tree' | 'helper', detail?: string) { super(code); this.detail = detail }
}

/** One validated request. */
export interface RootRequest { readonly verb: HelperOp; readonly userId: string; readonly args: Record<string, unknown>; readonly input: number }

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/
const KB_ID = /^kb_[a-z2-7]{16}$/
const JOB_ID = /^job_[a-z2-7]{16}$/
const SHA = /^[0-9a-f]{40,64}$/
const text = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 1000 && !/[\0-\x1f\x7f]/.test(value)
const relative = (value: unknown) => typeof value === 'string' && Buffer.byteLength(value) <= 400 && !/[\0-\x1f\x7f\\]/.test(value)
  && !value.startsWith('/') && !value.startsWith('-') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
const VALUES = new Map<string, (value: unknown) => boolean>([
  ['kb', value => typeof value === 'string' && KB_ID.test(value)],
  ['title', text],
  ['message', text],
  ['from', value => value === 'tar'],
  ['path', relative],
  ['pages', value => typeof value === 'boolean'],
  ['excludeRaw', value => typeof value === 'boolean'],
  ['rev', value => typeof value === 'string' && (value === 'HEAD' || SHA.test(value))],
  ['base', value => typeof value === 'string' && SHA.test(value)],
  ['job', value => typeof value === 'string' && JOB_ID.test(value)],
  ['mode', value => value === 'auto' || value === 'branch'],
  ['limit', value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100],
])
/** Per verb: required and optional argument names, and whether binary input is allowed. */
const RULES = new Map<HelperOp, { required: readonly string[]; optional: readonly string[]; input: boolean }>([
  ['init', { required: ['kb'], optional: ['title', 'from', 'message'], input: true }],
  ['put', { required: ['kb', 'path'], optional: ['pages', 'message'], input: true }],
  ['commit', { required: ['kb'], optional: ['message'], input: false }],
  ['head', { required: ['kb'], optional: ['rev'], input: false }],
  ['archive', { required: ['kb', 'rev'], optional: ['excludeRaw'], input: false }],
  ['stats', { required: ['kb'], optional: [], input: false }],
  ['apply', { required: ['kb', 'base', 'job', 'mode'], optional: ['message'], input: true }],
  ['log', { required: ['kb'], optional: ['limit'], input: false }],
  ['show', { required: ['kb', 'path'], optional: ['rev'], input: false }],
])

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Parse and validate one header line.
 * @param line JSON header (with or without the trailing newline).
 * @returns The request; throws `RootHelperError` naming the first refused part.
 */
export function parseRootRequest(line: string): RootRequest {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { throw new RootHelperError('request') }
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'args,input,userId,verb') throw new RootHelperError('request')
  const verb = raw.verb
  const rule = typeof verb === 'string' && (ROOT_VERBS as readonly string[]).includes(verb) ? RULES.get(verb as HelperOp) : undefined
  if (rule === undefined) throw new RootHelperError('verb')
  if (typeof raw.userId !== 'string' || !USER_ID.test(raw.userId)) throw new RootHelperError('user')
  const args = raw.args
  if (!plain(args)) throw new RootHelperError('args')
  const keys = Object.keys(args)
  if (rule.required.some(key => !keys.includes(key))) throw new RootHelperError('args')
  for (const key of keys) {
    if (!rule.required.includes(key) && !rule.optional.includes(key)) throw new RootHelperError('args')
    if (!VALUES.get(key)!(args[key])) throw new RootHelperError('args')
  }
  const input = raw.input
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > MAX_INPUT_BYTES || (input > 0 && !rule.input)) throw new RootHelperError('input')
  return { verb: verb as HelperOp, userId: raw.userId, args: { ...args }, input }
}

const ownedDirectory = async (path: string, uid: number) => {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw new RootHelperError('tree')
}

/** The canonical tree of one account, checked without following links: `<storageRoot>` is its own real path, `users` and
 * `users/<account>` are real directories owned by `rootUid` that nobody else may write, and `kb` is a real directory of `uid`.
 * The account's own directory is root-owned (the provisioner's layout), so the account cannot swap `kb` for a link after the check.
 * @param options Storage root and the uid that owns the layout (root in production).
 * @param account Derived account name.
 * @param uid The account's uid.
 * @returns `<storageRoot>/users/<account>/kb`.
 */
export async function canonicalKbDir(options: { readonly storageRoot: string; readonly rootUid?: number }, account: string, uid: number): Promise<string> {
  const root = options.storageRoot, rootUid = options.rootUid ?? 0
  if (!root.startsWith('/') || resolvePath(root) !== root || !ACCOUNT.test(account) || !Number.isSafeInteger(uid) || uid <= 0) throw new RootHelperError('tree')
  if (await realpath(root).catch(() => undefined) !== root) throw new RootHelperError('tree')
  const users = join(root, 'users'), home = join(users, account), kbDir = join(home, 'kb')
  await ownedDirectory(users, rootUid)
  await ownedDirectory(home, rootUid)
  await ownedDirectory(kbDir, uid)
  if (await realpath(kbDir).catch(() => undefined) !== kbDir) throw new RootHelperError('tree')
  return kbDir
}

/** What a connection needs: the host-side tree resolution and the privileged runner. */
export interface RootHelperDeps {
  /** Derive the account, ids and canonical tree from the user ID alone; undefined for an unknown user, `RootHelperError('tree')` for an unsafe one. */
  resolve(userId: string): Promise<UserTree | undefined>
  /** Start the user helper as `tree.uid`. */
  run(tree: UserTree, verb: HelperOp, args: Record<string, unknown>, input: Buffer): Promise<Buffer>
}

const reply = (write: (chunk: Buffer) => void, value: unknown) => write(Buffer.from(`${JSON.stringify(value)}\n`))

/** Serve one connection: read the header and exactly the announced input, validate, resolve, run, reply.
 * @param input The connection's bytes, ending when the caller half-closes.
 * @param write Writes reply bytes.
 * @param deps Resolution and runner.
 */
export async function serveRootConnection(input: AsyncIterable<Buffer>, write: (chunk: Buffer) => void, deps: RootHelperDeps): Promise<void> {
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
  let request: RootRequest | undefined, refusal: RootHelperError | undefined
  try { request = parseRootRequest(buffered.subarray(0, newline).toString('utf8')) } catch (error) { refusal = error instanceof RootHelperError ? error : new RootHelperError('request') }
  // Read to the caller's end either way, keeping at most the announced input.
  const want = request?.input ?? 0
  const chunks: Buffer[] = [buffered.subarray(newline + 1)]
  let size = chunks[0]!.length
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    size += next.value.length
    if (size <= want) chunks.push(next.value)
    if (size > MAX_INPUT_BYTES + 1) { await iterator.return?.(); break }
  }
  if (refusal === undefined && size !== want) refusal = new RootHelperError('input')
  if (refusal !== undefined || request === undefined) { reply(write, { ok: false, error: refusal?.message ?? 'request' }); return }
  let tree: UserTree | undefined
  try { tree = await deps.resolve(request.userId) } catch { reply(write, { ok: false, error: 'tree' }); return }
  if (tree === undefined) { reply(write, { ok: false, error: 'user' }); return }
  let output: Buffer
  try { output = await deps.run(tree, request.verb, request.args, Buffer.concat(chunks)) } catch (error) {
    const detail = error instanceof HelperError || error instanceof RootHelperError ? error.detail : undefined
    reply(write, { ok: false, error: 'helper', ...detail === undefined ? {} : { detail: detail.slice(0, 300) } })
    return
  }
  reply(write, { ok: true, bytes: output.length })
  write(output)
}

/** The service side: a `HelperRunner` that sends each operation to the root helper socket. Only `tree.userId` leaves the service;
 * the helper ignores every path and id the service holds.
 * @param options Socket path and timeout.
 * @returns Runner.
 */
export function createRootHelperRunner(options: { readonly socket: string; readonly timeoutMs?: number }): HelperRunner {
  return {
    run: (tree, op, args, input = Buffer.alloc(0)) => new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection(options.socket)
      const chunks: Buffer[] = []
      let size = 0, settled = false
      const finish = (error: Error | undefined, value?: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error); else resolve(value!)
      }
      const timer = setTimeout(() => finish(new HelperError('root-helper: timeout')), options.timeoutMs ?? 130_000)
      socket.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_OUTPUT_BYTES) finish(new HelperError('root-helper: reply too large')); else chunks.push(chunk) })
      socket.once('error', error => finish(new HelperError(`root-helper: ${(error as NodeJS.ErrnoException).code ?? 'connection'}`)))
      socket.once('end', () => {
        const all = Buffer.concat(chunks), newline = all.indexOf(0x0a)
        let head: { ok?: unknown; bytes?: unknown; error?: unknown; detail?: unknown }
        try { head = JSON.parse(all.subarray(0, newline).toString('utf8')) } catch { finish(new HelperError('root-helper: bad reply')); return }
        const body = all.subarray(newline + 1)
        if (head.ok === true && head.bytes === body.length) finish(undefined, body)
        else if (head.ok === false && head.error === 'helper' && typeof head.detail === 'string') finish(new HelperError(head.detail))
        else if (head.ok === false && typeof head.error === 'string') finish(new HelperError(`root-helper: ${head.error}`))
        else finish(new HelperError('root-helper: bad reply'))
      })
      socket.write(`${JSON.stringify({ verb: op, userId: tree.userId, args, input: input.length })}\n`)
      socket.end(input)
    }),
  }
}
