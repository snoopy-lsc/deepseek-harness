/** The pipe bridge replaces Stagehand's TCP CDP URL; a fake peer stands in for Chromium's fd 3/4. */

import { PassThrough } from 'node:stream'
import { MessageChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { CdpPipe, PIPE_CDP_URL, bridgeCdpPipe, pipeWebSocketClass } from '../src/pipe-bridge.ts'

function fakePeer() {
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough()
  const received: string[] = []
  let buffer = ''
  toBrowser.setEncoding('utf8')
  toBrowser.on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\0')) >= 0) { received.push(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
  })
  return { toBrowser, fromBrowser, received, pipe: new CdpPipe(toBrowser, fromBrowser) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

it('frames NUL-delimited messages across and within chunks and refuses embedded NUL', async () => {
  const peer = fakePeer(), seen: string[] = []
  peer.pipe.onMessage((message) => { seen.push(message) })
  peer.fromBrowser.write('{"id":1,'); peer.fromBrowser.write('"result":{}}\0{"method":"A"}\0{"met')
  peer.fromBrowser.write('hod":"B"}\0')
  await tick()
  expect(seen).toEqual(['{"id":1,"result":{}}', '{"method":"A"}', '{"method":"B"}'])
  peer.pipe.send('{"id":2}')
  await tick()
  expect(peer.received).toEqual(['{"id":2}'])
  expect(() => { peer.pipe.send('{"x":"\0"}') }).toThrow('NUL')
})

it('waits for the readiness answer and fails when the peer closes or stays silent', async () => {
  const answering = fakePeer()
  answering.toBrowser.on('data', () => { answering.fromBrowser.write('{"id":2147483647,"result":{"product":"fake"}}\0') })
  await answering.pipe.ready(1000, new AbortController().signal)
  const closing = fakePeer()
  const closed = closing.pipe.ready(1000, new AbortController().signal)
  closing.fromBrowser.end()
  await expect(closed).rejects.toThrow('closed its debugging pipe')
  await expect(fakePeer().pipe.ready(20, new AbortController().signal)).rejects.toThrow('did not answer')
})

it('carries CDP between the Worker WebSocket shim and the pipe, then closes on browser exit', async () => {
  const peer = fakePeer(), channel = new MessageChannel()
  const detach = bridgeCdpPipe(peer.pipe, channel.port1)
  const PipeWebSocket = pipeWebSocketClass(channel.port2)
  expect(() => new PipeWebSocket('ws://127.0.0.1:9222/devtools/browser/x')).toThrow('Only the owned browser pipe')
  const socket = new PipeWebSocket(PIPE_CDP_URL)
  expect(() => new PipeWebSocket(PIPE_CDP_URL)).toThrow('already connected')
  const events: string[] = []
  await new Promise<void>((resolve) => { socket.addEventListener('open', () => { events.push('open'); resolve() }, { once: true }) })
  expect(socket.readyState).toBe(PipeWebSocket.OPEN)
  socket.addEventListener('message', (event) => { events.push(String(event.data)) })
  socket.addEventListener('close', () => { events.push('close') })
  socket.send('{"id":1,"method":"Target.getTargets"}')
  await tick()
  expect(peer.received).toEqual(['{"id":1,"method":"Target.getTargets"}'])
  peer.fromBrowser.write('{"id":1,"result":{"targetInfos":[]}}\0')
  await tick()
  expect(events).toEqual(['open', '{"id":1,"result":{"targetInfos":[]}}'])
  peer.fromBrowser.end()
  await tick()
  expect(events.at(-1)).toBe('close')
  expect(socket.readyState).toBe(PipeWebSocket.CLOSED)
  expect(() => { socket.send('{}') }).toThrow('not open')
  detach()
})

it('closing the Worker socket detaches without ending the browser pipe', async () => {
  const peer = fakePeer(), channel = new MessageChannel()
  bridgeCdpPipe(peer.pipe, channel.port1)
  const socket = new (pipeWebSocketClass(channel.port2))(PIPE_CDP_URL)
  await tick()
  socket.close()
  await tick()
  expect(peer.pipe.closed).toBe(false)
  expect(peer.toBrowser.writableEnded).toBe(false)
  const next = new MessageChannel(), seen: string[] = []
  bridgeCdpPipe(peer.pipe, next.port1)
  next.port2.on('message', (frame: { data: string }) => { seen.push(frame.data) })
  peer.fromBrowser.write('{"method":"Target.targetCreated"}\0')
  await tick()
  expect(seen).toEqual(['{"method":"Target.targetCreated"}'])
  next.port2.close()
})

it('uninstalls extensions and detaches sessions a closed client created, and hides host-owned ids', async () => {
  const peer = fakePeer(), channel = new MessageChannel(), seen: string[] = []
  const detach = bridgeCdpPipe(peer.pipe, channel.port1)
  channel.port2.on('message', (frame: { data?: string }) => { if (frame.data !== undefined) seen.push(frame.data) })
  channel.port2.postMessage('{"id":7,"method":"Extensions.loadUnpacked","params":{"path":"/ext"}}')
  await tick()
  expect(peer.received).toEqual(['{"id":7,"method":"Extensions.loadUnpacked","params":{"path":"/ext"}}'])
  peer.received.length = 0
  peer.fromBrowser.write('{"id":7,"result":{"id":"extension-id"}}\0')
  peer.fromBrowser.write('{"method":"Target.attachedToTarget","params":{"sessionId":"A"}}\0{"id":4,"result":{"sessionId":"B"}}\0')
  peer.fromBrowser.write('{"method":"Target.attachedToTarget","params":{"sessionId":"C"}}\0{"method":"Target.detachedFromTarget","params":{"sessionId":"C"}}\0')
  peer.fromBrowser.write('{"id":2000000005,"result":{}}\0')
  await tick()
  expect(seen).toHaveLength(5)
  detach()
  await tick()
  type Cleanup = { id: number; method: string; params: { sessionId?: string; id?: string } }
  const cleanup = peer.received.map(message => JSON.parse(message) as Cleanup)
  expect(cleanup.map(message => [message.method, message.params.sessionId ?? message.params.id]))
    .toEqual([['Extensions.uninstall', 'extension-id'], ['Target.detachFromTarget', 'A'], ['Target.detachFromTarget', 'B']])
  expect(cleanup.every(message => message.id >= 2_000_000_000)).toBe(true)
})

it('drops a client that uses a host-reserved id or sends a non-request', async () => {
  for (const bad of ['{"id":2147483647,"method":"Browser.close"}', 'not json', '{"method":"Browser.close"}']) {
    const peer = fakePeer(), channel = new MessageChannel()
    bridgeCdpPipe(peer.pipe, channel.port1)
    const closed = new Promise((resolve) => { channel.port2.once('close', resolve) })
    channel.port2.postMessage(bad)
    await closed
    expect(peer.received).toEqual([])
  }
})
