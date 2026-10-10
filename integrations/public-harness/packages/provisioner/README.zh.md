---
description: "Linux Harness 配置服务的固定私有控制协议。"
kind: "package-library"
---

# @public-harness/provisioner

[English](README.md) | 中文

## Summary

此包为独立特权的 Linux 配置服务提供有大小上限的 Unix socket 请求协议。它不创建账号，也不启动容器。开发运行环境不使用此协议。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`startProvisionerServer` 要求 socket 所在目录仅所有者可访问，并将 socket 权限设为 `0600`。处理器只接收含已校验用户 ID 的 `ensure`、`launch-grant`、`stop` 或 `status` 操作。`ProvisionerClient` 提供对应方法。

<a id="understand-the-implementation"></a>
## 了解实现

每个连接发送一条以换行分隔的 JSON 请求及一条响应，大小上限为 64 KiB。未知字段和操作标签在处理器运行前被拒绝。超过上限的响应不会交付。服务器的 `close` 方法等待监听停止并移除 socket。

<a id="further-exploration"></a>
## 延伸阅读

用户 ID 和地址校验见 [contracts](../contracts/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

Socket 协议只是配置服务的一项检查，不能替代完整授权策略。部署时还需限制对 socket 目录的文件访问，并由服务器自行派生全部主机路径。
