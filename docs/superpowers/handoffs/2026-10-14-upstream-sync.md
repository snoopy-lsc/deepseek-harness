# Upstream sync

English | [中文](2026-10-14-upstream-sync.zh.md)

## Summary

This fork tracks `deepseek-ai/deepseek-harness` through the `upstream` remote. Almost all fork changes live in new files under `integrations/public-harness/` and `docs/superpowers/`. Only the `packages/experimental/browser-use-stagehand-native/` package changes upstream files. This guide lists the known environment test failures and the process for merging upstream releases into `master`.

## Table of Contents

- [Known environment failures](#known-environment-failures)
- [Sync process](#sync-process)
- [Lessons](#lessons)
- [Dev Note](#dev-note)

-----

<a id="known-environment-failures"></a>
## Known environment failures

On 2026-10-14 the following tests failed on the agent box both on upstream release `v0.2.1-alpha.2` and on the fork. The fork does not touch these files. Treat them as environment failures, not regressions.

- `packages/util/http-proxy/tests/install.spec.ts`: one bypass test times out. The box sends traffic through a sandbox egress proxy, so direct loopback probes behave differently.
- `packages/util/http-proxy/tests/matcher-parity.spec.ts`: six bypass matcher parity cases fail for the same proxy reason.
- `scripts/gen-dependency-catalog.spec.ts`: the npm configuration isolation case fails because the box injects npm configuration that the test does not expect.
- `pnpm run test:docs`, gate "repository references": one finding, a commit hash at `python/sdk/uv.lock` line 113. The lock file pins a dependency by commit, and the fork does not edit it.

### Flaky under load; rerun alone to confirm

These tests failed once during a full root unit run on the box and passed when rerun on their own. If one fails, rerun only that file; count it as a regression only if it still fails.

- `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts`: the hostile-peer case about a child that dies mid-drain asserts on timing.
- `packages/llm/llm-deepseek/tests/runtime.spec.ts`: the mid-stream abort case asserts on how many stream events arrived before the abort.
- `scripts/persistence-schema.spec.ts`: compilation can pick up a temporary `oxlint-contract-*.ts` file under `packages/core/session/src/` that a concurrent test creates and removes, and then fails with TS6053.

`apps/desktop/tests/welcome-flow.e2e.ts` failed once because `node_modules/.pnpm/node_modules` kept a stale link to the old `packages/hooks/hook-protocol` path. Delete that directory and run `pnpm install --force` to fix the link; the test then passes.

<a id="sync-process"></a>
## Sync process

1. Each week, or when upstream publishes a release, run `git fetch upstream`.
2. Create `sync/upstream-YYYY-MM-DD` from `master` and run `git merge --no-ff upstream/master`. Resolve conflicts only on this branch. Expect conflicts first in the stagehand package files.
3. Run `pnpm install`, `pnpm run typecheck`, the `integrations/public-harness` unit tests, its Chrome e2e tests with `PUBLIC_HARNESS_E2E_BROWSER` set, and the full root unit and e2e suites. Compare failures with the known environment failures above.
4. Push only the sync branch and review it. Merge it into `master` with a normal merge. Never force-push or rewrite `master`.
5. Optionally send the stagehand changes upstream as a pull request so the fork no longer carries them.

<a id="lessons"></a>
## Lessons

- Run `pnpm run build` before any e2e suite, at the root and in `integrations/public-harness`. The e2e tests load built `lib/` and `dist/` output, so a merge without a fresh build tests stale code and reports failures that are not real.
- Pushing a sync branch whose merge includes upstream edits under `.github/workflows/` needs a GitHub credential with the `workflow` scope; without it GitHub rejects the push. Check the scope of the `gh` login before the push, and report a rejection instead of dropping the workflow changes.

<a id="dev-note"></a>
## Dev Note

Update the known failure list whenever the environment changes, and re-check each entry against a clean upstream worktree.
