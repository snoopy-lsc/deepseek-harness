---
description: "使用轮换私有额度凭据的 Cordis DeepSeek provider。"
kind: "package-bundle"
---

# @public-harness/quota-provider

[English](README.md) | 中文

## Summary

此 Web profile bundle 通过公开的 `registerDeepSeekProvider` API 注册平台承担费用的 DeepSeek 模型路由。它在每次模型操作时从私有文件读取短期凭据，并且只将该凭据发送到配置的额度代理地址。

## Table of Contents

- [使用此 bundle](#use-this-bundle)
- [了解凭据轮换](#understand-credential-rotation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-bundle"></a>
## 使用此 bundle

将此包安装到每位用户的 Web profile，并配置 `proxyBaseUrl`、绝对路径 `credentialFile`、`modelId`、`modelName`、`contextWindow` 和 `maxTokens`。所有用户的 profile 应使用同一已测试的 bundle 版本。管理进程须在到期前写入并轮换凭据文件；文件缺失、权限过宽、内容无效或已过期时，模型请求会停止。

<a id="understand-credential-rotation"></a>
## 了解凭据轮换

适配器在每次模型操作（包括 Files 操作）时单独解析身份验证。它会重新读取文件，不把 token 长期保存在进程配置中。文件只包含 `token` 和以 Unix 毫秒表示的 `expiresAt` 字段，并且必须只有对应的用户运行环境可以读取。

<a id="further-exploration"></a>
## 延伸阅读

参阅[额度账本](../quota/README.zh.md)和[额度实现计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.zh.md)。

<a id="dev-note"></a>
## 开发说明

此 bundle 本身不执行 token 额度限制。额度代理验证每个请求、预留容量，并把平台模型密钥留在用户运行环境之外。开发 profile 使用独立凭据，以及模拟上游或开发者自己的密钥。
