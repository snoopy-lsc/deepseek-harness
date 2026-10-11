---
description: "用于按用户路由 Harness 的正式签名身份和本机测试用户身份。"
kind: "package-library"
---

# @public-harness/router

[English](README.md) | 中文

## Summary

此包在选择每位用户的 Harness 实例之前，为每个浏览器请求和 WebSocket 升级验证单个用户身份。正式环境会检查本地配置的 RSA 签名密钥、签发者、受众、有效期、UID 一致性和当前账号状态。开发环境只在本机 `team-dev` 配置中接受固定测试用户的签名 Cookie。

## Table of Contents

- [使用此包](#use-this-package)
- [身份来源](#identity-sources)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

为 `createProductionIdentity` 配置可信公钥和账号状态查询，并在每次请求和升级时将 HTTP 请求头交给 `verify`。本机开发时，为 `createDevelopmentIdentity` 配置 `mode: team-dev`、`127.0.0.1` 主机、私有签名密钥和固定测试用户列表；`issue` 方法会为其中一名用户返回 Cookie。

<a id="identity-sources"></a>
## 身份来源

正式环境在受保护的转发认证环节之后读取 `x-authentik-jwt` 和 `x-authentik-uid`。代理必须丢弃客户端提供的值，并用认证成功后的结果替换这两个请求头。签名密钥来自本地配置；请求字段不能选择新的密钥来源。开发 Cookie 不能用于正式环境认证。

<a id="further-exploration"></a>
## 延伸阅读

参阅[共享用户 ID](../contracts/README.zh.md) 和[路由实现计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-router.zh.md)。

<a id="dev-note"></a>
## 开发说明

此包目前提供身份验证。归属路由、Cookie 交换及 HTTP/WebSocket 转发是独立的实现任务。正式环境的 authentik 和 Caddy 配置需要在 Linux 上验证后才能开放公众访问。
