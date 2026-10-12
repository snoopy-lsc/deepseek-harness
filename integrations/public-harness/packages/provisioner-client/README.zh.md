---
description: "从特权配置服务 socket 到 InstanceManager 的路由器侧适配器。"
kind: "package-library"
---

# @public-harness/provisioner-client

[English](README.md) | 中文

## Summary

此包调用配置服务的固定 socket 操作，为路由器提供生产环境使用的 `InstanceManager`。它还提供归属路由和签名身份验证共用的账号状态查询。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用此包

`connectProvisioner(path, options)` 返回 `InstanceManager`、`isActive` 查询和底层的 `ProvisionerClient`。`ensure` 最多等待 `options.ensureTimeoutMs`（默认 `DEFAULT_ENSURE_TIMEOUT_MS`，即 20 分钟），因为冷启动可能先要把镜像归档加载到该账号的存储中；`launchGrant`、`stop` 和 `status` 仍使用 10 秒请求上限。路由器在 `routeWaitMs` 之后仍向浏览器返回启动中页面，并把同一用户的后续请求合并到进行中的启动；若 `ensure` 失败或超时，该请求得到 503，下一个请求会重新询问，配置服务在该用户的锁下把它挂到仍在进行的启动上，因此重试不会启动第二个实例。`createLinuxInstanceManager` 与 `createAccountStatusLookup` 接受任何带有对应方法的对象，因此测试中可以替换为伪造对象。

<a id="understand-the-implementation"></a>
## 了解实现

账号仅在状态为 `suspended` 或 `pending-deletion` 时才被视为不活动；配置服务从未见过的用户视为活动，因为其首次请求会为其创建实例。配置服务不可达会使每次调用失败，因此身份验证和路由都是失败即关闭。容量和暂停的类型化拒绝原样到达路由器。

<a id="further-exploration"></a>
## 延伸阅读

协议见[配置服务](../provisioner/README.zh.md)，拒绝如何变为页面见[路由器](../router/README.zh.md)。
