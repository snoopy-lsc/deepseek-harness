# 企业 SSO 基础与 OIDC 实施计划

[English](2026-10-13-enterprise-sso.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让企业私有化部署通过自己的 OpenID Connect 身份提供方登录员工，即时建号仅限允许的群组，并提供受门禁保护的管理员紧急密码通道。

**架构：** 身份服务新增与具体 provider 无关的 SSO 层：仅来自环境变量的 `DSH_SSO_*` 配置；保存 `(provider, subject)` 绑定、账户来源、一次性登录状态和一年审计日志的存储；以及一个 Better Auth 插件，其 start 与 callback 端点签发普通的 Better Auth 会话。OIDC 是该层之后的第一个 provider：使用 discovery、带 PKCE 的授权码流程、state 与 nonce，并用 `node:crypto` 按签发方 JWKS 验证 ID token。路由器继续不变地使用私有会话 socket，因为 SSO 会话就是普通的已验证 Better Auth 会话。

**技术栈：** TypeScript、Node 22、基于 `node:sqlite` 的 Better Auth 1.7.7、`node:crypto`（JWK 导入、RS256/ES256 验签、HMAC-SHA1 TOTP）、Vitest、使用系统 Chrome 的 playwright-core。

**规格：** [企业私有化身份设计](../specs/2026-10-13-enterprise-sso-design.zh.md)，决定 D1–D8。

## 全局约束

- 密钥与 provider 设置只来自服务环境变量（`DSH_SSO_*`、`DSH_OIDC_*`）；JSON 配置文件拒绝 SSO 字段。
- 失败即关闭：未知 provider、缺失或格式错误的变量、空的群组白名单、生产环境的非 HTTPS issuer 都拒绝启动；错误只说明变量名，不包含值。
- `DSH_SSO_PROVIDER` 未设置或为 `off` 时，现有注册、CAPTCHA、邀请码和邮件行为全部不变。
- 绝不仅凭邮箱合并或绑定账户（D2）；邀请码创建的账户永远不能绑定企业 subject（D3）。
- SSO 用户创建时即为已验证邮箱（D4）；紧急账户仍需已验证邮箱。
- 登出只撤销 Harness 会话（D5）。
- 紧急通道仅限管理员，要求来源 IP 白名单与 TOTP 第二因素，审计记录保留 365 天（D6）。
- 即时建号和之后每次登录都要求属于 `DSH_SSO_ALLOWED_GROUPS`（D7）。
- IdP 故障和超时返回 503 且不放行；无效 token、state 或声明返回 403。
- 测试只使用 `127.0.0.1` 上带生成密钥的本地 mock IdP；任何地方都不出现真实 IdP 密钥。
- 构建与测试串行运行，并设置 `NODE_OPTIONS=--max-old-space-size=3072`。
- 除非另有说明，路径相对于 `integrations/public-harness/packages/identity/`。

## 重点审查

- 伪造、重放或跨浏览器的回调不能让任何人登录；任务 4 固定一次性且绑定浏览器的 state、nonce、PKCE 和签名检查。
- 邮箱与现有本地或邀请账户相同的 IdP 用户不能接管该账户；任务 5 固定拒绝而非合并。
- 不在允许群组中的用户得不到账户，被移出群组后也拿不到新会话；任务 5 同时固定这两点。
- 密码登录不能绕过 SSO，紧急管理员也不能使用普通密码表单；任务 5 和 6 固定这些门禁。
- 紧急通道不能从未列出的地址使用，也不能没有新的 TOTP 码或重放旧码；任务 6 固定这一点。

## 文件结构

- `src/sso/config.ts`：`parseSsoEnv` 以及 `SsoConfig`、`EmergencyConfig` 类型。
- `src/sso/store.ts`：SQLite 表和 `SsoStore` 接口（绑定、来源、登录状态、紧急登记、审计）。
- `src/sso/provider.ts`：与 provider 无关的 `SsoProvider` 端口及其错误类型。
- `src/sso/jwt.ts`：紧凑 JWS 解析，以及用 JWK 做 RS256/ES256 验签。
- `src/sso/oidc.ts`：discovery、授权 URL、换码和 ID token 校验。
- `src/sso/totp.ts` 与 `src/sso/ip.ts`：RFC 6238 验证码与地址白名单。
- `src/sso/plugin.ts`：带 `/sso/start` 与 `/sso/callback` 的 Better Auth 插件。
- `src/sso/emergency.ts`：紧急登录门禁。
- `src/emergency-cli.ts`：运维登记紧急管理员。
- 修改：`src/config.ts`、`src/auth.ts`、`src/server.ts`、`src/pages.ts`、`src/index.ts`、`package.json`、包 README 双语文件和 `deploy/native/config/identity.env.example`。

## 共享接口

```ts
export interface SsoIdentity { subject: string; email: string; name: string; groups: string[] }
export interface SsoProvider {
  readonly kind: 'oidc'
  begin(input: { redirectUri: string }): Promise<{ url: string; secrets: { state: string; nonce: string; verifier: string } }>
  finish(input: { code: string; redirectUri: string; nonce: string; verifier: string }): Promise<SsoIdentity>
}
export interface SsoStore {
  saveState(state: string, record: { browser: string; nonce: string; verifier: string; returnTo: string }, now: number): void
  takeState(state: string, browser: string, now: number): { nonce: string; verifier: string; returnTo: string } | undefined
  findSubject(provider: string, subject: string): string | undefined
  bindSubject(provider: string, subject: string, userId: string, now: number): void
  origin(userId: string): 'sso' | 'invite' | 'emergency' | undefined
  setOrigin(userId: string, origin: 'sso' | 'invite' | 'emergency'): void
  audit(event: AuditEvent, now: number): void
}
```

---

### 任务 1：SSO 环境配置

**文件：** 创建 `src/sso/config.ts`、`tests/sso-config.spec.ts`；修改 `src/config.ts`，为 `IdentityConfig` 增加 `sso` 与 `emergency`。

**接口：** 产出 `parseSsoEnv(env: ProviderEnv, mode: 'production' | 'local'): { sso: SsoConfig; emergency: EmergencyConfig }`，其中 `SsoConfig` 为 `{ kind: 'off' }` 或 `{ kind: 'oidc'; issuer; clientId; clientSecret; scopes; groupClaims; allowedGroups; timeoutMs }`，`EmergencyConfig` 为 `{ enabled: false }` 或 `{ enabled: true; allowedIps: readonly string[] }`。

- [ ] **步骤 1：编写失败测试**：未设置和 `off` 得到 `off`；未知 provider、缺少 client ID 或 secret、scopes 不含 `openid`、空的 `DSH_SSO_ALLOWED_GROUPS`、带查询或片段的 issuer、生产环境的 `http:` issuer、本地模式下非回环的 `http:` issuer 都抛出点名变量的 `IdentityConfigError`；格式错误的紧急地址列表抛错；错误信息绝不包含密钥。
- [ ] **步骤 2：运行** 在 `integrations/public-harness` 下执行 `npx vitest run --config vitest.config.ts packages/identity/tests/sso-config.spec.ts`；预期失败。
- [ ] **步骤 3：实现** `parseSsoEnv`，沿用 `parseProviderEnv` 的 `need`/`optional` 规则，并在 `parseIdentityConfig` 中调用。
- [ ] **步骤 4：运行** 该测试和现有身份测试；预期通过；提交。

### 任务 2：SSO 存储、TOTP 与地址白名单

**文件：** 创建 `src/sso/store.ts`、`src/sso/totp.ts`、`src/sso/ip.ts`、`tests/sso-store.spec.ts`、`tests/totp.spec.ts`；修改 `src/database.ts` 暴露迁移后的存储。

**接口：** 产出 `SsoStore`（见上）以及 `enrollEmergency(userId, secret, now)`、`emergencySecret(userId)`、`useTotpStep(userId, step): boolean` 和 `pruneAudit(now)`；`totp(secret: Buffer, step: number): string`、`verifyTotp(secret, code, now, window = 1): number | undefined`；`ipAllowed(ip: string, list: readonly string[]): boolean`。超过 365 天的审计记录在每次写入和启动时删除。

- [ ] **步骤 1：编写失败测试**：state 一次性、十分钟后过期并绑定浏览器值；`bindSubject` 拒绝同一用户的第二个 subject、同一 subject 的第二个用户，以及来源为 `invite` 或 `emergency` 的任何用户；RFC 6238 SHA-1 测试向量；同一 TOTP 时间步不能用两次；IPv4、IPv6 和 IPv4 映射地址的 CIDR 匹配；审计在 365 天边界处清理。
- [ ] **步骤 2：运行** 这些测试；预期失败。
- [ ] **步骤 3：实现** `dsh_sso_link`、`dsh_user_origin`、`dsh_sso_state`、`dsh_emergency` 与 `dsh_audit` 表，state 只存哈希。
- [ ] **步骤 4：运行** 这些测试；预期通过；提交。

### 任务 3：Provider 端口与 JWT 验证

**文件：** 创建 `src/sso/provider.ts`、`src/sso/jwt.ts`、`tests/jwt.spec.ts`。

**接口：** 产出 `SsoProvider`、`SsoIdentity`、`SsoRejectedError(code)`；`verifyJws(token: string, keys: JsonWebKey[]): Record<string, unknown>` 只接受 RS256 与 ES256 并匹配 `kid`。

- [ ] **步骤 1：编写失败测试**，使用生成的 RSA 与 EC 密钥：有效 token 通过；`alg: none`、HS256、错误密钥、未知 `kid`、被篡改的 payload 和格式错误的分段都被拒绝。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现**，使用 `createPublicKey({ format: 'jwk' })` 与 `verify`。**步骤 4：运行**；预期通过；提交。

### 任务 4：针对本地 mock IdP 的 OIDC provider

**文件：** 创建 `src/sso/oidc.ts`、`tests/mock-oidc.ts`、`tests/oidc.spec.ts`。

**接口：** 使用 `SsoConfig`（oidc）与 `verifyJws`。产出 `createOidcProvider(config, { fetch?, clock? }): SsoProvider`。mock IdP 监听 `127.0.0.1`，使用生成的密钥对，提供 discovery、JWKS、带 code 重定向的授权端点，以及校验 client secret、redirect URI 和 PKCE verifier 的 token 端点。

- [ ] **步骤 1：编写失败测试**：discovery 的 issuer 不匹配；授权 URL 携带 `S256` challenge、state 和 nonce；成功换码后按配置的声明返回 subject、email、name 和 groups；错误的 `iss`、`aud`、多个受众却缺少 `azp`、已过期、nonce 错误、缺少 email、`email_verified: false` 和错误签名都以 403 代码拒绝；JWKS 轮换时重新获取一次；IdP 超时或 5xx 抛出 `IdentityUnavailableError`。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现** discovery 与 JWKS 缓存、`client_secret_basic` 及 `client_secret_post` 回退、声明映射。**步骤 4：运行**；预期通过；提交。

### 任务 5：Better Auth 插件、即时建号与服务端门禁

**文件：** 创建 `src/sso/plugin.ts`、`tests/sso-flow.spec.ts`；修改 `src/auth.ts`、`src/server.ts`、`src/index.ts`。

**接口：** 使用 `SsoProvider`、`SsoStore`。产出 Better Auth 路由 `GET /api/auth/sso/start?return=` 与 `GET /api/auth/sso/callback`。start 路由设置短时、仅限本主机的 `dsh-sso` 浏览器 cookie，并与存储的 state 绑定。callback 校验 state、调用 `finish`、要求属于允许群组，然后查找已绑定用户或创建用户（`emailVerified: true`，来源 `sso`）；邮箱已被占用时拒绝；用 `setSessionCookie` 创建会话并重定向到 `/account/`。SSO 模式下，公开监听器拒绝公开注册（邀请码仍可用），只允许邀请来源账户密码登录，并对其他账户的密码重置请求直接应答而不发信。

- [ ] **步骤 1：编写失败测试**，经 Unix socket 针对 mock IdP 走完整流程：首次登录创建一个用户且会话查询返回该用户；第二次登录复用同一 `user.id`；不允许的群组什么也不创建；被移出群组的用户被拒绝；邮箱属于邀请账户时被拒绝且邀请账户保持未绑定；重放或跨浏览器的回调失败；SSO 用户的密码登录被拒绝，而受邀承包商仍可登录；登出只撤销 Harness 会话；`off` 模式下这些路由返回 404。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现** 插件与门禁，并在邀请注册成功后记录邀请来源。**步骤 4：运行** 这些测试和现有身份测试；预期通过；提交。

### 任务 6：管理员紧急密码

**文件：** 创建 `src/sso/emergency.ts`、`src/emergency-cli.ts`、`tests/emergency.spec.ts`；修改 `src/server.ts`、`package.json`（`dsh-identity-emergency` 可执行入口）。

**接口：** 产出 `POST /api/auth/emergency/sign-in`，请求体 `{ email, password, code }`，以及 CLI `dsh-identity-emergency --config <file> (enroll --email <address> | revoke --email <address> | list | audit [--days N])`。登记要求已有带已验证邮箱的密码账户且未绑定 SSO，将其来源改为 `emergency`，并只打印一次 `otpauth://` URI。

- [ ] **步骤 1：编写失败测试**：未配置地址列表时禁用；未列出的地址、缺失、错误或重放的 TOTP 码、未登记的用户和未验证的邮箱都被拒绝并记录审计；普通密码表单拒绝已登记的管理员；紧急路由让管理员登录且会话查询接受；超过 365 天的审计记录消失。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现**：白名单、限流、带防重放的 TOTP，然后转发到 Better Auth `/sign-in/email`。**步骤 4：运行**；预期通过；提交。

### 任务 7：登录页面与浏览器测试

**文件：** 修改 `src/pages.ts`、`tests/account.spec.ts`；创建 `tests/sso.e2e.ts`。

**接口：** SSO 模式下 `/account/login` 显示指向 `/api/auth/sso/start` 的“使用企业账号登录”链接，仅在启用邀请码时保留密码表单；`/account/register` 只在邀请模式下显示。启用时 `/account/emergency` 渲染紧急表单，且其他页面从不链接它。

- [ ] **步骤 1：编写失败测试**，覆盖两种语言和各模式下的页面内容，再写一个端到端测试：Chrome 经本地前置代理打开登录页，跟随 mock IdP 重定向，最终停在显示员工邮箱的 `/account/`。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现** 文案、视图与脚本修改。**步骤 4：运行** 单元与 e2e 测试；预期通过；提交。

### 任务 8：部署文档与门禁

**文件：** 修改 `deploy/native/config/identity.env.example`、`tests/deploy-config.spec.ts`（位于 `integrations/public-harness/` 下）以及身份包 README 双语文件。

- [ ] **步骤 1：** 记录每个 `DSH_SSO_*` 与 `DSH_OIDC_*` 变量、redirect URI 和紧急 CLI；密钥保持占位符。
- [ ] **步骤 2：** 串行运行完整单元测试、`pnpm run typecheck`、e2e 测试、`doc-quick` 和 `verify-export-jsdoc`；提交；推送分支。

### 任务 9：企业微信 Web 登录 provider

**文件：** 创建 `src/sso/wecom.ts`、`tests/mock-wecom.ts`、`tests/wecom.spec.ts`、`tests/wecom-flow.spec.ts`；修改 `src/sso/config.ts`、`src/sso/provider.ts`、`src/index.ts`、`src/server.ts`、`tests/sso-config.spec.ts`、`tests/sso.e2e.ts`、env 示例和 README 双语文件。

**接口：** 不改动地使用任务 5 的插件。产出 `kind: 'wecom'` 的 `createWecomProvider(config, { fetch?, clock? }): SsoProvider`、`wecomPlaceholderEmail(subject): string`，以及 `SsoConfig` 的 `wecom` 分支（`corpId`、`agentId`、`secret`、`apiBase`、`loginUrl`、作为部门 ID 的 `allowedGroups`、`recursiveDepartments`、`timeoutMs`）。subject 为 `CORPID:userid`，其中 `userid` 转为小写。

- [ ] **步骤 1：编写失败测试**：环境变量解析（必需的 corp ID、agent ID、secret 与数字部门；私有化 URL 只允许 HTTPS）；官方登录链接参数；token 缓存、过期以及遇到 token 错误时重新获取一次；拒绝非企业成员、互联企业 ID、已停用成员和无效 code；开启与关闭递归时的子部门放行；目录邮箱优先于占位地址；超时、HTTP 错误和未预期 errcode 返回 503；经监听器的完整流程；拒绝注册 `.invalid` 地址；Chrome 针对 mock 登录页的运行。
- [ ] **步骤 2：运行**；预期失败。**步骤 3：实现** provider 与接线。**步骤 4：运行** 单元、类型检查、e2e 和文档门禁；提交；推送。
