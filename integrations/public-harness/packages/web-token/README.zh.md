---
description: "受管理 Harness 进程的私有 Web 启动令牌发布器。"
kind: "package-bundle"
---

# @public-harness/web-token

[English](README.md) | 中文

## Summary

此 Cordis bundle 关闭 Web profile 的启动 URL 输出，并通过 Node IPC 将启动凭据和绑定的本机端口发送给开发环境的管理进程。它要求管理进程提供 IPC 通道；没有通道时启动会失败。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

从集成工作区运行 `pnpm --filter @public-harness/web-token build` 构建此包，然后将 bundle 安装到受管理的 Web profile。Bundle patch 设置 `printUrl: false` 和 `openBrowser: false`；管理进程必须提供 IPC 通道，并以 `--no-open` 启动 Web。

<a id="understand-the-implementation"></a>
## 了解实现

Loader 完成启动后，插件从 Harness Connection 获取已认证的本机 URL，提取其中唯一的令牌，并通过 `process.send` 发送 `{ kind, port, token }`。它通过启动器的 `appExit` 服务处理管理进程发送的 `public-harness/stop` 消息。此包返回给浏览器的 URL 不包含令牌。

<a id="further-exploration"></a>
## 延伸阅读

子进程生命周期和存储归属见[开发运行环境](../dev-runtime/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

Bundle patch 会替换 Web runtime 的完整配置；上游 Web bundle 接口变化时应检查此配置项。
