/** Shared Harness Web patch rows for platform-funded team deployments. */

/** One Cordis patch row this module emits. */
export type WebPatchRow = { readonly id: string; readonly config: { readonly provider: string; readonly model: string } } | { readonly id: string; readonly disabled: true }
  | { readonly id: string; readonly config: { readonly customSkillDirs: readonly string[] } }

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
