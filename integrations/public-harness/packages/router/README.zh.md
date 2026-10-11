---
description: "用于按用户路由 Harness 的正式签名身份和本机测试用户身份。"
kind: "package-library"
---

# @public-harness/router

[English](README.md) | 中文

## Summary

此包在选择每位用户的 Harness 实例之前，为每个浏览器请求和 WebSocket 升级验证单个用户身份。正式环境会检查本地配置的 RSA 签名密钥、签发者、受众、有效期、UID 一致性和当前账号状态。开发环境只在本机 `team-dev` 配置中接受固定测试用户的签名 Cookie。归属路由只接受经过认证的用户自己的 `/u/<id>/` 前缀。

## Table of Contents

- [使用此包](#use-this-package)
- [身份来源](#identity-sources)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

为 `createProductionIdentity` 配置可信公钥和账号状态查询，并在每次请求和升级时将 HTTP 请求头交给 `verify`。本机开发时，为 `createDevelopmentIdentity` 配置 `mode: team-dev`、`127.0.0.1` 主机、私有签名密钥和固定测试用户列表；`issue` 方法会为其中一名用户返回 Cookie。将经过验证的 ID 和原始请求路径传给 `createOwnerRouter().route`；它会检查账号状态和容量、合并同一用户的并发启动请求，并在实例尚未就绪时返回限时等待状态。`createBrowserLaunch().open` 在内部向对应实例交换 Harness 启动令牌，检查预期的重定向和签名 Cookie，并将 Cookie 限定在 `/u/<id>/` 路径下。

<a id="identity-sources"></a>
## 身份来源

正式环境在受保护的转发认证环节之后读取 `x-authentik-jwt` 和 `x-authentik-uid`。代理必须丢弃客户端提供的值，并用认证成功后的结果替换这两个请求头。签名密钥来自本地配置；请求字段不能选择新的密钥来源。开发 Cookie 不能用于正式环境认证。

<a id="further-exploration"></a>
## 延伸阅读

参阅[共享用户 ID](../contracts/README.zh.md) 和[路由实现计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-router.zh.md)。

<a id="dev-note"></a>
## 开发说明

本机 `startRouterServer` 对 HTTP 请求和 WebSocket 升级执行身份与归属检查，将请求以流方式转发到对应实例，并在配置的时限内关闭已升级的连接。设置正值的 `retryAfterSeconds`，即可配置品牌等待页的刷新间隔和 HTTP `Retry-After` 标头。交换时保留浏览器请求的 Host，因为 Harness 会将 Cookie 签名绑定到该地址。正式环境入口改为监听权限受限的 Unix socket（`listen`），要求 `secureCookies` 和唯一确定的 `publicAuthority`，拒绝其他 Host 值，且不能与开发选择器同时运行。超过 `maxRequestBodyBytes`（默认 32 MiB）的请求在到达实例前收到 HTTP 413；路由器在转发前移除客户端提供的转发和身份标头以及自己的 cookie。`createAdmission` 预先检查全站活动实例上限，`startRouterHealthServer` 在私有 socket 上报告不含身份的汇总健康状态。[production 包](../production/README.zh.md)将这些接入 `team-router` 配置。`deploy/` 下的 authentik 和 Caddy 配置需要在 Linux 上验证后才能开放公众访问。
