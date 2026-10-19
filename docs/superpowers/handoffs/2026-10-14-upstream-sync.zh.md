# 上游同步

[English](2026-10-14-upstream-sync.md) | 中文

## Summary

本分支通过 `upstream` 远端跟踪 `deepseek-ai/deepseek-harness`。分支改动几乎都是 `integrations/public-harness/` 和 `docs/superpowers/` 下的新文件，只有 `packages/experimental/browser-use-stagehand-native/` 包修改了上游文件。本文列出已知的环境性测试失败，以及把上游版本合并进 `master` 的流程。

## Table of Contents

- [已知环境失败](#known-environment-failures)
- [同步流程](#sync-process)
- [经验](#lessons)
- [Dev Note](#dev-note)

-----

<a id="known-environment-failures"></a>
## 已知环境失败

2026-10-14 在代理机器上，以下测试在上游版本 `v0.2.1-alpha.2` 和本分支上都失败。本分支没有修改这些文件，应视为环境问题而非回归。

- `packages/util/http-proxy/tests/install.spec.ts`：一个绕过代理的测试超时。机器通过沙箱出口代理转发流量，直连回环探测的行为不同。
- `packages/util/http-proxy/tests/matcher-parity.spec.ts`：六个绕过规则一致性用例因同样的代理原因失败。
- `scripts/gen-dependency-catalog.spec.ts`：npm 配置隔离用例失败，因为机器注入了测试未预期的 npm 配置。

`apps/desktop/tests/welcome-flow.e2e.ts` 曾因 `node_modules/.pnpm/node_modules` 保留指向旧路径 `packages/hooks/hook-protocol` 的失效链接而失败。删除该目录并运行 `pnpm install --force` 即可修复，之后测试通过。

<a id="sync-process"></a>
## 同步流程

1. 每周或上游发布新版本时运行 `git fetch upstream`。
2. 从 `master` 创建 `sync/upstream-YYYY-MM-DD`，运行 `git merge --no-ff upstream/master`。只在该分支上解决冲突，冲突最可能先出现在 stagehand 包文件中。
3. 运行 `pnpm install`、`pnpm run typecheck`、`integrations/public-harness` 单元测试、设置 `PUBLIC_HARNESS_E2E_BROWSER` 后的 Chrome e2e 测试，以及根目录完整单元和 e2e 套件，并与上面的已知环境失败对照。
4. 只推送同步分支并评审，然后用普通合并并入 `master`。不要 force-push，也不要改写 `master` 历史。
5. 可选：把 stagehand 改动以 pull request 提交给上游，使本分支不再维护这些改动。

<a id="lessons"></a>
## 经验

- 运行任何 e2e 套件之前，先在根目录和 `integrations/public-harness` 中运行 `pnpm run build`。e2e 测试加载构建产物 `lib/` 和 `dist/`，合并后不重新构建就会测试旧代码，报出并不存在的失败。
- 如果同步分支的合并包含上游对 `.github/workflows/` 的修改，推送需要带 `workflow` 权限范围的 GitHub 凭据，否则 GitHub 会拒绝推送。推送前检查 `gh` 登录的权限范围；被拒绝时如实报告，不要丢弃工作流改动。

<a id="dev-note"></a>
## Dev Note

环境变化时更新已知失败列表，并在干净的上游工作树上重新核对每一项。
