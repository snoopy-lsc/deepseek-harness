import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(process.env.DSH_HOME)
})
await mkdir(process.env.DSH_HOME, { recursive: true })
await writeFile(join(process.env.DSH_HOME, 'started'), process.cwd())
await writeFile(join(process.env.DSH_HOME, 'system-home'), JSON.stringify({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }))
server.listen(0, '127.0.0.1', () => {
  process.send?.({
    kind: 'public-harness/web-ready',
    port: server.address().port,
    token: 'fixture-private-grant',
  })
})
process.on('message', message => {
  if (message?.kind === 'public-harness/stop') server.close(() => process.exit(0))
})
