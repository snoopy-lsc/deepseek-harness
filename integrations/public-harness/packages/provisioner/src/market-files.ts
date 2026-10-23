/** Pure builders for per-instance market patch and npmrc (written under instance-market/). */
import { pluginMarketRows, type PluginMarketRowsOptions } from '@public-harness/contracts'

const CORP_SCOPE = '@corp-dsh'

/** Inputs for the instance npmrc (bearer stays out of URLs and patch rows). */
export interface InstanceMarketNpmrcOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly marketOnly?: boolean
}

/** Render `instance-market/<account>.npmrc`: company scope registry + auth token; optional default registry under market_only. */
export function renderInstanceMarketNpmrc(options: InstanceMarketNpmrcOptions): string {
  if (typeof options.host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(options.host)) {
    throw new Error('instance-market npmrc host must be an IPv4 address')
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('instance-market npmrc port must be a TCP port')
  }
  if (typeof options.token !== 'string' || options.token.length === 0 || /[\r\n]/.test(options.token)) {
    throw new Error('instance-market npmrc token is required')
  }
  const registry = `http://${options.host}:${options.port}/npm/`
  const hostPort = `${options.host}:${options.port}`
  const lines = [
    `${CORP_SCOPE}:registry=${registry}`,
    `//${hostPort}/npm/:_authToken=${options.token}`,
  ]
  if (options.marketOnly === true) lines.unshift(`registry=${registry}`)
  return `${lines.join('\n')}\n`
}

/** Render `instance-market/<account>.yml` as a Cordis patch document (JSON text, `.yml` suffix matches other deploy patches). */
export function renderInstanceMarketYml(options: PluginMarketRowsOptions): string {
  return `${JSON.stringify(pluginMarketRows(options))}\n`
}
