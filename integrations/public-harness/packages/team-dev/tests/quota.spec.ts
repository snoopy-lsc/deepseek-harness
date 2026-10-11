import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { startTeamDevQuota } from '../src/quota.ts'

describe('development model service', () => {
  it('rotates private credentials and keeps daily charges across restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'team-dev-quota-'))
    const baseWebPatch = join(storageRoot, 'base.patch.yml')
    await writeFile(baseWebPatch, '[]\n')
    const options = { storageRoot, baseWebPatch, users: [parseUserId('alice')],
      config: { modelId: 'fixture', contextWindow: 20, maxTokens: 5,
        personalDailyTokens: 50, siteDailyTokens: 100, personalConcurrency: 1, siteConcurrency: 2,
        busyTimeoutMs: 1000, maxBodyBytes: 4096, maxImagesPerRequest: 1,
        maxInlineImageBytes: 1024, maxEventBytes: 4096, maxFileBodyBytes: 4096,
        credentialLifetimeMs: 60_000, credentialRotateMs: 1000 } }
    let quota: Awaited<ReturnType<typeof startTeamDevQuota>> | undefined
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      quota = await startTeamDevQuota(options)
      const credentialPath = join(storageRoot, 'users', 'alice', 'home', 'quota-credential.json')
      const credential = async (): Promise<string> => {
        const parsed: { token: string } = JSON.parse(await readFile(credentialPath, 'utf8'))
        return parsed.token
      }
      const call = async (token: string): Promise<Response> => {
        const patch: Array<{ insert?: Array<{ config: { proxyBaseUrl: string } }> }> =
          JSON.parse(await readFile(quota!.patches.get(parseUserId('alice'))!, 'utf8'))
        return fetch(`${patch.at(-1)!.insert![0]!.config.proxyBaseUrl}/messages`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fixture', max_tokens: 5, stream: true,
            messages: [{ role: 'user', content: 'hello' }] }),
        })
      }
      const first = await credential()
      const response = await call(first)
      expect(response.status).toBe(200)
      expect((await response.text()).replace(/msg_[\w-]+/g, 'msg_fixture')).toMatchSnapshot()
      await vi.advanceTimersByTimeAsync(1000)
      await expect.poll(credential, { timeout: 5000 }).not.toBe(first)
      const second = await call(await credential())
      expect(second.status).toBe(200)
      await second.text()
      await quota.close()
      quota = undefined
      quota = await startTeamDevQuota(options)
      expect((await call(await credential())).status).toBe(402)
      expect((await call(first)).status).toBe(401)
    } finally {
      try { await quota?.close() } finally {
        vi.useRealTimers()
        await rm(storageRoot, { recursive: true, force: true })
      }
    }
  })
})
