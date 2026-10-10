# 公开 Harness 路由实施计划

[English](2026-10-10-public-harness-router.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 通过一个浏览器入口，只把已认证的浏览器连接到该用户自己的 Harness Web 实例；正式环境使用 HTTPS。

**架构：** 正式环境由 Caddy 为每次请求和 WebSocket 握手处理 TLS 与 authentik 前置认证，再通过受保护的 Unix socket 转发。非 root 的 Cordis 路由验证签名身份，从 `InstanceManager` 取得该用户入口，并剥离 `/u/<id>/` 前缀。单独的本机 `team-dev` profile 使用签名测试用户 cookie 和 loopback TCP 入口，执行相同的属主检查、令牌兑换与 HTTP/WebSocket 转发。

**技术栈：** TypeScript、Node 22.19+ 或 24+、Cordis、Caddy、authentik、签名 JWT 验证、HTTP/WebSocket 转发、Vitest。

**规格：** [公开多用户 Harness 设计](../specs/2026-10-10-public-team-harness-design.zh.md)。

**前置工作：** 运行环境计划的任务 1–2 和[额度计划](2026-10-10-public-harness-quota.zh.md)支持本地开发；正式环境还需要运行环境计划的任务 3–5 和真实 Linux 服务。[运行环境计划](2026-10-10-public-harness-runtime.zh.md)。

## 全局约束

- 路由代码放在 `integrations/public-harness/packages/router/`，作为独立版本的 Cordis bundle，由 `dsh --profile team-router` 启动；它不以 root 运行。
- 显式的 `team-dev` profile 使用开发身份 provider 运行路由，且只绑定 loopback；它拒绝公开绑定地址，正式环境绝不启用无需 authentik 的开发身份。
- 只有 Caddy 服务账号可以打开路由 Unix socket。Caddy 删除客户端传入的身份请求头，并复制 authentik 前置认证结果中的身份值。
- 正式环境的路由为每次 HTTP 请求和升级验证一份签名身份，检查固定签发方、受众、密钥来源、到期时间，以及 `sub` 与 UID 是否一致。错误格式、重复、缺失或已撤权身份都拒绝访问。
- 路径格式为 `/u/<opaque-id>/...`；路由只剥离准确匹配属主的前缀，保留公开 Host 和 Origin，并且只转发到该用户的 `InstanceManager` 入口，无论它是 Unix socket 还是 loopback TCP。
- Harness cookie 是 host-only、`HttpOnly`、`SameSite=Strict`，在 HTTPS 下带 `Secure`，且 `Path=/u/<id>/`。每条已打开的 WebSocket 在 60 秒内结束，重连时必须重新认证。
- 任务文件列表中的路径若未写出 `integrations/public-harness/` 前缀，均相对于该目录。

## 重点审查

- 编码的斜杠、点路径或前缀冲突不能选中其他用户后端；任务 2 固定路径规范化行为。
- 重复身份请求头或属于其他受众的有效 JWT 不能通过认证；任务 1 固定拒绝行为。
- 获取令牌与兑换 cookie 之间重启时，不能泄漏令牌或混淆用户；任务 3 固定重试行为。
- WebSocket 升级和重连必须执行与 HTTP 相同的身份和属主检查；任务 4 固定该行为。
- 已停用用户或服务器满载时，必须有界地响应，不能创建容器；任务 2 固定这两种状态。
- 开发 cookie 或本地监听器不能在 `team-dev` loopback profile 外激活；任务 1 固定拒绝行为。

---

### 任务 1：已认证身份

**文件：** 创建 `integrations/public-harness/packages/router/src/identity.ts`、`dev-identity.ts`、`config.ts`、`tests/identity.spec.ts`、`tests/dev-identity.spec.ts`，以及该包的 README 双语文件和 manifest。

**接口：** `IdentityVerifier.verify(headers: IncomingHttpHeaders): Promise<UserId>` 有正式与开发两种实现。正式实现验证 authentik 签名、签发方、受众、到期时间、精确的 UID 匹配与撤权状态。开发实现只接受 loopback 上固定测试 ID 的签名 cookie。签名密钥来自本地配置，不从请求元数据读取；`UserId` 来自运行环境 contracts 包。

- [ ] **步骤 1：编写失败测试**，覆盖有效 JWT、伪造或缺失或重复的 UID/JWT、到期 JWT、错误的受众或签发方、签名密钥轮换、已停用用户、本地测试用户选择、无效开发 cookie，以及正式模式中的开发身份。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- identity.spec.ts dev-identity.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 有界请求头解析、签名 JWT 验证、用户 ID 解析、撤权查询，以及只允许固定测试用户与 loopback 的独立开发 cookie 签发器。
- [ ] **步骤 4：运行** 聚焦测试；确认通过，然后提交身份处理和 README 双语文件。

### 任务 2：属主路由与容量

**文件：** 创建 `packages/router/src/routes.ts`、`admission.ts`、`tests/routes.spec.ts`；在 `deploy/` 下添加 Caddy 与 authentik 部署配置。

**接口：** `route(request, userId): Promise<{ endpoint: InstanceEndpoint; upstreamPath: string } | Rejection>` 仅对精确的 `/u/${userId}/` 路径返回 `InstanceManager.ensure(userId)` 给出的入口。根路径重定向到当前登录用户路径；未知路径、跨用户路径和容量超限都拒绝访问。

- [ ] **步骤 1：编写失败测试**，覆盖根路径重定向、规范路径、跨用户路径、编码分隔符、点路径、路径前缀冲突、错误用户 ID、停用账号和容量上限。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- routes.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 路径规范化、属主匹配、首次访问每用户锁、有界等待、实例管理服务调用以及就绪和拒绝响应。配置正式环境的 Caddy 替换身份请求头并认证升级。
- [ ] **步骤 4：运行** 聚焦测试；在 Linux 上对正式部署配置运行 `caddy validate`。确认通过后提交。

### 任务 3：在服务端兑换 Harness cookie

**文件：** 创建 `packages/router/src/launch.ts`、`cookies.ts` 和 `tests/launch.spec.ts`。

**接口：** `openBrowserSession(userId, endpoint): Promise<SetCookie>` 取得 `InstanceManager.launchGrant(userId)`，私下请求后端根路径，只接受预期的 303 和一个 Harness cookie，在 HTTPS 下改写其路径与 `Secure` 属性。令牌不会作为 URL 返回或写进日志。

- [ ] **步骤 1：编写失败测试**，覆盖新浏览器、已有签名 cookie、过期启动授权、实例重启、错误 `Set-Cookie`、跨用户 cookie 和令牌脱敏。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- launch.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 私有兑换、严格响应解析、过期授权后重试一次、cookie 路径限定，以及干净的重定向。
- [ ] **步骤 4：运行** 聚焦测试；确认通过后提交。

### 任务 4：HTTP 与 WebSocket 转发

**文件：** 创建 `packages/router/src/server.ts`、`proxy.ts`、`tests/proxy.spec.ts`，以及两个真实 Web 进程的 e2e 测试数据。

**接口：** Cordis bundle 拥有私有 HTTP server。每个普通请求和 `upgrade` 都调用 `IdentityVerifier.verify` 与 `route`；转发层处理 Unix 与 loopback TCP 入口，保留流背压和公开 Host/Origin，剥离挂载前缀，改写 cookie 路径，并在 60 秒时关闭 WebSocket。

- [ ] **步骤 1：编写失败测试**，覆盖 Unix/TCP 转发、HTTP 流、取消、所有升级路径、旧 socket 关闭、身份切换、cookie 路径隔离、未认证升级拒绝和开发模式非 loopback 绑定。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- proxy.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 服务端与转发层，让 HTTP 和升级走同一认证路径，并限制请求头和请求体大小，改写响应头。
- [ ] **步骤 4：在 macOS 和 Windows 上运行** 聚焦测试与两个真实 Web 进程的 e2e；随后在 Linux 上用伪造请求头和撤权账号测试 Caddy/authentik；记录结果后提交。
