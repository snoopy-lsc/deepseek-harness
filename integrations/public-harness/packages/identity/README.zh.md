---
description: "原生公共 Harness 的 Better Auth 注册、邮箱验证会话与账户页面，提供适用于中国大陆的可插拔人机验证与邮件服务、仅邀请模式、带管理员紧急通道的企业 OIDC 登录，并为路由器提供私有会话 socket。"
kind: "package-library"
---

# @public-harness/identity

[English](README.md) | 中文

## Summary

为原生 Harness 部署提供公共注册和浏览器会话。Better Auth 把账户和会话保存在私有 SQLite 文件中。登录前必须完成邮箱验证，验证链接和重置链接都只能使用一次。准入限制持久保存在数据库中。路由器通过私有 Unix socket 在每个请求和 WebSocket 握手时检查当前会话。人机验证和邮件是由环境变量选择的可插拔服务：阿里云验证码 2.0、腾讯云天御验证码、Cloudflare Turnstile 或仅邀请注册，以及 sendmail 或阿里云邮件推送、腾讯云 SES 等需认证的 TLS SMTP 中继。仅在网站注册不会创建 Linux 账号、实例或模型额度；除非运维人员开启，公共注册保持关闭。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`parseIdentityConfig(file, env)` 接收 JSON 文件和进程环境变量。文件包含 `mode`（`production` 或 `local`）、精确的 `publicOrigin`、两个 Unix socket（供 HTTPS 代理使用的 `publicSocket`，以及供路由器使用的 `sessionSocket` 和 `sessionSocketGid`）、`databaseFile`、`secretFile`、`limits`、会话与验证有效期、受信任代理的 `clientIpHeader`，以及可选的 `enrollmentOpen`（默认 false）。邮件和 CAPTCHA 设置只来自环境变量，文件中出现 `mail` 或 `captcha` 键会被拒绝。生产模式要求 HTTPS origin，并拒绝 `mailbox` 邮件服务和 `test` CAPTCHA，这两者只用于回环地址上的本地运行。`startIdentity(config)` 打开或以 0600 权限创建数据库，执行 Better Auth 架构迁移，并监听两个 socket。Cordis `apply` 从 `configFile` 读取 JSON，从 `process.env` 读取服务设置。在原生主机上，systemd 从运维人员创建的 `/etc/dsh-public/identity-secrets/identity.env`（root，0600）加载它们；参见 [identity.env.example](../../deploy/native/config/identity.env.example)。

### Providers

未知服务、缺失或格式错误的变量、不匹配的 endpoint 都会拒绝启动。错误只给出变量名，从不包含变量值。密钥从不出现在仓库、配置文件或渲染的页面中。

| `DSH_CAPTCHA_PROVIDER` | 变量 | 服务端校验 |
| --- | --- | --- |
| `aliyun` | `DSH_ALIYUN_CAPTCHA_ACCESS_KEY_ID`、`DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET`、`DSH_ALIYUN_CAPTCHA_SCENE_ID`、`DSH_ALIYUN_CAPTCHA_PREFIX`（身份标），可选 `DSH_ALIYUN_CAPTCHA_REGION`（默认 `cn`，或 `sgp`）和 `DSH_ALIYUN_CAPTCHA_ENDPOINT`（该地域的 IPv4、双栈或 VPC 域名） | [`VerifyIntelligentCaptcha`](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access) 2023-03-05，表单正文 `CaptchaVerifyParam` + `SceneId`，使用 [ACS3-HMAC-SHA256](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature) 签名；仅 `Result.VerifyResult === true` 通过 |
| `tencent` | `DSH_TENCENT_CAPTCHA_SECRET_ID`、`DSH_TENCENT_CAPTCHA_SECRET_KEY`（CAM API 密钥）、`DSH_TENCENT_CAPTCHA_APP_ID`、`DSH_TENCENT_CAPTCHA_APP_SECRET_KEY` | 在 `captcha.tencentcloudapi.com` 调用 [`DescribeCaptchaResult`](https://cloud.tencent.com/document/product/1110/36926) 2019-07-22，`CaptchaType` 9，携带票据、随机串和客户端地址，使用 [TC3-HMAC-SHA256](https://www.tencentcloud.com/document/product/1080/38766) 签名；仅 `CaptchaCode === 1` 通过 |
| `turnstile` | `DSH_TURNSTILE_SITE_KEY`、`DSH_TURNSTILE_SECRET_KEY` | [siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) |
| `none` | 无 | 仅邀请：注册需要有效邀请码而非 CAPTCHA |
| `test` | `DSH_CAPTCHA_TEST_TOKEN` | 仅本地模式 |

`DSH_CAPTCHA_TIMEOUT_MS`（默认 5000）限制每次校验调用的时长。超时、传输失败、HTTP 错误或 API 层错误（签名错误、实例欠费）都返回 503 且不放行任何请求。错误、过期或重复使用的票据返回 400。

| `DSH_MAIL_PROVIDER` | 变量 |
| --- | --- |
| `smtp` | `DSH_SMTP_HOST`、`DSH_SMTP_PORT`、`DSH_SMTP_SECURITY`（`tls` 表示隐式 TLS，或 `starttls`；不提供明文模式）、`DSH_SMTP_USER`、`DSH_SMTP_PASSWORD`、`DSH_MAIL_FROM`，可选 `DSH_SMTP_TIMEOUT_MS`（默认 15000） |
| `sendmail` | `DSH_SENDMAIL_COMMAND`、`DSH_MAIL_FROM` |
| `mailbox` | `DSH_MAILBOX_DIR`、`DSH_MAIL_FROM`；仅本地模式 |

SMTP 地址：[阿里云邮件推送](https://help.aliyun.com/zh/direct-mail/smtp-endpoints)使用 `smtpdm.aliyun.com`，465 端口配 `tls`，或 80/25 端口配 `starttls`；用户名为发信地址，密码为控制台设置的 SMTP 密码。[腾讯云邮件推送](https://cloud.tencent.com/document/product/1288/65750)使用 `smtp.qcloudmail.com`（或 `gz-smtp.qcloudmail.com`），465 端口配 `tls`，或 25 端口配 `starttls`。两家云服务器默认都封禁出方向 25 端口。

### 仅邀请注册

设置 `DSH_CAPTCHA_PROVIDER=none` 时，注册页要求填写邀请码，并以 `X-Invite-Code` 发送。此模式下注册从不公开，因此 `enrollmentOpen` 不适用。每个邀请码只能注册一个账户，按地址和按天的注册限制仍然生效。以服务账号生成邀请码：

```sh
sudo -u dsh-identity node /opt/dsh-public/integration/packages/identity/lib/invite-cli.js --config /etc/dsh-public/identity.json mint --ttl-hours 72 --count 5 --note "wave 1"
sudo -u dsh-identity node …/invite-cli.js --config /etc/dsh-public/identity.json list
sudo -u dsh-identity node …/invite-cli.js --config /etc/dsh-public/identity.json revoke <id>
```

`mint` 只打印每个邀请码一次。数据库只保存 SHA-256 哈希、ID、过期时间、备注，以及使用后的时间和注册邮箱。`list` 从不显示邀请码。

代理把 `/api/auth/*` 和 `/account/*` 转发到 `publicSocket`，从不暴露 `sessionSocket`。路由器在其生产配置文件中用 `identity.kind: better-auth` 选择此模式；参见[路由器原生身份](../router/src/native-identity.ts)。

### 企业 SSO

`DSH_SSO_PROVIDER=oidc` 为单企业部署开启企业登录；未设置或为 `off` 时行为不变。必须提供 `DSH_OIDC_ISSUER`（HTTPS）、`DSH_OIDC_CLIENT_ID`、`DSH_OIDC_CLIENT_SECRET` 和非空的 `DSH_SSO_ALLOWED_GROUPS`。`DSH_OIDC_SCOPES`（默认 `openid email profile`）、`DSH_OIDC_GROUP_CLAIMS`（默认 `groups`，逗号分隔的声明名）和 `DSH_OIDC_TIMEOUT_MS` 可选。在 IdP 上把 `<publicOrigin>/api/auth/sso/callback` 注册为机密客户端的 redirect URI。之后登录页显示“使用企业账号登录”。允许群组的成员首次登录时创建一个邮箱已验证的账户，并绑定到 IdP 的 `sub`；之后只按该绑定查找。邮箱已被其他账户占用时拒绝登录，而不是合并。公开注册关闭。设置 `DSH_CAPTCHA_PROVIDER=none` 时，受邀承包商仍可用密码注册和登录，但其账户永远不能绑定企业 subject。登出只结束 Harness 会话。参见[设计](../../../../docs/superpowers/specs/2026-10-13-enterprise-sso-design.zh.md)和[计划](../../../../docs/superpowers/plans/2026-10-13-enterprise-sso.zh.md)。

`DSH_SSO_EMERGENCY_ALLOWED_IPS`（IP 或 CIDR 前缀）为 IdP 故障时的管理员开启 `/account/emergency`。登记需要一个邮箱已验证的现有密码账户（例如受邀账户），并只打印一次 TOTP URI：

```sh
sudo -u dsh-identity node /opt/dsh-public/integration/packages/identity/lib/emergency-cli.js --config /etc/dsh-public/identity.json enroll --email admin@corp.example
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json list
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json audit --days 30
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json revoke --email admin@corp.example
```

紧急登录需要允许的来源地址、密码和新的验证器动态码；每个码只能用一次。普通密码表单拒绝已登记的管理员。每次 SSO 与紧急登录尝试都记入审计，超过 365 天的记录会被删除。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

在 Better Auth 处理请求之前，公共监听器先检查 Host 是否等于配置的 origin，拒绝外来的 `X-Forwarded-Host` 和任何 `Forwarded` 头，拒绝多个会话 cookie，并要求每个修改状态的请求都携带精确的 Origin。注册会检查注册开关和 CAPTCHA 响应（邀请模式下检查邀请码），以及两个持久的固定窗口计数器（按客户端地址和按天）。邀请码通过一条带条件（未使用、未吊销、未过期）的 `UPDATE` 认领，因此并发注册无法共用同一邀请码。Better Auth 拒绝注册时邀请码会被释放，与请求失败时释放已用验证链接的方式相同。登录和重置请求有各自的计数器。计数器使用 `BEGIN IMMEDIATE`，因此两个服务进程无法同时取得最后一个名额。Better Auth 的验证链接是签名的无状态令牌，因此服务会记录每个已用链接的哈希并拒绝重放。重置令牌在使用时删除，重置会吊销该账户的会话。

会话是数据库行，并禁用 cookie 缓存，因此退出登录和吊销在下一次查询时即生效。`POST /internal/session` 接收 `{ cookie }`（最多 8 KiB），只对已验证用户的有效会话返回 `{ userId, sessionId, expiresAt }`。其他情况返回 401，存储故障返回 503。遥测已禁用，启动时会拒绝 `BETTER_AUTH_TELEMETRY`，因为该变量会覆盖配置选项。账户页面由服务器渲染，使用经过转义的中英文词典，并在严格的内容安全策略下只运行一个绑定 nonce 的脚本。该脚本加载所配置服务的 SDK，并把结果作为 `X-Captcha-Response` 发送：Turnstile 令牌、原样的阿里云 `captchaVerifyParam`，或腾讯的 `{ticket, randstr}` JSON。腾讯容灾票据（`trerror…`）不会发送，服务端也会拒绝。页面只嵌入公开的组件参数。CSP 只增加该服务所需的 SDK、frame、connect 和图片来源。阿里云接口域名按[白名单](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/captcha-2-0-client-access-faq)由身份标推导，[腾讯](https://cloud.tencent.com/document/product/1110/36828) SDK 域名为 `turing.captcha.qcloud.com`。阿里云和腾讯 SDK 会注入内联样式，因此这些页面允许 `'unsafe-inline'` 样式并去掉样式 nonce，脚本仍绑定 nonce。登录后页面只链接到用户自己的 `/u/<id>/` 路由；参见 `safeReturnPath`。

</details>

<a id="further-exploration"></a>
## 延伸阅读

参阅[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[身份实施计划](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-identity.zh.md)与 [Better Auth](https://www.better-auth.com/docs)。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 账户页面是服务器渲染的 HTML，而不是 React 打包产物，不改动 Harness UI。
- 所有服务都尚未在真实账号上运行过。测试模拟服务商 HTTP，并使用本地 TLS SMTP 中继。签名代码与服务商公布的已知答案示例一致。真实 API 响应、组件 SDK 和 CSP 来源列表仍需在真实主机上验证。
- 使用 `none` 时，如果 Better Auth 为避免泄露账户存在而对已注册邮箱返回成功，用该邮箱注册可能会消耗一个邀请码。
- OIDC 只在本地 mock IdP 上运行过，Keycloak、Authing 或 Azure AD 仍需在真实主机上检查。群组成员资格在登录时检查，因此把用户移出群组会阻止新会话，但不会结束已有会话。启用 SSO 之前通过公开注册创建的账户在 SSO 模式下不能用密码登录。
- `node:sqlite` 在 Node 22 中仍标记为实验特性，启动时会打印警告。

<a id="dev-note"></a>
## 开发说明

`registration.spec.ts` 在临时 socket 上运行真实服务。`providers.spec.ts` 覆盖模拟的阿里云、腾讯云和 Turnstile 调用、失败即拒绝的解析、超时和页面 CSP。`signing.spec.ts` 包含签名已知答案测试。`smtp.spec.ts` 使用带临时证书的本地 TLS 和 STARTTLS 中继，`invite.spec.ts` 覆盖单次使用、过期、吊销、并发和 CLI。当 `PUBLIC_HARNESS_E2E_BROWSER` 指向 Chrome 可执行文件时，`registration.e2e.ts` 用真实 Chrome 完成注册、验证、登录、进入 Harness 和退出登录。`widgets.e2e.ts` 在 Chrome 中用拦截的 SDK 桩运行每个组件的前端逻辑。`sso-config`、`sso-store`、`totp`、`jwt`、`oidc`、`sso-flow` 和 `emergency` 测试针对 127.0.0.1 上使用临时密钥的 mock IdP（`mock-oidc.ts`）覆盖企业 SSO，`sso.e2e.ts` 用 Chrome 走完企业登录。
