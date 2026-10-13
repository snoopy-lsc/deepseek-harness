# 统一企业界面实施计划

[English](2026-10-13-unified-ui.md) | 中文

> **面向智能体执行者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 让每个团队部署拥有统一的企业外观和统一入口：已批准的 D4 主题（只改颜色并加入 macOS 式毛玻璃，Harness 原有组件不变）；登录后直接进入本人的对话；所有人都有个人入口，管理员另有「系统管理」入口；最终提供真实的个人页和管理页。

**架构：** 全部改动位于 `integrations/public-harness/` 下的集成包，不修改 Harness 源码。`@public-harness/ui` 新增 `team-enterprise` 主题层：颜色覆盖通过 `ctx.theme.overrideTokens` 注册，毛玻璃规则放在一个插件自有的全局样式表中，只选择稳定的 slot 与 data 属性（`[data-slot]`、`[data-composer-card]`、`[data-composer-seat]`、`[role=dialog]`）。导航入口是 `sidebar.panellist` 注册项及对应的 `main` 面板。身份服务以 `GET /account/api/me` 返回登录用户的资料和服务端角色；浏览器插件读取它，而管理操作的唯一权威仍在服务端。身份页面通过带 nonce 的样式表共享同一组 token 取值。

**技术栈：** TypeScript、基于 Cordis 的 React 18 客户端插件、esbuild 客户端打包、运行在 `node:sqlite` 上的 Better Auth、Vitest、使用系统 Chrome 的 playwright-core。

**设计参考：** `/workspace/deepseek-harness-eval/design-2026-10-13/variant-D4/`（已批准的 D4 稿、`d4-theme.css`、`d4-identity.css`、`contrast.md`）。

## 全局约束

- 不修改 `integrations/public-harness/` 与 `docs/` 之外的文件；Harness 组件、图标、圆角、尺寸和布局保持原样。
- 选择器不得依赖构建生成的类名；使用 slot、data 属性、role 或新增 token。
- 不绕过 CSP：Harness 样式与 ui-theme 一样是插件自有的 `<style>` 元素；身份页面使用现有的逐响应 nonce，只加载本地资源。
- 每个半透明表面按最坏背景合成后，文字对比度满足 WCAG 2.1 AA（4.5:1）；`prefers-reduced-transparency: reduce` 时全部毛玻璃改为实色。
- 角色只来自服务端；浏览器只负责隐藏入口，从不授予权限。管理 API 每次请求都重新校验角色。
- 密钥只通过环境变量提供；模型密钥绝不打印、记录或写入。服务只绑定 127.0.0.1 或 Unix 套接字。
- 构建与测试串行执行，并设置 `NODE_OPTIONS=--max-old-space-size=3072`。

## 审查重点

- Harness 重新构建后主题不会失效：任务 1.2 断言样式表中没有哈希类名。
- 成员无法通过伪造客户端获取管理数据：任务 1.4 固定服务端角色，第 2 阶段固定每个管理 API。
- 登录后不会跳转到他人或开放重定向目标：任务 1.5 保留 `safeReturnPath`。
- 平台用户看不到无法使用的提供方：任务 1.6 固定默认模型并隐藏官方提供方。

## 文件结构

- `packages/ui/src/client/theme/tokens.ts`：`team-enterprise` 的浅色/深色 token 对。
- `packages/ui/src/client/theme/glass.css`：插件自有的毛玻璃与桌面背景样式表，含降低透明度回退。
- `packages/ui/src/client/theme/index.ts`：在插件生命周期内注册 token 层与样式表。
- `packages/ui/src/client/nav.tsx`：个人入口和系统管理入口及其占位页面。
- `packages/ui/src/client/me.ts`：读取 `/account/api/me`。
- `packages/ui/src/identity-theme.ts`：由同一组 token 取值生成的身份页面样式表。
- `packages/contracts/src/web-rows.ts`：共享的 Web 补丁行（默认模型、隐藏官方提供方）。
- 修改：`packages/identity/src/{config,server,pages}.ts`、`packages/team-dev/src/quota.ts`、`packages/provisioner/src/runtime.ts` 及相关 README。

## 第 1 阶段：主题插件与统一外壳

### 任务 1.1：Token 层

- [ ] 测试：客户端包通过 `ctx.theme.overrideTokens` 注册 `team-enterprise` 覆盖，每个 token 都有 `{ light, dark }` 一对取值，卸载时释放。
- [ ] 依据 `d4-theme.css` 的 A 部分实现 `tokens.ts`；只使用 `--dsw-*` 名称。
- [ ] 提交。

### 任务 1.2：毛玻璃样式表

- [ ] 测试：样式表以 `<style data-plugin>` 元素挂载，释放时移除，包含 `prefers-reduced-transparency` 块，且不匹配 `[A-Za-z0-9-]{4,}_[A-Za-z]` 哈希类名模式。
- [ ] 用稳定选择器实现 `glass.css`：`body` 桌面背景、用 `div:has(> [data-slot="sidebar"])` 选择侧栏列及其外框、`[data-composer-card]`、`[data-composer-seat]`、`[role="dialog"][aria-modal="true"]`。
- [ ] 提交。

### 任务 1.3：对比度检查

- [ ] 测试：单元测试把每个半透明 token 合成到最坏的桌面颜色上，断言文字 token ≥ 4.5:1、强调色 ≥ 3:1。
- [ ] 提交。

### 任务 1.4：服务端角色与个人资料接口

- [ ] 测试：`GET /account/api/me` 无会话时返回 401，有会话时返回 `{ id, email, name, role }`；紧急账户和 `DSH_ADMIN_EMAILS` 中的地址为 `admin`，其余为 `member`。
- [ ] 实现 `DSH_ADMIN_EMAILS` 解析（只来自环境变量，地址格式错误时拒绝启动）与该接口，并设置 `cache-control: no-store`。
- [ ] 提交。

### 任务 1.5：统一路由与导航

- [ ] 测试：密码与紧急登录后进入 `/u/<id>/`（或安全的 `return`）；客户端为所有人注册个人面板，只在角色为 `admin` 时注册系统管理面板。
- [ ] 使用 Harness 图标（`IconUserOutlineRegular`、`IconShieldOutlineRegular`）实现入口，以及链接到 `/account/` 的占位页面。
- [ ] 提交。

### 任务 1.6：身份页面与模型默认值

- [ ] 测试：身份页面在带 nonce 的 `<style>` 中携带共享 token，且不加载任何远程资源；Web 补丁把 `agent-default-model` 设为平台路由，并在未配置官方密钥时禁用 `llm-deepseek`。
- [ ] 实现并提交。

### 任务 1.7：门禁与截图

- [ ] 串行运行单元测试、类型检查、e2e、doc-quick、jsdoc 与 i18n 配对检查；在本分支重启本地服务栈；截取浅色和深色的登录页、管理员对话、成员对话与个人入口。

## 第 2 阶段：个人中心

### 任务 2.1：账户与会话

- [ ] 个人面板用 Harness 设置行展示账户信息、登录方式和角色；会话列表与「退出其他会话」调用身份服务 API。

### 任务 2.2：用量与额度

- [ ] 通过按用户的接口从额度账本读取只读用量；展示每日额度与当日用量。

### 任务 2.3：偏好设置

- [ ] 链接到 Harness 现有的外观与语言设置；不重复保存设置状态。

## 第 3 阶段：系统管理

### 任务 3.1：管理 API

- [ ] 身份服务提供用户、角色、邀请和停用接口，每个接口都在服务端重新校验 `admin` 并写入审计记录。

### 任务 3.2：用户页面

- [ ] 用 Harness 设置行构建用户列表、角色选择、邀请管理和停用。

### 任务 3.3：审计与额度页面

- [ ] 审计日志视图（筛选、CSV 导出）与额度设置（默认额度、按用户覆盖、超额行为），由额度服务支持。

### 任务 3.4：安全设置与端到端测试

- [ ] 登录与安全概览（SSO 提供方、紧急登录状态）；覆盖成员与管理员账户的 e2e，证明成员无法调用任何管理 API。
