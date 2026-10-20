/** Settings for the loopback enterprise composition. */
import type { IdentityConfig } from '@public-harness/identity'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Config as TeamConfig, validateTeamDevConfig, type TeamDevConfig } from './index.ts'

/** A password account initialized through the normal registration and verification APIs. */
export interface LocalAccount { readonly name: string; readonly email: string; readonly role: 'admin' | 'member' }
/** Local composition settings; data and process limits remain explicit in the team configuration. */
export interface EnterpriseConfig {
  readonly stateRoot: string
  readonly port: number
  readonly identity: Pick<IdentityConfig, 'limits' | 'sessionTtlSeconds' | 'verificationTtlSeconds'>
  readonly kb: { readonly siteWorkers: number; readonly perUserPerHour: number; readonly sweepIntervalMs: number }
  readonly team: TeamDevConfig
  readonly accounts: LocalAccount[]
}
/** Local account fields persisted with their generated password. */
export const AccountSchema = z.object({ name: z.string().required(), email: z.string().pattern(/^[^\s@]+@[^\s@]+$/).required(),
  role: z.union(['admin', 'member']).required(), password: z.string().min(16).required() })
/** Validated profile configuration. */
export const Settings: z<EnterpriseConfig> = z.object({
  stateRoot: z.string().required(), port: z.number().step(1).min(0).max(65535).required(), team: TeamConfig.required(),
  identity: z.object({ limits: z.object({ signupPerIpPerHour: z.number().min(1).required(), signupPerDay: z.number().min(1).required(),
    resetPerEmailPerHour: z.number().min(1).required(), loginPerIpPerMinute: z.number().min(1).required() }).required(),
    sessionTtlSeconds: z.number().min(1).required(), verificationTtlSeconds: z.number().min(1).required() }).required(),
  kb: z.object({ siteWorkers: z.number().step(1).min(1).required(), perUserPerHour: z.number().step(1).min(1).required(),
    sweepIntervalMs: z.number().step(1).min(0).required() }).required(),
  accounts: z.array(z.object({ name: z.string().required(), email: z.string().pattern(/^[^\s@]+@[^\s@]+$/).required(),
    role: z.union(['admin', 'member']).required() })).required(),
})
/** Validate disk settings before allocating any listeners or data.
 * @param raw Parsed profile JSON.
 * @returns Settings restricted to loopback development.
 */
export function parseEnterpriseConfig(raw: unknown): EnterpriseConfig {
  const parsed: EnterpriseConfig = z.resolve(raw, Settings, {})[0]
  const config = { ...parsed, accounts: parsed.accounts.map(account => ({ ...account, email: account.email.toLowerCase() })) }
  validateTeamDevConfig(config.team)
  if (!isAbsolute(config.stateRoot)) throw new Error('enterprise development stateRoot must be absolute')
  const emails = config.accounts.map(account => account.email.toLowerCase())
  if (new Set(emails).size !== emails.length || !config.accounts.some(account => account.role === 'admin')) {
    throw new Error('enterprise development requires distinct accounts and an administrator')
  }
  return config
}
