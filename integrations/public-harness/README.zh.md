---
description: "多用户 Harness 服务的独立 Cordis 包。"
kind: "package-library"
---

# Public Harness 集成

[English](README.md) | 中文

## Summary

本项目包含面向公开 Harness 部署、独立版本管理的 Cordis 包。它使用单独的 pnpm 工作区，以便与兼容版本的 Harness 一起安装插件。`team-dev` 配置可在本机运行双用户 Web 服务。公开注册和 Linux 隔离由 [deploy/production](deploy/production/README.zh.md) 下的生产部署提供，在其发布检查允许之前不开放公开注册。

## Table of Contents

- [使用本项目](#use-this-project)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-project"></a>
## 使用本项目

先构建仓库中的 Harness CLI 和 Web 前端，再在此目录运行 `pnpm install` 和 `pnpm dev`。打开输出的本机地址，选择 Alice 或 Bob，即可进入各自独立的 Harness Web 实例。在模型选择器中选择 `Platform` → `Local mock model`，即可使用持久化额度服务。[界面插件](packages/ui/README.zh.md)为每位用户安装相同的品牌。首次启动前可编辑 `deploy/team-dev.config.json` 修改固定测试用户和限额；用 `PUBLIC_HARNESS_DEV_HOME` 指定私有数据目录。生成的配置默认保存在 `.local/`。运行 `pnpm test` 和 `pnpm typecheck` 检查集成。此开发配置没有公开注册。

插件开发依赖与[生产发布清单](deploy/release-manifest.json)面向 Harness `0.2.1-alpha.2`。清单使用独立的候选发布编号，因此开放公开注册需要为该候选版本记录的 Linux 验证结果。

<a id="understand-the-implementation"></a>
## 了解实现

contracts 包负责规范化的不透明用户 ID 和私有实例地址。provisioner 包运行 Linux 运行环境：每用户账号、私有存储和 Git 工作区、带强制限制的 gVisor 容器以及生命周期操作。production 包把它与路由器和额度服务组合成三个配置。macOS 和 Windows 开发运行环境为每位固定测试用户启动一个本机 Web 进程，并通过 Web token bundle 的私有 IPC 发布启动凭据。router 在每次请求时验证签名测试用户 cookie，只转发到该用户的进程。quota 包将个人和全站 token 预留记录保存在 SQLite 中。Web provider 在每次模型操作时读取轮换后的私有凭据；开发服务返回确定性的模拟响应。

<a id="further-exploration"></a>
## 延伸阅读

本机与 Linux 部署规则见[已确认设计](../../docs/superpowers/specs/2026-10-10-public-team-harness-design.zh.md)。

<a id="dev-note"></a>
## 开发说明

平台凭据、用户数据和进程管理应留在此共享源码树之外。
