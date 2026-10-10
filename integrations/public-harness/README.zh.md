---
description: "多用户 Harness 服务的独立 Cordis 包。"
kind: "package-library"
---

# Public Harness 集成

[English](README.md) | 中文

## Summary

本项目包含面向公开 Harness 部署、独立版本管理的 Cordis 包。它使用单独的 pnpm 工作区，以便与兼容版本的 Harness 一起安装插件。它包含共享实例接口、私有 Linux 配置服务协议、本机开发运行环境和模型额度账本；尚未启动公开的多用户服务器。

## Table of Contents

- [使用本项目](#use-this-project)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-project"></a>
## 使用本项目

在此目录运行 `pnpm install`、`pnpm test` 和 `pnpm typecheck`。`pnpm run build` 生成普通 JavaScript 包。本机运行环境要求先构建 Harness CLI 和 Web 前端；集成尚无公开入口。

<a id="understand-the-implementation"></a>
## 了解实现

contracts 包负责规范化的不透明用户 ID 和私有实例地址。provisioner 包定义后续 Linux 运行环境所用的固定 Unix socket 操作。macOS 和 Windows 开发运行环境为每位固定测试用户启动一个本机 Web 进程，并通过 Web token bundle 的私有 IPC 发布启动凭据。quota 包将个人和全站 token 预留记录保存在 SQLite 中。

<a id="further-exploration"></a>
## 延伸阅读

本机与 Linux 部署规则见[已确认设计](../../docs/superpowers/specs/2026-10-10-public-team-harness-design.zh.md)。

<a id="dev-note"></a>
## 开发说明

平台凭据、用户数据和进程管理应留在此共享源码树之外。
