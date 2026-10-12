/** Own Chromium before CDP or Stagehand initialization can wait or fail. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { Browser, ChromeReleaseChannel, CDP_WEBSOCKET_ENDPOINT_REGEX, computeSystemExecutablePath, launch } from '@puppeteer/browsers'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { NativeBrowserConfig } from './native.ts'
import { CdpPipe } from './pipe-bridge.ts'

/**
 * Chromium's id for an unpacked extension: the first 128 bits of SHA-256 over its absolute path, as letters a-p.
 * @param directory - absolute extension directory exactly as passed to Extensions.loadUnpacked.
 * @returns the 32-letter extension id.
 */
export function unpackedExtensionId(directory: string): string {
  const hex = createHash('sha256').update(directory.replace(/\/+$/u, '')).digest('hex').slice(0, 32)
  return hex.replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)))
}

/**
 * The only origin allowed on Chromium's debugging port: Stagehand's bundled extension, which loads itself from its
 * package directory. Web pages in the same browser cannot open the port.
 * @returns `chrome-extension://<id>` for the pinned SDK's extension directory.
 */
export function stagehandExtensionOrigin(): string {
  const directory = process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH?.trim()
    || join(dirname(fileURLToPath(import.meta.resolve('@browserbasehq/stagehand'))), 'extension')
  return `chrome-extension://${unpackedExtensionId(directory)}`
}

/** Chromium process and profile owned independently of the Stagehand Worker. */
export interface OwnedChromium {
  /** Debugging pipe of this exact process (fd 3/4); the host's Stagehand Worker speaks CDP only here. */
  pipe: CdpPipe
  /**
   * Loopback WebSocket URL Chromium reports for its own debugging port. Stagehand 4.1's in-browser extension
   * connects to it (`browserCdpUrl`); the native runtime's owner-only loopback rule keeps other accounts out.
   */
  endpoint: string
  /** Kill the owned process tree, await child close, and remove its profile. */
  close(): Promise<void>
}

/**
 * Launch Chromium with scrubbed environment, a private debugging pipe, and an OS-allocated loopback port for the extension.
 * @param config - executable, window visibility, and startup deadline.
 * @param signal - cancellation before the caller receives browser ownership.
 * @returns the owned browser after its debugging endpoint is ready.
 */
export async function launchChromium(config: NativeBrowserConfig, signal: AbortSignal): Promise<OwnedChromium> {
  signal.throwIfAborted()
  const executablePath = config.executablePath
    ?? computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE })
  const profile = await mkdtemp(join(tmpdir(), 'dsh-stagehand-chrome-'))
  let browser: ReturnType<typeof launch> | undefined
  let closed: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    browser?.kill()
    await closed
    await rm(profile, { recursive: true, force: true })
  })()
  const abort = () => { void close().catch(() => {}) }
  try {
    signal.throwIfAborted()
    browser = launch({
      executablePath,
      args: [
        '--remote-debugging-pipe', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--enable-unsafe-extension-debugging', `--remote-allow-origins=${stagehandExtensionOrigin()}`,
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
        ...config.headless ? ['--headless=new'] : [],
        'about:blank',
      ],
      pipe: true, env: scrubbedParentEnv(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    })
    // Failed spawn emits error + close without exit; Process.hasClosed waits only for exit.
    const child = browser.nodeProcess
    closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    signal.addEventListener('abort', abort, { once: true })
    // A failed spawn reports only 'error' and 'close'; neither ends the pipe streams, so race them explicitly.
    const failed = new Promise<never>((_resolve, reject) => {
      child.once('error', (error: Error) => { reject(new Error(`Failed to launch the browser process: ${error.message}`, { cause: error })) })
      child.once('close', () => { reject(new Error('Failed to launch the browser process: it exited before its debugging pipe answered')) })
    })
    failed.catch(() => {})
    const stdio = child.stdio as unknown as [unknown, unknown, unknown, Writable, Readable]
    const pipe = new CdpPipe(stdio[3], stdio[4])
    await Promise.race([pipe.ready(config.operationTimeoutMs, signal), failed])
    const endpoint = await Promise.race([browser.waitForLineOutput(CDP_WEBSOCKET_ENDPOINT_REGEX, config.operationTimeoutMs), failed])
    signal.throwIfAborted()
    return { pipe, endpoint, close }
  } catch (error) {
    await close()
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
