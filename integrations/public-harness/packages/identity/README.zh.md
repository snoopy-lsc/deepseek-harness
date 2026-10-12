---
description: "原生公共 Harness 的 Better Auth 注册、邮箱验证会话与账户页面，并为路由器提供私有会话 socket。"
kind: "package-library"
---

# @public-harness/identity

[English](README.md) | 中文

## Summary

为原生 Harness 部署提供公共注册和浏览器会话。Better Auth 把账户和会话保存在私有 SQLite 文件中。登录前必须完成邮箱验证，验证链接和重置链接都只能使用一次。准入限制持久保存在数据库中。路由器通过私有 Unix socket 在每个请求和 WebSocket 握手时检查当前会话。仅在网站注册不会创建 Linux 账号、实例或模型额度；除非运维人员开启，公共注册保持关闭。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`parseIdentityConfig` 接收 `mode`（`production` 或 `local`）、精确的 `publicOrigin`、两个 Unix socket（供 HTTPS 代理使用的 `publicSocket`，以及供路由器使用的 `sessionSocket` 和 `sessionSocketGid`）、`databaseFile`、`secretFile`、`mail`、`captcha`、`limits`、会话与验证有效期、受信任代理的 `clientIpHeader`，以及可选的 `enrollmentOpen`（默认 false）。生产模式要求 HTTPS origin、`sendmail` 投递和 Cloudflare Turnstile。它拒绝 `mailbox` 和 `test` 传输，这两种传输只用于回环地址上的本地运行。`startIdentity(config)` 打开或以 0600 权限创建数据库，执行 Better Auth 架构迁移，并监听两个 socket。Cordis `apply` 从 `configFile` 读取同样的 JSON。

代理把 `/api/auth/*` 和 `/account/*` 转发到 `publicSocket`，从不暴露 `sessionSocket`。路由器在其生产配置文件中用 `identity.kind: better-auth` 选择此模式；参见[路由器原生身份](../router/src/native-identity.ts)。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

在 Better Auth 处理请求之前，公共监听器先检查 Host 是否等于配置的 origin，拒绝外来的 `X-Forwarded-Host` 和任何 `Forwarded` 头，拒绝多个会话 cookie，并要求每个修改状态的请求都携带精确的 Origin。注册会检查注册开关、CAPTCHA 响应和两个持久的固定窗口计数器（按客户端地址和按天）。登录和重置请求有各自的计数器。计数器使用 `BEGIN IMMEDIATE`，因此两个服务进程无法同时取得最后一个名额。Better Auth 的验证链接是签名的无状态令牌，因此服务会记录每个已用链接的哈希并拒绝重放。重置令牌在使用时删除，重置会吊销该账户的会话。

会话是数据库行，并禁用 cookie 缓存，因此退出登录和吊销在下一次查询时即生效。`POST /internal/session` 接收 `{ cookie }`（最多 8 KiB），只对已验证用户的有效会话返回 `{ userId, sessionId, expiresAt }`。其他情况返回 401，存储故障返回 503。遥测已禁用，启动时会拒绝 `BETTER_AUTH_TELEMETRY`，因为该变量会覆盖配置选项。账户页面由服务器渲染，使用经过转义的中英文词典，并在严格的内容安全策略下只运行一个绑定 nonce 的脚本。登录后页面只链接到用户自己的 `/u/<id>/` 路由；参见 `safeReturnPath`。

</details>

<a id="further-exploration"></a>
## 延伸阅读

参阅[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[身份实施计划](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-identity.zh.md)与 [Better Auth](https://www.better-auth.com/docs)。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 账户页面是服务器渲染的 HTML，而不是 React 打包产物，不改动 Harness UI。
- `sendmail` 传输和 Turnstile 验证尚未在真实服务商上运行过。本地测试使用内存邮箱和固定的测试 CAPTCHA。
- `node:sqlite` 在 Node 22 中仍标记为实验特性，启动时会打印警告。

<a id="dev-note"></a>
## 开发说明

`registration.spec.ts` 在临时 socket 上运行真实服务。当 `PUBLIC_HARNESS_E2E_BROWSER` 指向 Chrome 可执行文件时，`registration.e2e.ts` 用真实 Chrome 完成注册、验证、登录、进入 Harness 和退出登录。
