/** Shared Harness Web patch rows for platform-funded team deployments. */

/** One Cordis patch row this module emits. */
export type WebPatchRow = { readonly id: string; readonly config: { readonly provider: string; readonly model: string } } | { readonly id: string; readonly disabled: true }
  | { readonly id: string; readonly config: { readonly customSkillDirs: readonly string[] } }

/** Patch entries emitted for the company plugin market (insert + optional manager override). */
export type PluginMarketPatchRow =
  | {
      readonly insert: readonly (
        | {
            readonly id: 'plugin-market'
            readonly name: '@deepseek-ai/dsh-plugin-market'
            readonly config: { readonly indexes: readonly string[] }
          }
        | { readonly id: 'ui-plugin-market'; readonly name: '@deepseek-ai/dsh-client-ui-plugin-market' }
        | {
            readonly id: 'public-harness-plugin-sync'
            readonly name: string
            readonly config: { readonly syncUrl: string }
          }
      )[]
    }
  | {
      readonly id: 'plugin-manager'
      readonly config: { readonly registry: string; readonly fallbackRegistries: readonly [] }
    }

/** Inputs for {@link pluginMarketRows}. */
export interface PluginMarketRowsOptions {
  /** Loopback or container hostAddress used in indexes / registry URLs. */
  readonly host: string
  readonly port: number
  /** Release asset path or `file://` URL for `public-harness-plugin-sync`. */
  readonly syncPlugin: string
  readonly syncUrl: string
  /** When true, pin the plugin manager to the market mirror with no fallbacks. */
  readonly marketOnly?: boolean
}

/** Rows that insert the market Discover services, point indexes at the user's port, and optionally pin registry.
 * @param options Host/port for the personalized index and sync plugin location.
 * @returns Patch rows safe to serialize into an instance `--patch` file.
 */
export function pluginMarketRows(options: PluginMarketRowsOptions): PluginMarketPatchRow[] {
  // IPv4 hostAddress / 127.0.0.1 only (no brackets, no path). IPv6 deferred.
  if (typeof options.host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(options.host)) {
    throw new Error('pluginMarketRows host must be an IPv4 address')
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('pluginMarketRows port must be a TCP port')
  }
  if (typeof options.syncPlugin !== 'string' || options.syncPlugin.length === 0) {
    throw new Error('pluginMarketRows syncPlugin is required')
  }
  if (typeof options.syncUrl !== 'string' || !/^https?:\/\//.test(options.syncUrl)) {
    throw new Error('pluginMarketRows syncUrl must be an http(s) URL')
  }
  const base = `http://${options.host}:${options.port}`
  const rows: PluginMarketPatchRow[] = [
    {
      insert: [
        {
          id: 'plugin-market',
          name: '@deepseek-ai/dsh-plugin-market',
          config: { indexes: [`${base}/index.json`] },
        },
        { id: 'ui-plugin-market', name: '@deepseek-ai/dsh-client-ui-plugin-market' },
        {
          id: 'public-harness-plugin-sync',
          name: options.syncPlugin,
          config: { syncUrl: options.syncUrl },
        },
      ],
    },
  ]
  if (options.marketOnly === true) {
    rows.push({
      id: 'plugin-manager',
      config: { registry: `${base}/npm/`, fallbackRegistries: [] },
    })
  }
  return rows
}

/** Rows that start fresh agents on the platform model and hide the official DeepSeek route when no key is provided for it.
 * @param options - Platform provider route and model id; `officialKey` keeps the official route when an operator supplies its key.
 * @returns Patch rows for the bundled `agent-default-model` and `llm-deepseek` entries.
 */
export function platformModelRows(options: { readonly provider: string; readonly model: string; readonly officialKey?: boolean }): WebPatchRow[] {
  const rows: WebPatchRow[] = [{ id: 'agent-default-model', config: { provider: options.provider, model: options.model } }]
  if (options.officialKey !== true) rows.push({ id: 'llm-deepseek', disabled: true })
  return rows
}

/** Rows that add the read-only knowledge base skills (`kb-query`, `kb-author`) shipped with the release to an instance.
 * @param skillsDir - The release's `packages/kb/skills` directory as the instance sees it (read-only).
 * @returns One patch row for the bundled `skill-filesystem` entry.
 */
export function kbSkillRows(skillsDir: string): WebPatchRow[] {
  return [{ id: 'skill-filesystem', config: { customSkillDirs: [skillsDir] } }]
}
