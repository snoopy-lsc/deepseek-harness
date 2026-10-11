import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { parseUserId } from '../../contracts/src/index.ts'
import { startTeamDevQuota } from '../src/quota.ts'

const quotaConfig = { modelId: 'fixture', contextWindow: 20, maxTokens: 5,
  personalDailyTokens: 50, siteDailyTokens: 100, personalConcurrency: 1, siteConcurrency: 2,
  busyTimeoutMs: 1000, maxBodyBytes: 4096, maxImagesPerRequest: 1,
  maxInlineImageBytes: 1024, maxEventBytes: 4096, maxFileBodyBytes: 4096,
  credentialLifetimeMs: 60_000, credentialRotateMs: 1000 }

describe('development model service', () => {
  it('refuses a concurrent owner before changing live credentials', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'team-dev-ownership-'))
    const baseWebPatch = join(storageRoot, 'base.patch.yml')
    await writeFile(baseWebPatch, '[]\n')
    const options = { storageRoot, baseWebPatch, storageLock: { staleMs: 120_000, updateMs: 10_000 }, users: [parseUserId('alice')], config: quotaConfig }
    const quota = await startTeamDevQuota(options)
    const credentialPath = join(storageRoot, 'users', 'alice', 'home', 'quota-credential.json')
    const before = await readFile(credentialPath, 'utf8')
    let duplicate: typeof quota | undefined
    try {
      await expect(startTeamDevQuota(options).then(value => { duplicate = value; return value })).rejects.toThrow()
      expect(await readFile(credentialPath, 'utf8')).toBe(before)
    } finally {
      await duplicate?.close()
      await quota.close()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
  it('releases ownership after a failed partial startup', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'team-dev-failed-'))
    const baseWebPatch = join(storageRoot, 'base.patch.yml')
    const options = { storageRoot, baseWebPatch, storageLock: { staleMs: 120_000, updateMs: 10_000 },
      users: [parseUserId('alice')], config: quotaConfig }
    let quota: Awaited<ReturnType<typeof startTeamDevQuota>> | undefined
    try {
      await writeFile(baseWebPatch, '{}\n')
      await expect(startTeamDevQuota(options)).rejects.toThrow('list')
      await writeFile(baseWebPatch, '[]\n')
      quota = await startTeamDevQuota(options)
    } finally {
      await quota?.close()
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
  it('rotates private credentials and keeps daily charges across restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'team-dev-quota-'))
    const baseWebPatch = join(storageRoot, 'base.patch.yml')
    await writeFile(baseWebPatch, '[]\n')
    const options = { storageRoot, baseWebPatch, storageLock: { staleMs: 120_000, updateMs: 10_000 }, users: [parseUserId('alice')],
      config: quotaConfig }
    let quota: Awaited<ReturnType<typeof startTeamDevQuota>> | undefined
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const installed = join(storageRoot, 'installed', 'team-dev')
      await mkdir(installed, { recursive: true })
      const packageRoot = fileURLToPath(new URL('../', import.meta.url))
      await cp(join(packageRoot, 'lib'), join(installed, 'lib'), { recursive: true })
      await cp(join(packageRoot, 'package.json'), join(installed, 'package.json'))
      await symlink(join(packageRoot, 'node_modules'), join(installed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      const relocated: typeof import('../src/quota.ts') = await import(pathToFileURL(join(installed, 'lib', 'quota.js')).href)
      quota = await relocated.startTeamDevQuota(options)
      const installedPatch: Array<{ insert?: Array<{ name: string }> }> = JSON.parse(await readFile(quota.patches.get(parseUserId('alice'))!, 'utf8'))
      for (const plugin of installedPatch.at(-1)!.insert!) expect(await readFile(new URL(plugin.name), 'utf8')).not.toBe('')
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
      let duplicate: typeof quota | undefined
      try { await expect(startTeamDevQuota(options).then(value => { duplicate = value; return value })).rejects.toThrow() }
      finally { await duplicate?.close() }
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
