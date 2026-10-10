# 公开 Harness 路由实施计划

[English](2026-10-10-public-harness-router.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 通过一个 HTTPS 地址，只把已认证的浏览器连接到该用户自己的 Harness Web 实例。

**架构：** Caddy 为每次请求和 WebSocket 握手处理 TLS 与 authentik 前置认证，再通过受权限保护的 Unix socket 转发。非 root 的 Cordis 路由按照配置的签发方、受众和签名密钥验证 authentik 的签名身份，向配置服务取得该用户的入口，并剥离 `/u/<id>/` 前缀。路由在服务端兑换 Harness 启动令牌，把返回的 cookie 限定在该路径，不把令牌放进浏览器 URL。

**技术栈：** TypeScript、Node 22.19+ 或 24+、Cordis、Caddy、authentik、签名 JWT 验证、HTTP/WebSocket 转发、Vitest。

**规格：** [公开多用户 Harness 设计](../specs/2026-10-10-public-team-harness-design.zh.md)。

**前置工作：** 完成[运行环境计划](2026-10-10-public-harness-runtime.zh.md)和[额度计划](2026-10-10-public-harness-quota.zh.md)；在 Linux 集成前，路由单元测试可以使用协议 mock。

## 全局约束

- 路由代码放在 `integrations/public-harness/packages/router/`，作为独立版本的 Cordis bundle，由 `dsh --profile team-router` 启动；它不以 root 运行。
- 只有 Caddy 服务账号可以打开路由 Unix socket。Caddy 删除客户端传入的身份请求头，并复制 authentik 前置认证结果中的身份值。
- 路由为每次 HTTP 请求和升级验证一份签名身份，检查固定签发方、受众、密钥来源、到期时间，以及 `sub` 与 UID 是否一致。错误格式、重复、缺失或已撤权身份都拒绝访问。
- 路径格式为 `/u/<opaque-id>/...`；路由只剥离准确匹配属主的前缀，保留公开 Host 和 Origin，并且只转发到该用户的配置服务入口。
- Harness cookie 是 host-only、`HttpOnly`、`SameSite=Strict`，在 HTTPS 下带 `Secure`，且 `Path=/u/<id>/`。每条已打开的 WebSocket 在 60 秒内结束，重连时必须重新认证。
- 任务文件列表中的路径若未写出 `integrations/public-harness/` 前缀，均相对于该目录。

## 重点审查

- 编码的斜杠、点路径或前缀冲突不能选中其他用户后端；任务 2 固定路径规范化行为。
- 重复身份请求头或属于其他受众的有效 JWT 不能通过认证；任务 1 固定拒绝行为。
- 获取令牌与兑换 cookie 之间重启时，不能泄漏令牌或混淆用户；任务 3 固定重试行为。
- WebSocket 升级和重连必须执行与 HTTP 相同的身份和属主检查；任务 4 固定该行为。
- 已停用用户或服务器满载时，必须有界地响应，不能创建容器；任务 2 固定这两种状态。

---

### 任务 1：已认证身份

**文件：** 创建 `integrations/public-harness/packages/router/src/identity.ts`、`config.ts`、`tests/identity.spec.ts`，以及该包的 README 双语文件和 manifest。

**接口：** `verifyIdentity(headers: IncomingHttpHeaders): Promise<UserId>` 验证已配置的 authentik 签名、签发方、受众、到期时间和精确的 UID 匹配。密钥来源在服务端配置，不从请求元数据读取。`UserId` 来自运行环境计划中的 contracts 包。

- [ ] **步骤 1：编写失败测试**，覆盖有效 JWT、伪造或缺失或重复的 UID/JWT、到期 JWT、错误的受众或签发方、签名密钥轮换和已停用用户。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- identity.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 有界请求头解析、签名 JWT 验证、用户 ID 解析和撤权查询；authentik 不可用时拒绝访问。
- [ ] **步骤 4：运行** 聚焦测试；确认通过，然后提交身份处理和 README 双语文件。

### 任务 2：属主路由与容量

**文件：** 创建 `packages/router/src/routes.ts`、`admission.ts`、`tests/routes.spec.ts`；在 `deploy/` 下添加 Caddy 与 authentik 部署配置。

**接口：** `route(request, userId): Promise<{ socketPath; upstreamPath } | Rejection>` 仅对精确的 `/u/${userId}/` 路径返回 `ProvisionerClient.ensure(userId)` 给出的入口。根路径重定向到当前登录用户路径；未知路径、跨用户路径和容量超限都拒绝访问。

- [ ] **步骤 1：编写失败测试**，覆盖根路径重定向、规范路径、跨用户路径、编码分隔符、点路径、路径前缀冲突、错误用户 ID、停用账号和容量上限。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- routes.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 路径规范化、属主匹配、首次访问每用户锁、有界等待、配置服务调用以及就绪和拒绝响应。配置 Caddy 替换身份请求头并认证升级。
- [ ] **步骤 4：运行** 聚焦测试，并对部署配置运行 `caddy validate`；确认通过后提交。

### 任务 3：在服务端兑换 Harness cookie

**文件：** 创建 `packages/router/src/launch.ts`、`cookies.ts` 和 `tests/launch.spec.ts`。

**接口：** `openBrowserSession(userId, endpoint): Promise<SetCookie>` 取得 `ProvisionerClient.launchGrant(userId)`，私下请求后端根路径，只接受预期的 303 和一个 Harness cookie，并改写其路径与 `Secure` 属性。令牌不会作为 URL 返回或写进日志。

- [ ] **步骤 1：编写失败测试**，覆盖新浏览器、已有签名 cookie、过期启动授权、实例重启、错误 `Set-Cookie`、跨用户 cookie 和令牌脱敏。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- launch.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 私有兑换、严格响应解析、过期授权后重试一次、cookie 路径限定，以及干净的重定向。
- [ ] **步骤 4：运行** 聚焦测试；确认通过后提交。

### 任务 4：HTTP 与 WebSocket 转发

**文件：** 创建 `packages/router/src/server.ts`、`proxy.ts`、`tests/proxy.spec.ts`，以及两个真实 Web 进程的 e2e 测试数据。

**接口：** Cordis bundle 拥有私有 HTTP server。每个普通请求和 `upgrade` 都调用 `verifyIdentity` 与 `route`；转发层保留流背压和公开 Host/Origin，剥离挂载前缀，改写 cookie 路径，并在 60 秒时关闭 WebSocket。

- [ ] **步骤 1：编写失败测试**，覆盖 HTTP 流、取消、所有升级路径、旧 socket 关闭、身份切换、cookie 路径隔离和未认证升级拒绝。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- proxy.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 服务端与转发层，让 HTTP 和升级走同一认证路径，并限制请求头和请求体大小，改写响应头。
- [ ] **步骤 4：运行** 聚焦测试和两个真实 Web 进程的 e2e；随后在 Linux 上用伪造请求头和撤权账号测试 Caddy/authentik；记录结果后提交。
