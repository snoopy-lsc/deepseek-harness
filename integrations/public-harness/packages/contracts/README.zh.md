---
description: "已校验的用户 ID 和私有 Harness 实例地址。"
kind: "package-library"
---

# @public-harness/contracts

[English](README.md) | 中文

## Summary

本库校验用户与启动标识、派生运行时名称和私有实例端点。路由器使用 `InstanceManager`；Linux 配置服务使用显式选择的 `InstanceRuntime` provider。

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

`InstanceRuntime.allocate` 为服务器分配的同一个启动 ID 预留真实的 Web 和额度端口。`prepare` 在 `initializeWorkspace` 执行用户代码之前建立强制保护；`start` 在就绪后返回端点。`releaseAllocation` 清理未完成的分配，`stop` 清理完整实例。资源可能残留时清理会拒绝，`state` 区分未知结果与已停止进程。配置服务保留部分分配证据，直到清理得到验证。`InstanceManager` 的路由器操作保持不变；本库不执行 I/O。

<a id="further-exploration"></a>
## 延伸阅读

参阅[集成总览](../../README.zh.md)。

<a id="dev-note"></a>
## 开发说明

在进程或线路入口校验；已类型化的同进程调用方无需再次解析。
