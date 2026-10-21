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

以下路径相对于 `integrations/public-harness/` 内的 `packages` 目录。

- `ui/src/theme/palette.ts`：`team-enterprise` 的浅色/深色 token 对。
- `ui/src/client/theme.ts`：插件自有的毛玻璃与桌面背景样式表，含降低透明度回退。
- `ui/src/client/index.tsx`：在插件生命周期内注册 token 层与样式表。
- `ui/src/client/nav.tsx`：个人入口和系统管理入口及其占位页面。
- `ui/src/client/me.ts`：读取 `/account/api/me`。
- `ui/src/theme/identity.ts`：由同一组 token 取值生成的身份页面样式表。
- `contracts/src/web-rows.ts`：共享的 Web 补丁行（默认模型、隐藏官方提供方）。
- 修改：`identity/src/{config,server,pages}.ts`、`team-dev/src/quota.ts`、`provisioner/src/runtime.ts` 及相关 README。

## 第 1 阶段：主题插件与统一外壳

### 任务 1.1：Token 层

- [ ] 测试：客户端包通过 `ctx.theme.overrideTokens` 注册 `team-enterprise` 覆盖，每个 token 都有 `{ light, dark }` 一对取值，卸载时释放。
- [ ] 依据 `d4-theme.css` 的 A 部分实现 `ui/src/theme/palette.ts`；只使用 `--dsw-*` 名称。
- [ ] 提交。

### 任务 1.2：毛玻璃样式表

- [ ] 测试：样式表以 `<style data-plugin>` 元素挂载，释放时移除，包含 `prefers-reduced-transparency` 块，且不匹配 `[A-Za-z0-9-]{4,}_[A-Za-z]` 哈希类名模式。
- [ ] 用稳定选择器实现 `ui/src/client/theme.ts`：`body` 桌面背景、用 `div:has(> [data-slot="sidebar"])` 选择侧栏列及其外框、`[data-composer-card]`、`[data-composer-seat]`、`[role="dialog"][aria-modal="true"]`。
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

- [x] 个人面板用 Harness 设置行展示账户信息、登录方式和角色；会话列表与「退出其他会话」调用身份服务 API。
- [x] `/account/api/me` 下的接口：`GET /security`（登录方式、能否修改密码、SSO 绑定）、`GET /sessions`（不含令牌）、`POST /sessions/revoke`（退出某个其他会话）、`POST /sessions/revoke-others`、`POST /password`（以当前密码作为重新认证；仅限密码账户与紧急账户；修改后其他会话退出）。每个请求都需要有效会话；写操作需要配置的 Origin 和 JSON 请求体；修改密码与撤销会话都写入审计。

### 任务 2.2：用量与额度

- [x] 通过按用户的接口从额度账本读取只读用量；展示每日额度与当日用量。
- [ ] 生产环境中身份服务到额度账本的桥接（目前由部署向 `startIdentity` 传入用量来源；team-dev 栈已这样做）。

### 任务 2.3：偏好设置

- [x] 链接到 Harness 现有的外观与语言设置；不重复保存设置状态（页面调用 Harness 自己的 `settings.open` 命令）。

## 第 3 阶段：系统管理

### 任务 3.1：管理 API

- [x] 身份服务中的 `/api/admin/*`：邀请码；用户（搜索、角色及来源、状态、登录方式、最近登录）；通过自动停用路径停用（同一事务内撤销会话）；启用；记录在 `dsh_role_grant` 的角色授予；带筛选和游标的审计日志；脱敏的 SSO 视图及最近一次目录同步；额度。每个接口在读取请求体前先在服务端校验角色；写操作需要 Origin 和 JSON，有频率限制并写审计。
- [x] 停用和降级都遵守最后一位管理员规则；配置的管理员和紧急管理员不能在控制台降级；不能停用自己。
- [x] 重新认证（在此决定）：停用、角色变更、额度变更。密码管理员重新输入密码；SSO 管理员的会话须在 10 分钟内建立，否则返回 401 `reauth-required` 和 `method: 'sso'`，并重新 SSO 登录。启用和邀请码操作只记审计。
- [x] `admin.spec.ts` 证明成员在 `ADMIN_ENDPOINTS` 的每个接口上都得到 403，未登录得到 401。

### 任务 3.2：生产用量来源

- [x] 额度服务打开私有账户 socket（`accountSocket`、`accountSocketGid`；`usage`、`limits`、`set-default`、`set-user`），账本保存按用户和默认的每日额度，上限为站点额度。
- [x] 身份服务读取 `DSH_QUOTA_ACCOUNT_SOCKET`；未传入替换时，`startIdentity` 用它提供个人用量和额度编辑。原生部署单元只允许 `dsh-identity` 访问（`/run/dsh-public/quota-account`），Caddy 转发 `/api/admin/*`。

### 任务 3.3：系统管理界面

- [x] 系统管理打开时，其子菜单在同一侧栏中替换会话浏览区（以更低优先级注册 `sidebar.workspaces`），并带返回行；成员看不到入口。
- [x] 用户、邀请码、审计日志、单点登录和额度分区，用 Harness 基础组件和设置行几何构建，停用有确认对话框，并有重新认证对话框。
- [x] 审计日志 CSV 导出与超额行为开关：已在第 4 阶段完成。

### 任务 3.4：检查与截图

- [x] 真实服务的浅色与深色截图：子菜单、每个分区、需 SSO 重新认证的停用、最后一位管理员被拒、返回会话、经账户 socket 的个人用量，以及没有入口的成员（成员调用 API 得到 403）。

## 第 4 阶段：导出、超额策略与返回路径

### 任务 4.1：审计日志 CSV 导出

- [x] `GET /api/admin/audit.csv` 使用查看器的筛选条件（`event`、`outcome`、`q`），按最新在前每页 500 条流式输出，最多 50,000 条（`x-audit-export-rows`、`x-audit-export-truncated`）。每个字段都加引号并把内部引号写成两个；以 `=`、`+`、`-`、`@`、制表符或 CR 开头的字段前加 `'`；文件以 UTF-8 BOM 开头，Excel 能正确显示中文。仅限管理员，每位管理员每小时 10 次，每次导出在输出前写一条 `admin-audit-export` 审计记录（行数与筛选条件）。

### 任务 4.2：超额策略

- [x] 选定的选项：`block`（默认：达到个人每日额度后拒绝新的请求）、`grace`（在额度之外再允许其 `gracePercent`（1–100）的用量并提醒，然后拒绝）和 `warn`（个人额度仅作提醒，只有站点每日额度会拒绝）。由额度账本在预留时执行，因此额度代理对每次模型调用都适用；用量返回 `overLimit`、`state`（`ok`、`grace`、`over`、`blocked`）和 `hardLimitTokens`。
- [x] 账户 socket 新增 `set-over-limit`；`POST /api/admin/quota/over-limit` 需要重新认证并写入审计（`admin-over-limit-change`）。额度分区提供该开关。
- [x] 用户仍通过 `shell.quota-notice` 看到拒绝提示；超出额度后，Harness 显示 Toast 提醒（`shell.overlay`，每分钟及窗口获得焦点时读取用量，每种状态每天一次），个人中心在用量条上方显示同一句话。

### 任务 4.3：返回路径

- [x] SSO（跳转式与 LDAP）和密码登录直接回到请求的页面：账户页，或用户自己 `/u/<id>/` 路由下的任意页面（保留查询与片段）。绝对和协议相对 URL、反斜杠、空白和控制字符、点段、编码的斜杠、反斜杠或点、双重编码以及其他用户的路由，都回退到用户自己的路由。服务端与页面脚本共用同一个函数。从系统管理发起的重新登录会回到原页面。

### 任务 4.4：清理、检查与截图

- [x] 通过管理 API 清理评估遗留（有审计）：zhangwei 的个人额度和第 3 阶段的测试邀请码。
- [x] 真实服务的浅色与深色截图：导出按钮与 CSV 预览、超额设置、Harness 与个人中心中的用户提醒、SSO 重新登录回到原页面，以及清理后的额度与邀请码。
