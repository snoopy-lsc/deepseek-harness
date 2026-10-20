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

#### 企业微信

`DSH_SSO_PROVIDER=wecom` 为自建应用启用企业微信 Web 登录。必须提供 `DSH_WECOM_CORP_ID`、`DSH_WECOM_AGENT_ID`、`DSH_WECOM_SECRET` 和 `DSH_SSO_ALLOWED_GROUPS`（部门 ID）。把应用的可信域名设为公开主机。除非设置 `DSH_WECOM_DEPARTMENT_RECURSIVE=false`，允许部门的子部门成员也会被放行。私有化部署把 `DSH_WECOM_API_BASE` 与 `DSH_WECOM_LOGIN_URL` 设为自己的 HTTPS 服务器。账户绑定到 `CORPID:userid`（小写）。应用读不到成员邮箱时，账户使用唯一的 `@sso.invalid` 占位地址；注册会拒绝 `.invalid` 地址。access token 只保存在内存中，企业微信使其失效时重新获取一次。超时和未预期错误返回 503。

#### 钉钉

`DSH_SSO_PROVIDER=dingtalk` 为企业内部应用启用钉钉 OAuth 2.0 网页登录。必须提供 `DSH_DINGTALK_CLIENT_ID`（AppKey）、`DSH_DINGTALK_CLIENT_SECRET`、`DSH_DINGTALK_CORP_ID` 和 `DSH_SSO_ALLOWED_GROUPS`（部门 ID）。把 `<publicOrigin>/api/auth/sso/callback` 登记为应用的重定向 URL，并授予成员信息读权限。只有在授权页选择所配置组织的用户才能进入。除非设置 `DSH_DINGTALK_DEPARTMENT_RECURSIVE=false`，子部门成员也会被放行。账户绑定到 `CORPID:unionId`。邮箱和 `@sso.invalid` 占位地址沿用企业微信的规则。私有化部署设置 `DSH_DINGTALK_LOGIN_URL`、`DSH_DINGTALK_API_BASE` 与 `DSH_DINGTALK_OAPI_BASE`，`DSH_DINGTALK_EXCLUSIVE_LOGIN=true` 打开专属账号登录页。超时和未预期错误返回 503。

#### SAML 2.0

`DSH_SSO_PROVIDER=saml` 让服务成为 SAML Service Provider。必须提供 `DSH_SAML_SP_ENTITY_ID`、`DSH_SAML_IDP_ENTITY_ID`、`DSH_SAML_IDP_SSO_URL`（HTTPS）、`DSH_SAML_IDP_CERT_FILE`（PEM 格式的 IdP 签名证书，固定信任）和 `DSH_SSO_ALLOWED_GROUPS`。把 `<publicOrigin>/api/auth/sso/metadata` 交给 IdP，或者提供 entity ID 和 ACS `<publicOrigin>/api/auth/sso/acs`。IdP 必须签名 Response 或 Assertion（`DSH_SAML_WANT_ASSERTIONS_SIGNED=true` 时要求 Assertion 签名），并发送 persistent NameID，除非 `DSH_SAML_NAMEID_FORMAT` 设为 `emailAddress` 或 `unspecified`。账户绑定到 `IDP_ENTITY_ID|NameID`。群组取自 `DSH_SAML_GROUP_ATTRIBUTE`（默认 `groups`），邮箱取自 `DSH_SAML_EMAIL_ATTRIBUTE`（默认 `email`），没有时使用 `@sso.invalid` 占位地址，名称取自 `DSH_SAML_NAME_ATTRIBUTE`。只支持 SP 发起的登录；`DSH_SAML_CLOCK_SKEW_MS`（默认 60000）设置允许的时钟偏差。IdP 要求 AuthnRequest 签名时，设置 `DSH_SAML_SIGN_REQUESTS=true`，并提供 `DSH_SAML_SP_SIGNING_KEY_FILE`（或 `DSH_SAML_SP_SIGNING_KEY`）和 `DSH_SAML_SP_SIGNING_CERT_FILE`（或 `DSH_SAML_SP_SIGNING_CERT`）。IdP 加密 assertion 时，设置 `DSH_SAML_ENCRYPTED_ASSERTIONS=true`，并提供 `DSH_SAML_SP_DECRYPTION_KEY_FILE` 和 `DSH_SAML_SP_DECRYPTION_CERT_FILE`；此时明文 assertion 会被拒绝。私钥文件必须属于服务用户、不能是符号链接，且组和其他用户不可访问（`chmod 600`）；私钥为至少 2048 位的 RSA，并且必须与证书匹配。metadata 会发布两张证书。

#### LDAP / Active Directory

`DSH_SSO_PROVIDER=ldap` 把开始链接换成用户名和口令表单，提交到 `/api/auth/sso/ldap/sign-in`。必须提供 `DSH_LDAP_URL`（`ldaps://`，或 `ldap://` 加 `DSH_LDAP_STARTTLS=true`）、`DSH_LDAP_BIND_DN`、`DSH_LDAP_BIND_PASSWORD`、`DSH_LDAP_BASE_DN` 和 `DSH_SSO_ALLOWED_GROUPS`（组 DN，以 `;` 分隔）。明文 `ldap://` 只在本地模式且主机为回环地址时启动。`DSH_LDAP_CA_FILE` 固定目录服务器的 CA。`DSH_LDAP_SCHEMA` 为 `ad`（默认）或 `openldap`，决定用户过滤器、用户名属性（`sAMAccountName` 或 `uid`）、不可变 ID（`objectGUID` 或 `entryUUID`）和组类的默认值；每项都可用对应的 `DSH_LDAP_*` 覆盖。服务账户先找到唯一一个用户，再以该用户 bind，每次登录一条连接。账户绑定到 `SERVER_ID|不可变 ID`。组来自 `memberOf`、AD 的嵌套成员关系（`DSH_LDAP_GROUP_MODE=nested`）或组搜索（`search`）。禁用的 AD 账户会被拒绝，空口令不会发往服务器，所有凭据错误显示同一条消息。邮箱沿用 `@sso.invalid` 占位规则。多次失败会把该用户名锁定 15 分钟，计数保存在身份数据库中，重启和其他进程共享；超时（`DSH_LDAP_TIMEOUT_MS`，默认 5000）和目录错误返回 503。

#### 自动停用与登录锁定

服务每隔 `DSH_SSO_RECONCILE_INTERVAL_MINUTES`（默认 60；0 关闭）检查所有 SSO 绑定的账户。LDAP/AD、企业微信和钉钉账户会到目录中查询：已删除、已禁用或已离职的用户，以及不在任何允许组或部门的用户都会被停用。设置 `DSH_SSO_MAX_INACTIVE_DAYS` 后，任何提供方中超过该天数未登录的账户也会被停用；对 OIDC 和 SAML 这是唯一的自动检查。停用会立即删除该用户的会话、阻止新的登录并写入审计记录。查询出错或目录不可达从不停用任何人；一次对账按目录结果要停用的人数超过 `DSH_SSO_RECONCILE_MAX_DISABLE`（默认 10）时，一个也不停用，并作为 aborted 记入审计。运维使用 `dsh-identity-sso --config <identity.json> disable --email ADDRESS [--reason TEXT]`、`enable --email ADDRESS` 和 `list-disabled`；重新启用从不自动发生。

LDAP 锁定（15 分钟内同一用户名加 IP 失败 5 次，或同一用户名失败 20 次）和紧急路径锁定（15 分钟内同一账户失败 5 次，只统计来自允许地址的尝试）保存在身份数据库中，键经过哈希，重启后仍然有效。过期记录每十分钟清理一次。

`DSH_SSO_EMERGENCY_ALLOWED_IPS`（IP 或 CIDR 前缀）为 IdP 故障时的管理员开启 `/account/emergency`。登记需要一个邮箱已验证的现有密码账户（例如受邀账户），并只打印一次 TOTP URI：

```sh
sudo -u dsh-identity node /opt/dsh-public/integration/packages/identity/lib/emergency-cli.js --config /etc/dsh-public/identity.json enroll --email admin@corp.example
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json list
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json audit --days 30
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json revoke --email admin@corp.example
```

`DSH_ADMIN_EMAILS` 以逗号分隔列出管理员地址；紧急账户同样是管理员。任何格式错误的条目都会使服务拒绝启动。`GET /account/api/me` 返回当前登录用户的 `{ id, email, name, role }`，`role` 为 `admin` 或 `member`；Harness Web 读取它来显示系统管理入口，管理 API 在服务端重新校验角色。

Harness Web 的个人中心使用 `/account/api/me/*`：`GET /security`（登录方式、能否修改密码、SSO 绑定）、`GET /sessions`（当前用户的会话，不含令牌）、`POST /sessions/revoke`，请求体 `{ id }`（退出另一个会话）、`POST /sessions/revoke-others`、`POST /password`，请求体 `{ currentPassword, newPassword }`（仅限密码账户与紧急账户；以当前密码重新认证；修改后其他会话退出），以及 `GET /usage`（用户自己的账本用量）。所有接口都需要有效会话；写操作需要配置的 Origin 和 `content-type: application/json`，修改密码与撤销会话都会写入审计记录。

个人资料通过 `GET` 和 `POST /account/api/me/profile` 读取和修改。登录用户可编辑自己的姓名和联系电话；工号、部门和职位只能通过 `POST /api/admin/users/profile` 由管理员设置，`userId` 指定目标用户。管理员通过 `GET /api/admin/users/profile?userId=…` 读取目标资料。邮箱保持与登录身份绑定，SSO 姓名由企业身份平台管理。`POST /account/api/me/avatar` 接受编码为 `{ mime, data }` 的 PNG、JPEG 或 WebP 数据，解码后不超过 512 KiB；`{ data: null }` 删除头像。头像仅限本人或管理员读取。资料和头像变更保存在私有身份数据库中，并记录不含联系信息值的审计记录。

`DSH_QUOTA_ACCOUNT_SOCKET` 指向额度服务的账户 socket（即其 `accountSocket`，仅身份服务所在组可连接）。`startIdentity` 通过它提供 `GET /usage` 和额度编辑；未设置且没有测试替换时，两者都返回 404。每次调用都新建连接，因此额度服务可以晚于身份服务启动；连接被拒绝或回复格式不对时返回 503。

系统管理使用 `/api/admin/*`（代理与 `/account/*` 一同转发）。读取：`GET /users`（`q`、`role`、`status`、`offset`、`limit`；返回角色及其来源、状态、登录方式、最近登录）、`GET /invites`、`GET /audit`（`event`、`outcome`、`q`、`before` 游标、`limit`）、`GET /sso`（身份源配置，密钥替换为 `[redacted]`，证书只给数量，以及目录同步计划与最近一次运行）和 `GET /quota`。写入：`POST /invites` `{ ttlHours?, note? }`（邀请码只显示一次）、`POST /invites/revoke` `{ id }`、`POST /users/disable` `{ userId, reason? }`、`POST /users/enable` `{ userId }`、`POST /users/role` `{ userId, role }`、`POST /quota/default` `{ dailyTokens | null }` 、`POST /quota/user` `{ userId, dailyTokens | null }` 和 `POST /quota/principal` `{ principal, dailyTokens | null }`。最后一个设置公司知识库预算主体 `org-kb-<kbId>` 的每日额度，该主体不是登录账号：identity 在重新验证身份之前先向 KB 服务确认它对应一个存在的组织知识库，其他值一律拒绝，并以带主体和知识库的 `admin-quota-change` 记录审计。每个接口都先校验会话和服务端角色，再读取请求体：没有会话返回 401，成员返回 403。写操作需要配置的 Origin 和 JSON 请求体（否则 415），每位管理员每小时最多 120 次（读取 1,200 次），并写入带 `by=<管理员>` 的审计记录。停用复用自动停用路径：在一个事务中删除该账户的全部会话并写入 `sso-disable`。最后一位有效管理员不能被停用或降级（409 `last-admin`），管理员不能停用自己，来自 `DSH_ADMIN_EMAILS` 的管理员和紧急账户不能在控制台降级。控制台授予的管理员记录在 `dsh_role_grant`。停用、角色变更和额度变更需要重新认证：密码管理员再次提交 `password`（错误时 403 `reauth`，每小时最多 10 次）；SSO 管理员的会话必须在 10 分钟内建立，否则返回 401 `{ code: 'reauth-required', method: 'sso' }`，控制台会提供重新 SSO 登录。启用账户和邀请码操作会记录审计，但不要求重新认证。

`GET /api/admin/audit.csv` 按查看器的筛选条件（`event`、`outcome`、`q`）导出审计日志：最新在前，每页 500 条流式输出，最多 50,000 条（`x-audit-export-rows`；被截断时 `x-audit-export-truncated: 1`）。每个字段都加引号并把内部引号写成两个，以 `=`、`+`、`-`、`@`、制表符或 CR 开头的字段前加 `'`，避免表格软件把它当作公式；文件以 UTF-8 BOM 开头，便于 Excel 识别。每位管理员每小时最多导出 10 次，每次导出会先写一条带行数与筛选条件的 `admin-audit-export` 审计记录。`POST /api/admin/quota/over-limit` `{ mode, gracePercent? }` 设置达到个人每日额度时的行为：`block`（默认）拒绝新的请求，`grace` 在额度之外再允许其 `gracePercent`（1–100，默认 10）的用量后拒绝，`warn` 不因个人额度拒绝（站点每日额度仍会拒绝）。它与其他额度变更一样需要重新认证，并以 `admin-over-limit-change` 记录审计；之后 `GET /account/api/me/usage` 会返回 `overLimit`、`state`（`ok`、`grace`、`over`、`blocked`）和 `hardLimitTokens`。

用户组保存在 `dsh_group` 和 `dsh_user_group` 中（ID 带来源前缀，例如 `wecom:42`、`ldap:cn=eng,ou=groups,dc=corp` 或 `local:<uuid>`）。每次 SSO 登录都会替换该用户在这一身份源下的记录；LDAP、企业微信和钉钉的目录同步也会为有效的目录记录刷新它们，而 OIDC 和 SAML 用户组只在登录时变化。`GET /api/admin/groups` 列出同步的和本地的用户组及成员数，`GET /api/admin/groups/members?group=<id>` 列出某个用户组的成员，`POST /api/admin/groups` 接受 `{ op: 'create', name }`、`{ op: 'rename', id, name }`（本地）、`{ op: 'alias', id, name | null }`（同步组；仅用于展示，从不用于授权）或 `{ op: 'delete', id }`（本地，需要重新认证），`POST /api/admin/groups/members` `{ op: 'add' | 'remove', groupId, userId }` 在重新认证后修改本地成员。每次变更都写入 `admin-group-change`，`GET /users` 会返回每个用户的直接 `groups`。`groups.spec.ts` 覆盖存储、登录与目录同步刷新以及这些接口。

`DSH_KB_SOCKET` 指向知识库服务的私有 socket（[`@public-harness/kb`](../kb/README.zh.md)）。设置后，`/account/api/me/kb*` 和 `/api/admin/kb*` 在通过常规检查（会话、管理员角色、Origin、JSON 请求体或最大 25 MB 的 `application/octet-stream` 流式上传、频率限制）后转发到该服务，并通过 `x-dsh-user`、`x-dsh-email` 和 `x-dsh-role` 携带已验证的用户；浏览器发来的同名请求头从不转发。批准、修改范围、撤销、转为管理员维护、创建组织知识库、回滚以及 `PUT` 和 `DELETE` 限额写入都需要重新认证，密码在转发前被移除。身份服务每分钟、每次用户组变更以及新用户首次请求前，把用户及其生效用户组和禁用状态推送给服务，并把服务的审计记录复制到 `dsh_audit`。未设置该变量时这些接口返回 404。`kb-gateway.spec.ts` 针对真实服务覆盖转发、重新认证、用户组同步和审计记录同步。

紧急登录需要允许的来源地址、密码和新的验证器动态码；每个码只能用一次。普通密码表单拒绝已登记的管理员。每次 SSO 与紧急登录尝试都记入审计，超过 365 天的记录会被删除。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

在 Better Auth 处理请求之前，公共监听器先检查 Host 是否等于配置的 origin，拒绝外来的 `X-Forwarded-Host` 和任何 `Forwarded` 头，拒绝多个会话 cookie，并要求每个修改状态的请求都携带精确的 Origin。注册会检查注册开关和 CAPTCHA 响应（邀请模式下检查邀请码），以及两个持久的固定窗口计数器（按客户端地址和按天）。邀请码通过一条带条件（未使用、未吊销、未过期）的 `UPDATE` 认领，因此并发注册无法共用同一邀请码。Better Auth 拒绝注册时邀请码会被释放，与请求失败时释放已用验证链接的方式相同。登录和重置请求有各自的计数器。计数器使用 `BEGIN IMMEDIATE`，因此两个服务进程无法同时取得最后一个名额。Better Auth 的验证链接是签名的无状态令牌，因此服务会记录每个已用链接的哈希并拒绝重放。重置令牌在使用时删除，重置会吊销该账户的会话。

会话是数据库行，并禁用 cookie 缓存，因此退出登录和吊销在下一次查询时即生效。`POST /internal/session` 接收 `{ cookie }`（最多 8 KiB），只对已验证用户的有效会话返回 `{ userId, sessionId, expiresAt }`。其他情况返回 401，存储故障返回 503。遥测已禁用，启动时会拒绝 `BETTER_AUTH_TELEMETRY`，因为该变量会覆盖配置选项。账户页面由服务器渲染，使用经过转义的中英文词典，并在严格的内容安全策略下只运行一个绑定 nonce 的脚本。该脚本加载所配置服务的 SDK，并把结果作为 `X-Captcha-Response` 发送：Turnstile 令牌、原样的阿里云 `captchaVerifyParam`，或腾讯的 `{ticket, randstr}` JSON。腾讯容灾票据（`trerror…`）不会发送，服务端也会拒绝。页面只嵌入公开的组件参数。CSP 只增加该服务所需的 SDK、frame、connect 和图片来源。阿里云接口域名按[白名单](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/captcha-2-0-client-access-faq)由身份标推导，[腾讯](https://cloud.tencent.com/document/product/1110/36828) SDK 域名为 `turing.captcha.qcloud.com`。阿里云和腾讯 SDK 会注入内联样式，因此这些页面允许 `'unsafe-inline'` 样式并去掉样式 nonce，脚本仍绑定 nonce。登录后（密码、SSO 跳转或 LDAP），若请求的 `return` 是账户页或用户自己 `/u/<id>/` 路由下的页面（保留查询与片段），浏览器会直接前往该页面；绝对或协议相对 URL、反斜杠、空白和控制字符、点段、百分号编码的斜杠、反斜杠或点、双重编码以及其他用户的路由都会回退到该路由。服务端与页面脚本共用 `returnTarget`；参见 `safeReturnPath`。

</details>

<a id="further-exploration"></a>
## 延伸阅读

参阅[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[身份实施计划](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-identity.zh.md)与 [Better Auth](https://www.better-auth.com/docs)。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 账户页面是服务器渲染的 HTML，而不是 React 打包产物，不改动 Harness UI。
- 所有服务都尚未在真实账号上运行过。测试模拟服务商 HTTP，并使用本地 TLS SMTP 中继。签名代码与服务商公布的已知答案示例一致。真实 API 响应、组件 SDK 和 CSP 来源列表仍需在真实主机上验证。
- 使用 `none` 时，如果 Better Auth 为避免泄露账户存在而对已注册邮箱返回成功，用该邮箱注册可能会消耗一个邀请码。
- SAML 只针对本地 mock IdP 运行过；真实 IdP（Azure AD、Okta、ADFS）在签名 AuthnRequest 和加密 assertion 下仍需验证。不支持单点登出、导入 metadata 以及不重启的密钥轮换。
- LDAP 只针对本地 mock 目录运行过；真实 AD 或 OpenLDAP 仍需验证。RFC 4514 DN 转义函数未被使用，因为 DN 来自搜索结果。
- 自动停用通过轮询目录实现，没有 Webhook 或 SCIM。真实目录、大型目录（每次对账每个用户查询一次）以及企业微信或钉钉的 API 配额仍需验证。已停用账户只能由运维重新启用。
- 钉钉只在本地 mock 上运行过；真实应用、重定向 URL 和私有化或专属部署仍需检查。
- 企业微信只在本地 mock 上运行过；真实企业、其可信域名和私有化部署仍需检查。读不到邮箱的企业微信成员会在账户页看到 `@sso.invalid` 占位地址。
- OIDC 只在本地 mock IdP 上运行过，Keycloak、Authing 或 Azure AD 仍需在真实主机上检查。群组成员资格在登录时检查，因此把用户移出群组会阻止新会话，但不会结束已有会话。启用 SSO 之前通过公开注册创建的账户在 SSO 模式下不能用密码登录。
- `node:sqlite` 在 Node 22 中仍标记为实验特性，启动时会打印警告。

<a id="dev-note"></a>
## 开发说明

`registration.spec.ts` 在临时 socket 上运行真实服务。`providers.spec.ts` 覆盖模拟的阿里云、腾讯云和 Turnstile 调用、失败即拒绝的解析、超时和页面 CSP。`signing.spec.ts` 包含签名已知答案测试。`smtp.spec.ts` 使用带临时证书的本地 TLS 和 STARTTLS 中继，`invite.spec.ts` 覆盖单次使用、过期、吊销、并发和 CLI。当 `PUBLIC_HARNESS_E2E_BROWSER` 指向 Chrome 可执行文件时，`registration.e2e.ts` 用真实 Chrome 完成注册、验证、登录、进入 Harness 和退出登录。`widgets.e2e.ts` 在 Chrome 中用拦截的 SDK 桩运行每个组件的前端逻辑。`sso-config`、`sso-store`、`totp`、`jwt`、`oidc`、`sso-flow` 和 `emergency` 测试针对 127.0.0.1 上使用临时密钥的 mock IdP（`mock-oidc.ts`）覆盖企业 SSO，`wecom` 与 `wecom-flow` 测试针对 `mock-wecom.ts` 覆盖企业微信，`dingtalk` 与 `dingtalk-flow` 测试针对 `mock-dingtalk.ts` 覆盖钉钉，`saml` 与 `saml-flow` 测试针对 `mock-saml.ts`（每次运行用 openssl 生成密钥）覆盖 SAML，`ldap` 与 `ldap-flow` 测试针对 `mock-ldap.ts`（127.0.0.1 上的 BER 服务器，每次运行生成 CA）覆盖 LDAP，`auth-failure` 覆盖持久化的锁定计数（包括四个进程争抢），`deprovision` 覆盖对账、目录查询、会话撤销和 `sso-cli.ts`，`sso.e2e.ts` 用 Chrome 走完 OIDC、企业微信、钉钉、SAML 与 LDAP 登录，`me.spec.ts` 覆盖个人中心，`quota-account.spec.ts` 针对真实的行协议服务覆盖 `DSH_QUOTA_ACCOUNT_SOCKET`（包括额度服务晚启动），`admin.spec.ts` 覆盖每个 `/api/admin` 接口，包括成员在每个接口上都得到 403。`kb-stack.e2e.ts` 还需要 `PUBLIC_HARNESS_KB_STACK`，即一个正在运行、KB 服务使用模拟模型并带演示数据的本地栈的 127.0.0.1 源地址。它通过模拟 IdP 以管理员身份登录，依次走过个人知识库区域和申请共享对话框、共享申请队列与审核、知识库清单以及限额卡片；设置 `PUBLIC_HARNESS_KB_SHOTS` 时会在该目录保存浅色和深色截图。
