/** External Chromium process fixture; the DSH launcher still owns profile cleanup. */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { FixtureBrowser, fixture } from './stagehand.ts'

export const Browser = { CHROME: 'chrome' }
export const ChromeReleaseChannel = { STABLE: 'stable' }
export const CDP_WEBSOCKET_ENDPOINT_REGEX = /^DevTools listening on (ws:\/\/.*)$/
export const computeSystemExecutablePath = () => '/fixture/chromium'

export function launch(options: { executablePath: string; args: string[] }) {
  const browser = new FixtureBrowser('launched', {
    executablePath: options.executablePath, headless: options.args.includes('--headless=new'),
  })
  fixture.browsers.push(browser)
  const endpoint = `http://fixture/${fixture.browsers.length}`
  fixture.connections.set(endpoint, browser)
  // Fake pipe peer: answers every request, and `Fixture.endpoint` names the fixture connection for in-host workers.
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough()
  let buffered = ''
  toBrowser.setEncoding('utf8')
  toBrowser.on('data', (chunk: string) => {
    buffered += chunk
    let end: number
    while ((end = buffered.indexOf('\0')) >= 0) {
      const request = JSON.parse(buffered.slice(0, end)) as { id: number; method: string }
      buffered = buffered.slice(end + 1)
      fromBrowser.write(`${JSON.stringify({ id: request.id, result: request.method === 'Fixture.endpoint' ? { endpoint } : {} })}\0`)
    }
  })
  const nodeProcess = Object.assign(new EventEmitter(), { stdio: [null, null, null, toBrowser, fromBrowser] })
  return {
    nodeProcess,
    waitForLineOutput: () => Promise.resolve(endpoint),
    kill() { void browser.close().then(() => { fromBrowser.end(); nodeProcess.emit('close', 0) }) },
  }
}
