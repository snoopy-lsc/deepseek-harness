---
description: "已校验的用户 ID 和私有 Harness 实例地址。"
kind: "package-library"
---

# @public-harness/contracts

[English](README.md) | 中文

## Summary

本库定义团队路由使用、由开发和 Linux provider 实现的 `InstanceManager` 服务。它校验跨进程或线路传入的用户 ID 和实例地址。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

外部身份作为 `InstanceManager` 键使用前须调用 `parseUserId`。仅接受 1–128 位 ASCII 字母、数字、`_` 和 `-`。`parseInstanceEndpoint` 接受绝对 Unix socket 路径，或具有有效端口且位于 `127.0.0.1` 的 TCP 地址；未知字段会被拒绝。

<a id="understand-the-implementation"></a>
## 了解实现

`ensure` 返回私有地址，`launchGrant` 返回当前 Web 启动凭据（并非一次性：在实例重启之前它一直有效，重复调用返回同一值，且只有路由器会接触到它），`stop` 结束进程但保留用户数据。provider 负责生命周期和存储；本库不执行 I/O。

<a id="further-exploration"></a>
## 延伸阅读

参阅[集成总览](../../README.zh.md)。

<a id="dev-note"></a>
## 开发说明

在进程或线路入口校验；已类型化的同进程调用方无需再次解析。
