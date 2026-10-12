/** Chromium `--remote-debugging-pipe` transport carried into the Stagehand Worker without any TCP listener. */

import type { MessagePort } from 'node:worker_threads'
import type { Readable, Writable } from 'node:stream'

/** Sentinel URL for a pipe-backed WebSocket when no browser-reported URL is supplied (tests). */
export const PIPE_CDP_URL = 'ws://cdp-pipe.invalid/devtools/browser/pipe'

/** Host-to-Worker frames. */
type HostFrame = { type: 'message'; data: string } | { type: 'close' }

/** NUL-delimited JSON over Chromium's fd 3 (to browser) and fd 4 (from browser). */
export class CdpPipe {
  #buffer = ''
  #closed = false
  #listeners = new Set<(message: string) => void>()
  #closeListeners = new Set<() => void>()

  /** @param toBrowser Chromium fd 3. @param fromBrowser Chromium fd 4. */
  constructor(private readonly toBrowser: Writable, fromBrowser: Readable) {
    fromBrowser.setEncoding('utf8')
    fromBrowser.on('data', (chunk: string) => {
      this.#buffer += chunk
      let end: number
      while ((end = this.#buffer.indexOf('\0')) >= 0) {
        const message = this.#buffer.slice(0, end)
        this.#buffer = this.#buffer.slice(end + 1)
        for (const listener of this.#listeners) listener(message)
      }
    })
    const close = () => {
      if (this.#closed) return
      this.#closed = true
      for (const listener of this.#closeListeners) listener()
    }
    fromBrowser.once('end', close); fromBrowser.once('close', close); fromBrowser.once('error', close)
    toBrowser.once('error', close)
  }

  /** Whether the browser side has ended. */
  get closed(): boolean { return this.#closed }

  /** Send one JSON message; NUL inside a message would split it and is refused.
   * @param message Serialized CDP message.
   */
  send(message: string): void {
    if (this.#closed) throw new Error('CDP pipe is closed')
    if (message.includes('\0')) throw new Error('CDP message contains NUL')
    this.toBrowser.write(`${message}\0`)
  }

  /** Subscribe to complete messages.
   * @param listener Receives each complete message.
   * @returns The unsubscribe function.
   */
  onMessage(listener: (message: string) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener) }
  }

  /** Subscribe to browser-side close; called at most once.
   * @param listener Called when the browser side ends.
   * @returns The unsubscribe function.
   */
  onClose(listener: () => void): () => void {
    if (this.#closed) { queueMicrotask(listener); return () => {} }
    this.#closeListeners.add(listener); return () => { this.#closeListeners.delete(listener) }
  }

  /**
   * Wait until the browser answers one request on this pipe.
   * @param timeoutMs - startup deadline.
   * @param signal - cancellation.
   */
  async ready(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const id = 2_147_483_647
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const offMessage = this.onMessage((message) => {
      try { if ((JSON.parse(message) as { id?: unknown }).id === id) resolve() } catch { /* not JSON: keep waiting */ }
    })
    const offClose = this.onClose(() => { reject(new Error('Chromium closed its debugging pipe during startup')) })
    const timer = setTimeout(() => { reject(new Error('Chromium debugging pipe did not answer in time')) }, timeoutMs)
    const abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.send(JSON.stringify({ id, method: 'Browser.getVersion' }))
      await promise
    } finally {
      offMessage(); offClose(); clearTimeout(timer); signal.removeEventListener('abort', abort)
    }
  }
}

/** Request ids at or above this value belong to the host (readiness probe, session cleanup) and are never relayed. */
const HOST_ID_BASE = 2_000_000_000
let hostId = HOST_ID_BASE

/**
 * Relay one Worker port to the pipe until either side closes.
 * A WebSocket client's sessions and the extensions it loaded end when its socket closes; the pipe outlives each
 * Worker, so detaching uninstalls the extensions this client loaded and detaches every session it attached,
 * giving the next Worker the state a fresh WebSocket client would see.
 * @param pipe - the owned browser's debugging pipe.
 * @param port - host end of a MessageChannel whose other end the Worker holds.
 * @returns detach, which closes the port without closing the browser.
 */
export function bridgeCdpPipe(pipe: CdpPipe, port: MessagePort): () => void {
  let detached = false
  const sessions = new Set<string>()
  const extensions = new Set<string>()
  const loads = new Set<number>()
  const offMessage = pipe.onMessage((data) => {
    let message: { id?: unknown; method?: unknown; params?: { sessionId?: unknown }; result?: { sessionId?: unknown } }
    try { message = JSON.parse(data) as typeof message } catch { return }
    if (typeof message.id === 'number' && message.id >= HOST_ID_BASE) return
    if (message.method === 'Target.attachedToTarget' && typeof message.params?.sessionId === 'string') sessions.add(message.params.sessionId)
    if (message.method === 'Target.detachedFromTarget' && typeof message.params?.sessionId === 'string') sessions.delete(message.params.sessionId)
    if (typeof message.result?.sessionId === 'string') sessions.add(message.result.sessionId)
    if (typeof message.id === 'number' && loads.delete(message.id) && typeof (message.result as { id?: unknown } | undefined)?.id === 'string') {
      extensions.add((message.result as { id: string }).id)
    }
    port.postMessage({ type: 'message', data } satisfies HostFrame)
  })
  const detach = () => {
    if (detached) return
    detached = true
    offMessage(); offClose()
    port.close()
    if (pipe.closed) return
    const cleanup = [
      ...[...extensions].map(id => ({ method: 'Extensions.uninstall', params: { id } })),
      ...[...sessions].map(sessionId => ({ method: 'Target.detachFromTarget', params: { sessionId } })),
    ]
    for (const command of cleanup) {
      hostId = hostId >= 2_147_483_000 ? HOST_ID_BASE : hostId + 1
      try { pipe.send(JSON.stringify({ id: hostId, ...command })) } catch { return }
    }
  }
  const offClose = pipe.onClose(() => { port.postMessage({ type: 'close' } satisfies HostFrame); detach() })
  port.on('message', (data: unknown) => {
    if (typeof data === 'string') {
      try {
        const request = JSON.parse(data) as { id?: unknown; method?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'number' || request.id >= HOST_ID_BASE) { detach(); return }
        if (request.method === 'Extensions.loadUnpacked' && request.sessionId === undefined) loads.add(request.id)
        pipe.send(data)
      } catch { detach() }
    }
    else detach()
  })
  port.on('close', detach)
  return detach
}

interface Listener { (event: { data?: unknown; code?: number }): void }

/** The WebSocket surface Stagehand's CDP client uses. */
export interface PipeWebSocketLike {
  readonly url: string
  readyState: number
  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void
  removeEventListener(type: string, listener: Listener): void
  send(data: string): void
  close(): void
}

/** Constructor installed as the Worker's global WebSocket. */
export interface PipeWebSocketConstructor {
  new (url: string | URL): PipeWebSocketLike
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

/**
 * WebSocket-shaped client over a Worker MessagePort, enough for Stagehand's CDP client.
 * @param port - Worker end of the bridge.
 * @param acceptedUrl - the one URL this constructor accepts; Stagehand forwards it to its extension as `browserCdpUrl`.
 * @returns a constructor that carries that URL over the pipe and refuses every other URL.
 */
export function pipeWebSocketClass(port: MessagePort, acceptedUrl = PIPE_CDP_URL): PipeWebSocketConstructor {
  let used = false
  return class PipeWebSocket {
    static readonly CONNECTING = 0 as const
    static readonly OPEN = 1 as const
    static readonly CLOSING = 2 as const
    static readonly CLOSED = 3 as const
    readyState = 0
    readonly url: string
    #listeners = new Map<string, Set<{ listener: Listener; once: boolean }>>()

    constructor(url: string | URL) {
      this.url = String(url)
      if (this.url !== acceptedUrl) throw new Error('Only the owned browser pipe can be opened from this Worker')
      if (used) throw new Error('The browser pipe is already connected')
      used = true
      port.on('message', (frame: HostFrame) => {
        if (frame.type === 'message') this.#emit('message', { data: frame.data })
        else this.#finish()
      })
      port.on('close', () => { this.#finish() })
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.#emit('open', {})
      })
    }

    addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
      const set = this.#listeners.get(type) ?? new Set()
      set.add({ listener, once: options?.once === true }); this.#listeners.set(type, set)
    }

    removeEventListener(type: string, listener: Listener): void {
      const set = this.#listeners.get(type)
      if (set === undefined) return
      for (const entry of set) if (entry.listener === listener) set.delete(entry)
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new Error('CDP pipe is not open')
      port.postMessage(data)
    }

    close(): void {
      if (this.readyState >= 2) return
      port.postMessage({ type: 'close' })
      this.#finish()
    }

    #finish(): void {
      if (this.readyState === 3) return
      this.readyState = 3
      port.close()
      this.#emit('close', { code: 1000 })
    }

    #emit(type: string, event: { data?: unknown; code?: number }): void {
      const set = this.#listeners.get(type)
      if (set === undefined) return
      for (const entry of [...set]) {
        if (entry.once) set.delete(entry)
        entry.listener(event)
      }
    }
  }
}
