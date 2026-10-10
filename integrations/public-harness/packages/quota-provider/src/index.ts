/** Cordis DeepSeek provider that reads a rotated quota credential per call. */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

/** Plugin settings for the quota proxy route and private credential file. */
export interface Config {
  proxyBaseUrl: string
  credentialFile: string
  provider: string
  modelId: string
  modelName: string
  contextWindow: number
  maxTokens: number
}

/** Validated provider settings and explicit model capacity. */
export const Config: z<Config> = z.object({
  proxyBaseUrl: z.string().required(),
  credentialFile: z.string().required(),
  provider: z.string().default('platform'),
  modelId: z.string().required(),
  modelName: z.string().required(),
  contextWindow: z.number().step(1).min(1).required(),
  maxTokens: z.number().step(1).min(1).required(),
})

/** Read the currently rotated credential, rejecting expired or public files. */
export async function readRotatingCredential(path: string, now = Date.now()): Promise<string> {
  if (!isAbsolute(path)) throw new Error('quota credential path must be absolute')
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096
    || (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)) {
    throw new Error('invalid private quota credential file')
  }
  let decoded: unknown
  try { decoded = JSON.parse(await readFile(path, 'utf8')) }
  catch { throw new Error('invalid quota credential file') }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('invalid quota credential')
  const record = decoded as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'expiresAt,token'
    || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(record.token)
    || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) {
    throw new Error('invalid quota credential')
  }
  if (record.expiresAt <= now) throw new Error('quota credential expired')
  return record.token
}

/** Stable Cordis plugin identity. */
export const name = 'public-harness-quota-provider'
/** The provider requires the public LLM registry. */
export const inject = ['llm']

/** Register one platform-funded model route through the public DeepSeek adapter. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.credentialFile)) throw new Error('quota credential file must be absolute')
  const options = () => resolveAdapterOptions({
    baseURL: config.proxyBaseUrl, models: [{ id: config.modelId, name: config.modelName,
      contextWindow: config.contextWindow, maxTokens: config.maxTokens }],
    defaultContextWindow: config.contextWindow, maxTokens: config.maxTokens,
  })
  options()
  registerDeepSeekProvider(ctx, config.provider, {
    options,
    providerName: 'Platform',
    resolveAuth: async () => ({ headers: { authorization: `Bearer ${await readRotatingCredential(config.credentialFile)}` } }),
    discoverModels: provider => Promise.resolve(options().models.map(model => catalogModelInfo(provider, model))),
  })
}
