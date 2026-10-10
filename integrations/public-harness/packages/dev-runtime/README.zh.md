---
description: "固定开发测试用户的本机 Harness 进程管理器。"
kind: "package-library"
---

# @public-harness/dev-runtime

[English](README.md) | 中文

## Summary

此 provider 为 macOS 和 Windows 开发环境实现 `InstanceManager`。它为每个固定测试身份启动一个真实的 `dsh --profile web` 子进程，并分别配置 Harness 主目录和 Git 工作区。它不在这些子进程之间提供操作系统级隔离。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

向 `createDevInstanceManager` 传入绝对存储根目录、已校验的固定测试用户 ID、已构建的 `dsh` 命令及参数、Web token overlay 路径，以及正数的启动和停止超时。管理器在启动子进程前拒绝除 `127.0.0.1` 外的绑定地址，也拒绝除 `development` 外的模式。调用 `close()` 等待子进程关闭。

<a id="understand-the-implementation"></a>
## 了解实现

每个子进程将 `users/<id>/home` 作为 `DSH_HOME`、`HOME` 和 `USERPROFILE`，将 `users/<id>/workspace` 作为工作目录，将 `users/<id>/agents` 作为 `DSH_AGENTS_HOME`。管理器通过 IPC 接收绑定端口和启动凭据，返回的实例地址不包含凭据。停止进程时保留目录；下次 ensure 会用原数据启动新进程。

<a id="further-exploration"></a>
## 延伸阅读

参阅 [Web token bundle](../web-token/README.zh.md) 和[共享接口](../contracts/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

本机管理器只用于采用固定身份的 loopback 测试站点。公开监听要求使用独立 Linux 运行环境及其隔离检查。
