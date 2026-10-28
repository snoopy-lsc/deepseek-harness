---
description: "团队路由器、配置服务和额度服务的生产 Cordis 配置。"
kind: "package-library"
---

# @public-harness/production

[English](README.md) | 中文

## Summary

此包为三个 Linux 服务 profile 提供 Cordis 插件：`team-router`（无特权，签名身份入口）、`provisioner`（root，主机账号和运行时生命周期）和 `quota`（持有平台密钥）。每个插件接收一个指向 root 所有的 JSON 文件的路径，遇到任何未知、缺失或不安全的设置都会拒绝启动。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

用 `deploy/production-profile.ts` 中的 `writeProductionProfile` 为每个服务生成 dsh 配置（provisioner 配置默认挂载原生 `systemd` 运行时，传入 `runtime: 'podman-gvisor'` 才选择已冻结的容器运行时），再由其 systemd 单元启动 `dsh --profile team-router`、`--profile provisioner` 或 `--profile quota`。原生部署还可以启动 `--profile kb`，即知识库服务（`kb-service.ts`，示例 `deploy/production/config/kb.example.json`）：它以非特权的 `dsh-kb` 账号运行（`deploy/native/systemd/dsh-kb.service`）；用户助手通过按套接字激活的 root 助手启动（`kb-root-helper.ts`、`dsh-kb-root.socket` 和 `dsh-kb-root@.service`，示例 `kb-root.example.json`），由它以各自的原生账号运行 `systemd-run`；组织知识库通过直接助手以服务账号运行；编译通过配额服务的任务 socket 计费（配额配置中的 `jobSocket` 和 `jobSocketGid`：只允许对 `kbjob-` 通道执行 open-job、issue 和 close-job）。`deploy/production/config/` 下的示例文件列出了每个字段。配置文件必须是普通文件，且组和其他用户不可写；密钥只以文件路径引用。

<a id="understand-the-implementation"></a>
## 了解实现

路由器配置从文件读取每个 authentik 公钥，构建签名身份验证器，连接配置服务客户端，并在 Unix socket 上启动路由器，启用 Secure cookie 和唯一的公开地址（即浏览器实际发送的主机：443 不带端口，预发布部署带端口；`:80` 和 `:443` 会被拒绝）。它从不加载开发身份或选择器，也从不绑定 TCP。其私有健康 socket 只报告配置服务是否应答。配置服务配置先挂载显式容器运行时 provider，再挂载依赖该运行时的消费者，拒绝不同的配置后端，在启动时执行 reconcile，提供路由器 socket 和管理 socket，并按固定间隔执行空闲停止和 reconcile。额度配置打开生产额度服务及其私有控制 socket。

<a id="further-exploration"></a>
## 延伸阅读

参阅[路由器](../router/README.zh.md)、[配置服务](../provisioner/README.zh.md)和[额度](../quota/README.zh.md)包，以及[部署指南](../../deploy/production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

测试使用本地生成的签名密钥和伪造的配置服务，在真实 Unix socket 上驱动路由器组合。使用真实 authentik、Caddy 和 Linux 服务的部署需要执行部署指南中的演练。
