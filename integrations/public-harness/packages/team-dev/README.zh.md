---
description: "仅监听本机的 Harness 多用户开发配置。"
kind: "package-library"
---

# Public Harness 团队开发环境

[English](README.md) | 中文

## Summary

`team-dev` Cordis 插件启动本机路由器，并为每位固定测试用户按需启动一个 Harness Web 进程。本机用户选择页签发带签名的测试 cookie。它提供开发身份和进程分离，不提供 Linux 账号或容器隔离。

## Table of Contents

- [使用配置](#use-the-profile)
- [配置](#configuration)
- [延伸阅读](#further-exploration)

-----

<a id="use-the-profile"></a>
## 使用配置

构建仓库中的 Harness CLI 和 Web 前端后，在集成项目根目录运行 `pnpm dev`。打开输出的 `/dev` 地址并选择测试用户。每位用户的数据保存在配置的 `storageRoot` 下。停止进程会关闭路由器和 Web 子进程。

<a id="configuration"></a>
## 配置

`deploy/team-dev.config.json` 设置固定用户列表，以及正值的启动、停止、路由、启动授权、连接和 cookie 时间限制。插件要求监听 `127.0.0.1`，使用绝对的存储、补丁和可执行文件路径，并提供非空且不重复的用户列表。连接时长最长一分钟，cookie 有效期最长一小时。配置生成器把私有文件写入 `PUBLIC_HARNESS_DEV_HOME` 或 `.local/`，且拒绝覆盖已修改的配置文件。

<a id="further-exploration"></a>
## 延伸阅读

设置方法见[集成说明](../../README.zh.md)，请求归属规则见[路由器说明](../router/README.zh.md)。
