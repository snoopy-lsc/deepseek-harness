# 企业本地部署身份认证设计

[English](2026-10-13-enterprise-sso-design.md) | 中文

## Summary

本文是一份供审阅的设计规格，为[原生公开 Harness 部署](2026-10-11-public-harness-native-design.zh.md)的身份服务扩展企业本地（on-prem）认证能力。目标客户是单台或少量专用 Linux 主机上运行的企业内网部署，员工通过企业微信扫码、钉钉扫码、OIDC、SAML 2.0 或 LDAP/AD 登录，而不是面向互联网的公开自助注册。

设计沿用 [cn-providers](../../../integrations/public-harness/packages/identity/README.zh.md) 已落地的可插拔 CAPTCHA / 邮件模式：协议实现是身份服务内的 provider，密钥只来自环境变量，未知或缺失配置拒绝启动。Better Auth 继续拥有会话、cookie 与私有会话查询；企业身份映射到不可变的 Harness `UserId`。本文不写实现代码，也不改变现有公开注册、Turnstile / 阿里云 / 腾讯验证码或 SMTP 投递的行为；企业模式是部署侧选择，与公开模式互斥或按决策点组合。

## Contents

- [目标与非目标](#goals-and-non-goals)
- [Provider 接口与配置](#provider-interface-and-config)
- [各 Provider 流程概要](#per-provider-flows)
- [与 Better Auth 及现有身份的集成](#better-auth-integration)
- [安全要求](#security)
- [中国大陆可达性](#mainland-china-reachability)
- [分阶段落地与测试策略](#phased-rollout-and-tests)
- [待用户确认的决策点](#decision-points)
- [资料来源](#sources)

<a id="goals-and-non-goals"></a>
## 目标与非目标

### 目标

- 在现有 `@public-harness/identity` 上增加可插拔的企业登录 provider，部署时通过环境变量选择一种（或按决策点允许多种）企业认证方式。
- 员工使用企业身份源完成登录后，获得与现有邮箱密码路径相同形态的 Better Auth 会话；路由器仍通过私有 Unix socket 做实时会话校验。
- 企业主体标识稳定映射到不可变的 Harness 用户 ID；创建实例、额度与存储继续按该 ID 隔离。
- 管理员工紧急密码登录：仅少数运维人员、强门禁、可审计；日常员工不得依赖本地密码。
- 密钥与证书只存在于主机环境变量或 root 拥有的密钥目录；仓库、生成配置与渲染页面不含密钥。
- 失败即拒绝（fail closed）：未知 provider、缺失密钥、证书校验失败、IdP 不可达时拒绝启动或拒绝登录，不得降级为匿名或公开注册。

### 非目标

- 不提供面向公众的社交登录（微信开放平台个人号、GitHub、Google、Apple 等）。
- 不在 Harness 中明文或可逆存储企业目录密码；LDAP 绑定使用后立即丢弃口令。
- 不把企业密码登录作为日常路径；普通员工无本地密码或密码被禁用。
- 不在本设计中实现多租户 SaaS（多家互不相关企业共用一套身份库并按租户隔离）；默认假设**单企业、单部署**（见决策点 D1）。
- 不更换 Better Auth，不把会话改到 IdP 侧 session，也不让路由器直接信任 IdP 断言。
- 不实现企业微信 / 钉钉的“应用内免登”小程序或 H5 内嵌会话；本设计覆盖**网站扫码登录**与标准联邦协议。内嵌免登可作为后续扩展。
- 不改变公开 CAPTCHA（turnstile / aliyun / tencent / none）与邮件（sendmail / smtp）provider 的接口；企业部署通常将 `DSH_CAPTCHA_PROVIDER=none` 且保持 `enrollmentOpen=false`，或完全关闭公开注册入口。

<a id="provider-interface-and-config"></a>
## Provider 接口与配置

### 部署模型

与 CAPTCHA / 邮件一致：

| 层 | 职责 |
| --- | --- |
| 身份 JSON 配置文件 | 拓扑与限额：`publicOrigin`、socket、数据库路径、`secretFile`、limits、`enrollmentOpen` 等。**禁止**出现 `sso` / `ldap` / 企业密钥字段。 |
| 环境变量（`EnvironmentFile=`） | `DSH_SSO_PROVIDER` 与各 provider 的密钥、端点、映射规则。未知值或缺失必填项 → `IdentityConfigError`，拒绝启动。 |
| 运行时 provider | 统一端口：发起登录、处理回调、解析稳定主体、可选拉取组信息。失败抛出 `IdentityUnavailableError` 或返回明确拒绝，不得当成已认证。 |

建议的环境变量前缀：`DSH_SSO_*`。与现有 `DSH_CAPTCHA_*`、`DSH_MAIL_*`、`DSH_SMTP_*` 并列，由同一 `identity.env` 加载。

### 建议的 Provider 枚举

| `DSH_SSO_PROVIDER` | 含义 | 典型密钥 / 配置变量（示意） |
| --- | --- | --- |
| `off`（默认） | 不启用企业登录；保持现有邮箱 / 邀请行为 | 无 |
| `wecom` | 企业微信网站扫码 | `DSH_WECOM_CORP_ID`、`DSH_WECOM_AGENT_ID`、`DSH_WECOM_SECRET` |
| `dingtalk` | 钉钉网站扫码 | `DSH_DINGTALK_APP_KEY`、`DSH_DINGTALK_APP_SECRET` |
| `oidc` | OpenID Connect Authorization Code + PKCE | `DSH_OIDC_ISSUER`、`DSH_OIDC_CLIENT_ID`、`DSH_OIDC_CLIENT_SECRET`（若 IdP 要求）、`DSH_OIDC_SCOPES` |
| `saml` | SAML 2.0 Service Provider | `DSH_SAML_SP_ENTITY_ID`、`DSH_SAML_IDP_METADATA_URL` 或元数据文件路径、`DSH_SAML_SP_CERT_FILE`、`DSH_SAML_SP_KEY_FILE` |
| `ldap` | LDAP / Active Directory 绑定 | `DSH_LDAP_URL`、`DSH_LDAP_BIND_DN` 模板或搜索基、`DSH_LDAP_START_TLS`、可选 `DSH_LDAP_GROUP_FILTER` |

生产模式拒绝把企业密钥写进 JSON；本地测试可用 mock provider（名称待定，例如 `test`），且不得在 `mode=production` 下启用。

### 与 CAPTCHA / 邮件的关系

| 部署形态 | CAPTCHA | 邮件 | 注册入口 | SSO |
| --- | --- | --- | --- | --- |
| 公开互联网 | turnstile / aliyun / tencent 或 none+邀请 | sendmail / smtp | 可按 `enrollmentOpen` 打开 | `off` |
| 企业本地 | 建议 `none`；公开 `/account/register` 关闭 | 仍可用于紧急密码重置通知（若启用紧急路径） | `enrollmentOpen=false`；账户由首次 SSO 即时开通（JIT）或运维预置 | `wecom` / `dingtalk` / `oidc` / `saml` / `ldap` |

企业模式下邀请码（`DSH_CAPTCHA_PROVIDER=none` 的 mint CLI）是否仍可用于“无 SSO 的承包商账号”，已在 D3 决定：受邀承包商可以共存，但永远不能绑定企业 subject。

### 建议的统一端口（设计级，非代码）

```text
EnterpriseAuthProvider
  kind: wecom | dingtalk | oidc | saml | ldap
  startLogin(request) -> Redirect | ChallengePage   // state/nonce/PKCE in short-lived server storage
  finishLogin(callback) -> EnterprisePrincipal      // validated stable principal
  optional refreshGroups(principal) -> string[]
  optional healthCheck() -> ok | unavailable
```

`EnterprisePrincipal` 至少包含：`provider`、`subject`（IdP 内稳定唯一键）、可选 `email` / `displayName`、可选 `groups`。Harness 侧用户 ID **不**使用邮箱或显示名，而使用由 `(provider, subject)` 派生或首次落库时分配的不可变 ID（与现有 Better Auth `user.id` / 品牌 `UserId` 对齐），见下文集成。

<a id="per-provider-flows"></a>
## 各 Provider 流程概要

### 企业微信扫码（`wecom`）

依据[构造扫码登录链接](https://developer.work.weixin.qq.com/document/path/91022)与[获取访问用户身份](https://developer.work.weixin.qq.com/document/path/91023)等开放文档：

1. 浏览器打开身份服务登录页；服务生成不可猜测的 `state`，写入短期服务端存储（绑定 IP 与过期时间），重定向到 `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=CORPID&agentid=AGENTID&redirect_uri=...&state=STATE`。
2. 用户扫码确认后，企业微信带着 `code` 与 `state` 回调 `redirect_uri`（须与应用可信域名完全一致）。
3. 服务校验 `state` 一次性消费；用 `corpid` + `corpsecret` 取 `access_token`（[gettoken](https://developer.work.weixin.qq.com/document/path/91039)，须缓存，禁止把 token 交给前端）。
4. 用 `code` 调用 `auth/getuserinfo` 得到企业内 `userid`；按需再读成员详情。非企业成员（仅 `openid`）默认拒绝，除非决策点放开外部联系人。
5. 将 `userid`（互联场景下的 `CorpId/userid` 格式需规范化）作为 `subject`，进入账户链接与会话签发。

内嵌 JS `WwLogin` 可作为同域 UI 选项，但仍走同一回调与 `state` 校验。

### 钉钉扫码（`dingtalk`）

依据[扫码登录第三方网站](https://open.dingtalk.com/document/orgapp/scan-qr-code-to-log-on-to-third-party-websites)与[根据 sns 临时授权码获取用户信息](https://open.dingtalk.com/document/orgapp/obtain-the-user-information-based-on-the-sns-temporary-authorization)：

1. 重定向到 `https://oapi.dingtalk.com/connect/qrconnect?appid=APPID&response_type=code&scope=snsapi_login&state=STATE&redirect_uri=...`。
2. 回调携带一次性 `code`；服务校验 `state` 后，服务端对 `https://oapi.dingtalk.com/sns/getuserinfo_bycode` 做带 `accessKey` / 时间戳 / HMAC 签名的请求，换取 `unionid` / `openid`。
3. 若需企业内 `userid`，再用企业应用 `access_token` 调用 `topapi/user/getbyunionid` 等接口；**以企业内稳定 `userid` 或文档明确的唯一键作为 `subject`**，避免仅用可变昵称。
4. 签名密钥与 AppSecret 仅存环境变量；时间窗与官方要求对齐（文档对 timestamp 偏差有限制）。

### OIDC（`oidc`）

标准 Authorization Code Flow + PKCE（[RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)、[RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)、[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)）：

1. 发现文档：`{issuer}/.well-known/openid-configuration`（issuer 须 HTTPS，生产禁止明文）。
2. 授权请求带 `state`、`nonce`、`code_challenge`（S256）；服务端保存 verifier。
3. 回调校验 `state`；用 `code` + verifier（及 client secret，若 confidential client）向 token endpoint 换票。
4. 验证 `id_token`：签名（JWKS）、`iss`、`aud`、`exp`、`nonce`；`sub` 作为 `subject`。
5. 可选 UserInfo / 组声明映射；组名到 Harness 角色的映射见安全节，默认不授予管理权限。

公网或客户内网 IdP 均可；中国大陆客户常见为自建 Keycloak、Authing 专有云、腾讯云 / 阿里云 IDaaS 等。

### SAML 2.0 SP（`saml`）

身份服务作为 Service Provider（[SAML 2.0](http://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html)）：

1. 启动时加载 IdP 元数据（URL 仅 HTTPS 且校验证书，或 root 只读文件）；配置 SP entityID、ACS URL（例如 `https://<publicOrigin>/api/auth/sso/saml/acs`）。
2. 登录：签发 AuthnRequest，`RelayState` 绑定短期服务端记录（防 CSRF），重定向至 IdP SSO URL。
3. ACS 接收 Response：验签、校时、Audience、Recipient、InResponseTo；拒绝未签名或签名不匹配的断言。
4. NameID 或约定 Attribute 作为 `subject`；可选 Attribute → 组映射。
5. SP 签名证书与私钥仅来自 `*_CERT_FILE` / `*_KEY_FILE`（0600），从不进仓库。

### LDAP / AD（`ldap`）

1. 登录页收集用户名（非密码表单进前端日志）；服务端对 `DSH_LDAP_URL` 建立连接，优先 StartTLS 或 LDAPS，校验证书。
2. 用搜索账户或 DN 模板定位用户 DN，再以用户 DN + 口令 bind；bind 成功即认证成功，**口令不落盘、不记入日志**。
3. 可选检索 `memberOf` / 组过滤器，做只读组映射。
4. `subject` 使用 objectGUID、`entryUUID` 或稳定的 `sAMAccountName@domain` 策略（部署时固定一种，禁止漂移）。
5. 不支持把 LDAP 口令同步成 Better Auth 本地密码哈希，除非紧急管理路径显式开通且与目录无关。

<a id="better-auth-integration"></a>
## 与 Better Auth 及现有身份的集成

### 会话与路由器

- 企业登录成功后，在身份库中确保存在对应用户行，并签发与现有邮箱登录相同的 Better Auth session cookie（前缀 `dsh-account`，生产 `Secure`，无 cookie cache）。
- 路由器继续调用 `POST /internal/session`；**不**解析 SAML / OIDC token，**不**信任浏览器传入的企业头。
- 退出登录：撤销 Better Auth 会话；可选同步 IdP SLO（SAML Logout / OIDC RP-Initiated Logout）见决策点 D5。

### 账户链接与不可变 UserId

推荐策略（决策点 D2 确认）：

1. **首次成功 SSO**：创建 Better Auth 用户，`id` 为服务生成的不可变标识（与现有注册相同的 ID 空间）；写入 `account` / 扩展表：`(provider, subject) → userId`，唯一约束。
2. **再次登录**：仅按 `(provider, subject)` 查找；找到则刷新会话。禁止仅凭邮箱自动合并，除非运维执行显式链接命令并审计。
3. **邮箱**：若 IdP 提供已验证邮箱，可作为联系字段；企业模式下可跳过“邮件验证链接”门槛，因信任落在 IdP（决策点 D4）。公开邮箱注册路径保持 `requireEmailVerification`。

### 即时开通（JIT）与预置

- **JIT（默认建议）**：SSO 成功即创建网站账户；**仍不**自动创建 Linux 实例或额度（与现有“注册 ≠ 开通实例”一致）。首次进入 Harness 仍走路由器 / 配置服务准入。
- **预置**：运维导入允许的 `subject` 列表，未预置则 SSO 成功也拒绝会话（更严的金融 / 政务场景）。

### 停用与离板（offboarding）

当员工从 IdP 离职或禁用时：

| 机制 | 行为 |
| --- | --- |
| 登录时探测（必选） | 每次 SSO 或定期（OIDC UserInfo / 企业微信读成员 / LDAP 搜索）发现禁用或不存在 → 拒绝新会话，并撤销该用户全部 Better Auth 会话。 |
| 目录 Webhook / SCIM（可选后期） | 收到禁用事件后主动撤销会话并标记账户 `disabled`。 |
| 路由器 | 下一请求或 WebSocket 重连得到 401；已打开的 WebSocket 仍受现有最长寿命约束。 |
| 数据 | 默认保留工作区直至运维确认的删除流程（与原生设计中的停用 / 删除分离一致）；SSO 停用 ≠ 立即purge。 |

### 与邀请码、公开注册共存

| 模式 | 行为 |
| --- | --- |
| SSO only（建议企业默认） | `DSH_SSO_PROVIDER≠off`，`enrollmentOpen=false`，注册页隐藏或重定向到 SSO；`DSH_CAPTCHA_PROVIDER=none` 但不开放公开邀请（或邀请 CLI 仅运维内网使用）。 |
| SSO + 邀请承包商 | SSO 员工走企业登录；无企业身份的承包商用邀请码注册本地账户。两者 userId 空间相同，但 account 链接表不同。需防止邀请用户冒充企业 subject（决策点 D3）。 |
| SSO + 紧急密码 | 见下节；不是第二条“日常密码登录”。 |

### 管理员工紧急密码路径

- **谁**：仅写入允许列表的运维主体（环境变量 `DSH_SSO_EMERGENCY_USER_IDS` 或独立“break-glass”账户表），默认空 = 关闭。
- **如何门禁**：独立 URL（例如 `/account/emergency`），不在普通登录页展示；强制第二因素（TOTP，见已决定的 D6）；全量审计日志（谁、何时、源 IP、是否成功）。
- **密码存储**：Better Auth 标准哈希；与企业目录无关。禁止从 LDAP 同步口令。
- **用途**：IdP 全局故障时恢复平台运维；恢复后应强制重新 SSO 并轮换紧急密码。
- **审计**：写入身份库 append-only 或宿主 journal，保留期由部署规定；不得记录口令。

<a id="security"></a>
## 安全要求

- **CSRF / state / nonce**：所有基于浏览器重定向的 provider（wecom、dingtalk、oidc、saml）必须使用服务端存储的一次性 `state`（及 OIDC `nonce`、PKCE verifier）。`state` 绑定过期时间与可选客户端指纹；回调缺失或不匹配 → 400。
- **回调校验**：`redirect_uri` / ACS 固定为配置的 `publicOrigin` 下路径；拒绝开放重定向。Host / Origin 检查沿用现有 `checkRequestOrigin`。
- **TLS**：出站到 IdP / 企业 API 必须 TLS；证书校验默认开启。LDAP 禁止明文 bind（生产拒绝 `ldap://` 无 StartTLS）。
- **证书与密钥**：SAML SP 密钥、OIDC client secret、企微 / 钉钉 secret 仅环境或 0600 文件；进程内存中持有，日志与错误信息只点名变量名。
- **组映射权限边界**：IdP 组默认只映射到“普通用户可登录”。映射到“可调用配置服务管理接口 / 紧急密码管理”的角色必须显式配置，默认空。禁止“IdP 管理员组自动成为宿主机 root”。
- **时钟**：SAML / OIDC 断言校验允许有限时钟偏移；依赖 NTP。
- **会话**：企业登录不发放长寿命 IdP token 给浏览器；浏览器只持有 Better Auth cookie。
- **失败语义**：IdP 超时 / 5xx → 503（与 CAPTCHA 故障一致）；认证拒绝 → 401/403；不得在故障时放行。

<a id="mainland-china-reachability"></a>
## 中国大陆可达性

| Provider | 典型网络位置 | 部署注意 |
| --- | --- | --- |
| 企业微信 | 公网 API（`qyapi.weixin.qq.com`、`open.work.weixin.qq.com`）；扫码由用户手机完成 | 身份服务主机需能访问企微 API；用户手机需能访问企微。专有云 / 政务版端点若不同，用环境变量覆盖 base URL（白名单校验）。 |
| 钉钉 | 公网 `oapi.dingtalk.com` 等 | 同上；部分政企专有钉钉需替换 endpoint。 |
| OIDC / SAML | 多为客户机房或专有云 IdP | 身份服务与 IdP 双向可达即可；可纯内网，Caddy 仅对办公网开放。 |
| LDAP / AD | 几乎总在内网 | 身份服务应与域控同网或专线；勿把 LDAP 暴露到公网。 |

公开验证码（Turnstile）在企业内网常不可达，故企业部署优先 `DSH_CAPTCHA_PROVIDER=none`。邮件可用内网 SMTP 或现有 `smtp` provider 指向企业邮推。

<a id="phased-rollout-and-tests"></a>
## 分阶段落地与测试策略

### 建议阶段

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| P0 设计冻结 | 本文决策点确认 | 用户勾选 D1–D8 |
| P1 框架 | `DSH_SSO_PROVIDER` 解析、fail-closed、账户链接表、登录页入口、紧急路径骨架 | 单元测试：未知 provider 拒启；`off` 行为不变 |
| P2 OIDC + PKCE | 最通用联邦；便于本地用 Keycloak mock | 已知答案式 JWT / state 测试；真实 Keycloak checklist |
| P3 企业微信扫码 | 大陆客户高频 | Mock 企微 HTTP；沙箱企业真实扫码 checklist |
| P4 钉钉扫码 | 同上 | Mock + 真实应用 checklist |
| P5 SAML SP | 传统 ADFS / 云 IdP | xml 签名夹具；真实 IdP checklist |
| P6 LDAP/AD | 无联邦的存量目录 | 仅允许测试容器内 OpenLDAP；禁止对生产目录做破坏性测 |
| P7 硬ening | SLO、SCIM/停用 webhook、组映射、审计导出 | 安全复审 |

### 测试策略

- **单元 / 集成**：Mock IdP HTTP 与 LDAP；固定密钥下的 state 消费、断言校验失败、超时 → 503；账户链接唯一约束；紧急用户白名单。
- **不在 CI 存真实企业密钥**；与 cn-providers 相同。
- **真实 IdP checklist**（每 provider）：创建应用 / 信任域、走通首次 JIT、二次登录、禁用用户后会话失效、错误 secret → 拒启或拒登录、CSP / 回调 URL 与文档一致。
- **回归**：`DSH_SSO_PROVIDER=off` 时现有注册、验证码、邀请、SMTP、E2E 账户流必须保持绿。

<a id="decision-points"></a>
## 待用户确认的决策点

状态：**已决定**（2026-10-13）。以下决定取代原先的待确认清单，并约束实现计划 `docs/superpowers/plans/2026-10-13-enterprise-sso.md`。

- **D1 租户模型（已决定）**：单企业单部署：一套身份库、一个 `DSH_SSO_PROVIDER`。多租户共用另开设计。
- **D2 UserId 映射（已决定）**：首次 SSO 登录分配不可变的 `user.id`，以 `(provider, subject)` 唯一绑定。绝不仅凭邮箱自动合并账户；邮箱已被其他账户占用时拒绝登录。
- **D3 与邀请码共存（已决定）**：企业默认仅 SSO。受邀承包商账户可以共存，但邀请码创建的账户日后永远不能绑定企业 `subject`。
- **D4 邮箱验证（已决定）**：SSO 用户信任 IdP，跳过 Better Auth 邮件验证；紧急密码账户仍要求已验证邮箱。
- **D5 登出范围（已决定）**：登出只撤销 Harness 会话；暂不做 SAML/OIDC 单点登出。
- **D6 紧急密码（已决定）**：保留，仅限管理员；要求来源 IP 白名单与强制第二因素，审计日志保留一年。
- **D7 JIT 与预置（已决定）**：首次登录即时建号，但仅限配置的部门或群组。
- **D8 Provider 优先级（已决定）**：OIDC → 企业微信 → 钉钉 → SAML → LDAP；客户需要时 LDAP 可以插队。

<a id="sources"></a>
## 资料来源

- 现有身份与可插拔验证码 / 邮件：[identity README](../../../integrations/public-harness/packages/identity/README.zh.md)、原生部署设计[身份与注册](2026-10-11-public-harness-native-design.zh.md#identity-and-registration)
- 企业微信：扫码登录与 OAuth 相关文档（[构造扫码登录链接](https://developer.work.weixin.qq.com/document/path/91022)、[获取访问用户身份](https://developer.work.weixin.qq.com/document/path/91023)、[gettoken](https://developer.work.weixin.qq.com/document/path/91039)）
- 钉钉：[扫码登录第三方网站](https://open.dingtalk.com/document/orgapp/scan-qr-code-to-log-on-to-third-party-websites)、[sns/getuserinfo_bycode](https://open.dingtalk.com/document/orgapp/obtain-the-user-information-based-on-the-sns-temporary-authorization)
- OIDC / OAuth：[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)、[RFC 7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- SAML：[OASIS SAML 2.0 技术概述](http://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html)
- LDAP：部署侧使用 LDAPS / StartTLS；具体属性映射依客户目录而定
