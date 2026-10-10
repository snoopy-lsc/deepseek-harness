# 公开 Harness 界面与发布实施计划

[English](2026-10-10-public-harness-ui-release.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在 macOS/Windows 开发服务器与 Linux 正式环境提供统一品牌的浏览器体验，并且只在真实 Linux 检查通过后开放公开注册。

**架构：** 可安装的浏览器 Cordis bundle 填充每位用户 Web profile 中公开的品牌与导航 slot。`team-dev` profile 在 macOS 和 Windows 上组合 loopback 路由、本地身份、本地运行环境和额度服务；正式环境使用同品牌的 authentik。部署 manifest 固定 bundle 版本；有记录的 Linux 演练通过前，公开注册保持关闭。

**技术栈：** TypeScript、React、Cordis 客户端 slot、CSS token、authentik、Caddy、Playwright、Git、systemd。

**规格：** [公开多用户 Harness 设计](../specs/2026-10-10-public-team-harness-design.zh.md)。

**前置工作：** [运行环境](2026-10-10-public-harness-runtime.zh.md)、[额度](2026-10-10-public-harness-quota.zh.md)和[路由](2026-10-10-public-harness-router.zh.md)计划提供共享的本地开发路径；最终发布检查还要求全部 Linux 任务通过。

## 全局约束

- 界面代码放在 `integrations/public-harness/packages/ui/`，通过每位用户的 Web profile 安装；升级上游 Harness 不需要源码补丁。
- macOS/Windows 的 `team-dev` profile 只监听 loopback，使用固定测试身份、mock 模型或开发密钥，不提供公开注册。
- 产品文案由有类型的中英文 locale 字典管理。复用已有 UI 组件、slot 和样式 token；检查明暗主题。
- 正式登录与注册页由 authentik 管理；开发环境使用本地测试用户选择页。插件负责 Harness 品牌和公共导航；隐藏特定官方控件留给后续界面改动。
- 每位用户实例安装同一组经过测试的 bundle 版本。升级时保留 Session 数据和 Git 工作区。
- 真实 Linux 的完整工具执行、隔离、额度、账号生命周期、TLS、邮件与验证码、备份和容量检查全部通过前，公开自助注册保持关闭。
- 任务文件列表中的路径若未写出 `integrations/public-harness/` 前缀，均相对于该目录。

## 重点审查

- 用户实例仍在启动时，应显示明确的单一等待状态，不能出现损坏的应用界面；任务 1 固定此行为。
- 额度或容量拒绝需要简明的本地化文案，不能泄漏内部 ID；任务 1 固定此行为。
- 浏览器刷新和 WebSocket 重连必须保留正确的用户路径与品牌；任务 2 固定此行为。
- Harness 升级遇到不兼容的插件接口时，必须在修改用户实例前停止；任务 3 固定预检查。
- 注册、邮箱验证或备份恢复失败时，公开注册必须保持关闭；任务 4 固定发布条件。
- 开发 profile 必须在没有 Caddy、authentik、Linux 账号或 gVisor 的 macOS 和 Windows 上可用；任务 2 固定这条路径。

---

### 任务 1：统一品牌与状态界面

**文件：** 创建 `integrations/public-harness/packages/ui/src/index.ts`、`src/client/index.tsx`、`src/client/locales.ts`、`src/client/styles.css`、`tests/brand.client.spec.tsx`，以及该包的 manifest 和 README 双语文件。

**接口：** Cordis 客户端插件通过公开的 `dsh.client` slot 注册品牌图标、名称和导航。`renderStatusPage(status, locale): string` 为路由提供统一品牌的 `starting`、`capacity-full` 和 `service-unavailable` 页面；应用内额度错误映射成本地化的 `quota-exhausted` 文案。两个界面都不包含内部 ID 或凭据。

- [ ] **步骤 1：编写失败的客户端测试**，覆盖品牌 slot、本地化状态、键盘访问、加载状态和明暗主题下的文字可读性。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- brand.client.spec.tsx`；确认失败。
- [ ] **步骤 3：实现** slot 内容、通用状态组件、locale 字典和 CSS，复用已有 UI 组件与 token。
- [ ] **步骤 4：运行** 聚焦测试；确认通过。对可见界面 PR 从真实服务器和模型流程录制浏览器 GIF，然后提交界面和 README 双语文件。

### 任务 2：开发与正式 Profile 组合

**文件：** 创建 `deploy/profiles/web/cordis.patch.yml`、`deploy/profiles/team-dev/cordis.patch.yml`、`deploy/authentik/brand.yml`、`tests/profile.e2e.ts` 和 `tests/team-dev.e2e.ts`；更新部署 README 双语文件。

**接口：** Web profile 为每位用户安装相同的已固定版本的界面、额度 provider 和令牌发布 bundle。`team-dev` 在 loopback 启动本地路由、签名测试身份、本地运行环境和额度服务，不提供公开注册。正式 authentik 注册要求邮箱验证和验证码，之后账号才能进入路由。

- [ ] **步骤 1：编写失败的 e2e 测试**，覆盖 macOS/Windows 本地启动、两个测试身份、首次登录、刷新、干净的 URL、实例等待、WebSocket 重连、账号切换、非 loopback 拒绝，以及正式登录页和应用品牌一致性。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test:e2e -- team-dev.e2e.ts`；确认失败。
- [ ] **步骤 3：实现** 本地 profile 和测试用户选择器、共享 bundle 安装、正式环境的 authentik 品牌与注册配置，以及浏览器导航。
- [ ] **步骤 4：在 macOS 和 Windows 上使用两个真实 Harness Web 进程运行** `team-dev.e2e.ts`，再在 Linux 上用真实 authentik/Caddy 运行 `profile.e2e.ts`；记录结果后提交。

### 任务 3：版本化升级与回滚

**文件：** 创建 `deploy/release-manifest.json`、`deploy/upgrade.ts`、`tests/upgrade.spec.ts`，以及升级运行手册双语文件。

**接口：** `preflightUpgrade(manifest): Promise<CompatibilityReport>` 在非生产 profile 中启动候选 Harness 和全部固定版本的 bundle，检查登录、模型调用、终端、Session 和插件加载，然后才允许分批升级用户实例。回滚恢复此前的代码版本，不移动或删除已发布的 Session 格式代际。

- [ ] **步骤 1：编写失败测试**，覆盖不兼容的插件 API、Session 迁移失败、中断的升级、保留 `DSH_HOME` 和恢复旧 bundle 版本。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- upgrade.spec.ts`；确认失败。
- [ ] **步骤 3：实现** manifest 验证、候选实例预检查、分批更新、遇错停止行为，以及仅回滚代码的操作说明。
- [ ] **步骤 4：运行** 聚焦测试和真实 Linux 候选升级；记录版本与结果后提交。

### 任务 4：公开注册发布检查

**文件：** 创建 `deploy/release-check.ts`、`tests/release-check.spec.ts`，以及运营发布清单双语文件。

**接口：** `checkPublicEnrollment(evidence): Promise<ReleaseDecision>` 只有机器检查的配置和已记录的真实 Linux 测试覆盖 Caddy TLS 与请求头删除、authentik 安全版本与邮件/验证码、双用户执行隔离、额度故障拒绝、重启与备份恢复和容量时才返回 `allow`。注册开关默认为关闭。

- [ ] **步骤 1：编写失败测试**，覆盖每项前置条件缺失和完整有效的证据；拒绝过期或属于其他主机的证据记录。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- release-check.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 发布检查和运营证据格式；不把秘密信息或用户数据写入证据。
- [ ] **步骤 4：运行** 聚焦测试和完整 Linux 演练。发布决定为 `allow` 后才能开放公开注册，再提交不含秘密信息的部署记录。
