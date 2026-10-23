/**
 * Catalogue visibility: who sees a package in the personalized index vs who
 * may still fetch its mirrored artifacts (delist vs scope-change rules).
 */

export interface ScopeRow {
  readonly kind: string
  readonly target: string
}

/**
 * Whether any scope row grants visibility to a user with the given groups
 * (company = everyone; group = membership including ancestors supplied by caller).
 */
export function scopesVisibleToUser(
  scopes: readonly ScopeRow[],
  groups: ReadonlySet<string>,
): boolean {
  return scopes.some(
    (scope) => scope.kind === 'company' || (scope.kind === 'group' && groups.has(scope.target)),
  )
}

/**
 * Index listing rule: not delisted and in scope.
 * Delisted packages are omitted from `index.json` and defaults.
 */
export function packageVisibleInIndex(opts: {
  readonly scopes: readonly ScopeRow[]
  readonly groups: ReadonlySet<string>
  readonly delistedAt: number | null
}): boolean {
  if (opts.delistedAt != null) return false
  return scopesVisibleToUser(opts.scopes, opts.groups)
}

/**
 * Mirror / packument serving rule: scope only.
 * Delist keeps serving artifacts to the original scope so profiles stay reinstallable;
 * a scope change that drops the user stops serving (reinstall → not-found).
 */
export function packageArtifactsVisible(opts: {
  readonly scopes: readonly ScopeRow[]
  readonly groups: ReadonlySet<string>
}): boolean {
  return scopesVisibleToUser(opts.scopes, opts.groups)
}
