/** Isolated browser runtime configures native inference in Stagehand's extension. */

import { MessagePort, parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { browserInputs, openNativeBrowser, stagehandModelSchema } from './native.ts'
import { answer } from './worker-rpc.ts'
import { PIPE_CDP_URL, pipeWebSocketClass } from './pipe-bridge.ts'

const port = parentPort
if (port === null) throw new Error('Stagehand attachment requires a Worker parent')
const { cdpPipe, ...data } = workerData as Record<string, unknown>
// An owned browser speaks CDP only over its pipe; Stagehand's global WebSocket is replaced in this Worker only.
// Stagehand's own Worker connection uses the pipe even though its URL names the browser's loopback port.
const pipeUrl = typeof data.cdpEndpoint === 'string' ? data.cdpEndpoint : PIPE_CDP_URL
if (cdpPipe instanceof MessagePort) Object.defineProperty(globalThis, 'WebSocket', { value: pipeWebSocketClass(cdpPipe, pipeUrl), configurable: true, writable: true })
else if (cdpPipe !== undefined) throw new Error('Stagehand cdpPipe must be a MessagePort')
const { extensionId, cdpEndpoint, executablePath, ...config } = z.object({
  model: stagehandModelSchema,
  mode: z.enum(['launch', 'attach']),
  cdpEndpoint: z.string().optional(),
  executablePath: z.string().optional(),
  extensionId: z.string().optional(),
  headless: z.boolean(),
  operationTimeoutMs: z.number().int().positive(),
  shutdownGraceMs: z.number().int().positive(),
}).parse(cdpPipe instanceof MessagePort ? { ...data, cdpEndpoint: pipeUrl } : data)
const methodSchema = z.enum(Object.keys(browserInputs) as [keyof typeof browserInputs, ...Array<keyof typeof browserInputs>])
const opening = openNativeBrowser(
  {
    ...config, ...extensionId === undefined ? {} : { extensionId },
    ...cdpEndpoint === undefined ? {} : { cdpEndpoint },
    ...executablePath === undefined ? {} : { executablePath },
  },
)
// Initialization failure stays observable through the host's ready request.
void opening.catch((error: unknown) => { void error })
port.on('message', (raw: unknown) => {
  void answer(raw, async (method, args) => {
    const native = await opening
    if (method === 'ready') return
    if (method === 'close') return native.close()
    return native.execute(methodSchema.parse(method), args)
  }).catch((error: unknown) => {
    console.error('Stagehand Worker protocol failed:', error)
    process.exit(1)
  })
})
