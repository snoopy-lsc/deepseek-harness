# 无容器 Harness 身份服务实施计划

[English](2026-10-11-public-harness-native-identity.md) | 中文

> **供代理执行：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 通过 Better Auth 提供公开注册和可撤销的浏览器身份认证。

**架构：** 独立 Cordis 服务管理 Better Auth、私有 SQLite 和账号页面。路由器每次请求及 WebSocket 握手都通过私有 Unix 套接字查询当前会话。已有 authentik 和本机开发身份仍可显式选择。

**技术栈：** TypeScript, Node ^22.19 || >=24, Cordis, Better Auth, SQLite, React, Vitest.

**规格：** [已确认的无容器部署设计](../specs/2026-10-11-public-harness-native-design.zh.md)。

**依赖顺序：** 可独立于[运行环境](2026-10-11-public-harness-native-runtime.zh.md)开发；[部署计划](2026-10-11-public-harness-native-deployment.zh.md)依赖两者。

## 全局约束

- 下列文件路径相对于 `integrations/public-harness/`；`docs/` 路径相对于仓库根目录。改动保留在独立插件和配置档中；Harness 会话格式与 `InstanceManager` 保持不变。

- 使用严格 TypeScript、带品牌类型的不透明 ID、ESM、导出文档、经过校验且可配置的部署参数，并由 `ctx.effect()` 管理生命周期。所有 Node 服务都通过 `dsh` 配置档启动。

- 本计划中的命令和断言描述待执行的检查及预期结果，不代表已经完成的部署证据。定向命令从仓库根目录执行；测试已构建模块的导入前先构建集成项目。

- 公开使用要求邮箱验证、CAPTCHA、持久化限速及平台模型额度。密钥保留在用户账号之外。本机开发仅监听回环地址，不作为隔离环境。

## 审查重点

- 伪造来源/代理头或重复 cookie：在认证前拒绝（任务 1）。
- 验证/重置重放及注册次数超限：不产生重复账号，不允许无限重试（任务 1）。
- 退出/撤销/暂停：后续请求立即拒绝；已有连接在配置期限内关闭（任务 2）。
- 身份数据库/套接字故障：返回不可用，不授予任何用户身份（任务 2）。
- 用户控制的返回地址或浏览器文本：拒绝站外跳转，展示经过转义的本地化内容（任务 3）。

---

### 任务 1：Better Auth 服务与验证注册

**文件：** 创建 `packages/identity/{package.json,tsconfig.build.json,build.ts,README.md,README.zh.md}`、`src/{index,config,auth,database,server}.ts`、`tests/registration.spec.ts`；修改集成锁文件、支持 TSX/DOM 的根 `tsconfig.json` 及集成构建配置。

**接口：** 提供 `parseIdentityConfig(value: unknown): IdentityConfig`、`startIdentity(config: IdentityConfig): Promise<{ close(): Promise<void> }>` 及 Cordis 的 `apply(ctx: Context, config: { configFile: string }): Promise<void>`。配置指定公开 HTTPS 来源、私有套接字/数据库、密钥文件、邮件传输、CAPTCHA 提供方/密钥、持久化限速策略、会话/令牌有效期及可信代理策略。核对当前官方 API 文档后固定维护中的 Better Auth/SQLite 适配器版本。

- [ ] **1. 编写失败测试：** `unverified_user_cannot_enter_harness` 断言邮箱验证前没有会话身份；`verification_and_reset_are_single_use` 拒绝令牌重放。`registration_limit_survives_restart` 在两次服务启动间保留计数；`forged_origin_or_proxy_denied` 和重复会话 cookie 拒绝请求且不创建用户。CAPTCHA 或邮件故障使注册不可用，绝不自动视为验证成功。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- registration.spec.ts`；预期身份服务缺失或准入断言失败。

- [ ] **3. 实现** 已声明服务，采用 Better Auth Node 处理器和受控结构迁移，保护数据库权限，提供邮箱/密码注册、验证、重置、登录/退出及会话撤销。校验 HTTP 输入，要求安全主机 cookie 和精确来源，使用持久化的原子限速计数。确定性的邮件/CAPTCHA 替身仅可用于显式测试/本机配置；生产拒绝使用它们。仅注册网站账号不分配 Linux 账号、实例或模型授权。

- [ ] **4. 验证** 定向测试、构建及 `typecheck`；预期通过。在 README/JSDoc 记录数据库迁移、密钥/邮件要求和不可用状态；提交 `feat: add verified Better Auth registration service`。

### 任务 2：实时会话校验与撤销

**文件：** 创建 identity 的 `src/session-wire.ts`、router 的 `src/native-identity.ts`、identity 的 `tests/session-wire.spec.ts`、router 的 `tests/native-identity.spec.ts`；修改 router 的 `src/{config,server,proxy}.ts`、production 的 `src/team-router.ts`、对应入口测试及 README 双语文件。

**接口：** 提供 `createNativeIdentity(options: { socketPath: string; timeoutMs: number; maxResponseBytes: number }): IdentityVerifier`，保留 `verify(headers: IncomingHttpHeaders): Promise<UserId>`。内部 `POST /internal/session` 不可通过 Caddy 访问，只接收有大小限制的 cookie 字段，返回 `{ userId: UserId; sessionId: SessionId; expiresAt: number }`；`SessionId` 在 identity 使用品牌类型并解析。在 router 配置中定义 `IdentityUnavailableError`，表示查询超时、数据库/套接字不可用或无效响应；服务将其映射为 503，无效凭据仍返回 401。活跃用户校验复用开通状态。新增服务配置 `sessionRecheckMs`，重新校验拒绝或不可用时关闭活跃 HTTP/WS 流。

- [ ] **1. 编写失败测试：** `logout_denies_next_request` 和 `suspension_denies_next_handshake` 断言撤销后不会连接后端；`open_stream_is_closed_on_recheck` 断言在配置间隔内关闭连接。`identity_outage_never_reuses_positive_result` 在先前成功查询后发生故障时返回 503 且不启动路由；伪造浏览器身份头及开发 cookie 不产生生产身份。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- session-wire.spec.ts native-identity.spec.ts ingress.spec.ts`；预期新校验用例失败。

- [ ] **3. 实现** 私有会话查询，使用 Better Auth 的 `getSession` 并禁用 cookie 缓存；数据库不可变 ID 经 `parseUserId` 映射。每次请求/升级都认证；限制并校验套接字响应。解析显式身份标签 `better-auth`、`authentik` 或开发模式；拒绝跨模式配置。用可清理的重检定时器跟踪流，保留转发 cookie/头过滤和账号容量检查。

- [ ] **4. 验证** 定向测试及已有 authentik/开发身份测试；预期通过。在后端升级指南中补充身份选择，更新 README 双语文件；提交 `feat: verify native browser sessions at the router`。

### 任务 3：统一账号页面与浏览器流程

**文件：** 创建 identity 的 `src/client/{index.tsx,locale.ts,account.tsx,styles.css}`、`tests/account.spec.ts`、`tests/registration.e2e.ts`；修改 identity 构建/服务，UI 的 `src/client/index.tsx` 仅复用账号链接/品牌贡献，并在 `tests/deploy-config.spec.ts` 检查构建资源。

**接口：** 身份服务提供 `/account/` 和 `/api/auth/*`；验证并登录成功后跳转至当前用户的路由路径。提供 `safeReturnPath(value: string, userId: UserId): string`，只允许该用户路由或 `/account/`。账号页面使用类型化中英文词典及统一产品品牌；Harness 行为仅通过已有 UI 插件增加。

- [ ] **1. 编写失败测试：** `return_path_cannot_leave_owner_route` 拒绝站外、编码及其他用户跳转；`account_copy_is_localized` 检查两种语言及服务端错误转义。浏览器 `register_verify_login_logout` 通过测试邮箱完成注册，进入真实 Harness，再确认退出阻止 HTTP 和 WS 访问；覆盖重置/撤销及加载/错误状态。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- account.spec.ts deploy-config.spec.ts`；预期页面缺失或跳转断言失败。

- [ ] **3. 实现** 注册、验证、登录、重置及账号/会话控制，使用词典管理文案和已有视觉变量。将 React 页面构建为身份服务资源，不替换上游客户端代码。声明浏览器测试依赖/配置；真实浏览器测试使用唯一的本机来源、自有进程及显式测试 CAPTCHA/邮件设置。

- [ ] **4. 验证** 定向测试、`pnpm --dir integrations/public-harness test:e2e -- registration.e2e.ts`、构建/typecheck 及所属包所需用户输出样例；预期通过。遵循客户端 UI/可靠性技能，创建 GUI PR 时录制真实浏览器流程。提交 `feat: add unified public Harness account pages`。
