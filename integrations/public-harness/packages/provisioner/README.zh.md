---
description: "为每位用户创建主机账号、私有存储和 gVisor Harness 容器的 Linux 配置服务。"
kind: "package-library"
---

# @public-harness/provisioner

[English](README.md) | 中文

## Summary

本包创建私有 Linux 账号和存储，在配置的容量内允许启动，并管理暂停、空闲停止、确认删除和重启恢复。显式挂载的运行时 provider 启动每个用户的 Harness。容器 provider 使用无根 Podman 和 gVisor；主机操作可注入，以便无特权测试。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`createProvisionerService` 接收已校验的 `ProvisionerConfig` 和注入的 `InstanceRuntime`，返回路由器处理函数和生命周期操作。缺少 provider，或配置与持久化后端不匹配时，在主机变更之前拒绝。Cordis 入口 `@public-harness/provisioner/runtime-provider` 注册一个具有可释放所有权的容器运行时；重复 provider 会被拒绝。 `startProvisionerServer` 在允许指定用户组连接的 socket 上提供处理函数；处理函数只接收带已校验用户 ID 的 `ensure`、`launch-grant`、`stop` 或 `status`，`ProvisionerClient` 提供对应方法。`startAdminServer` 在另一个仅 root 可访问的 socket 上为 `AdminClient` 提供 `suspend`、`reactivate`、`request-deletion`、`confirm-deletion`、`delete`、`reconcile`、`idle-stop` 和 `status`。路由器拒绝类型 `CapacityError` 与 `AccountSuspendedError` 以固定词语穿过 socket，其他任何失败都变为 `invalid request`。

<a id="understand-the-implementation"></a>
## 了解实现

账号和运行时名称由用户 ID 的哈希派生。通用配置包含账号工具、存储路径、数值资源限制、额度端口和生命周期时间。`runtime.kind` 选择后端；仅容器使用的可执行文件、资源、镜像配置、网络模式、额度主机地址和 sidecar 端口归于 `podman-gvisor` 标签。容器启动验证 gVisor、已委派的 cgroup 控制器、出站防火墙表、磁盘配额、额度服务健康状况和镜像。私有就绪文件携带 Web 凭据，受限 Unix 转发器访问发布的 sidecar 端口。生命周期操作查询 provider，停止空闲或暂停的实例，并要求删除已确认且经过恢复期。

记录以版本 2 写入，包含运行时引用、启动 ID、已分配端口和已获得资源。保留的 v1 解码器将旧记录解释为容器状态，读取时不重写文件。损坏或不支持的记录保持原样。中断的分配和清理失败会进入隔离状态，撤销路由并占用容量；只有 provider 清理成功后，对账才允许复用。后端转移需要操作员离线备份、完全停止和验证恢复；只修改 `runtime.kind` 会拒绝已有记录。

<a id="further-exploration"></a>
## 延伸阅读

用户 ID 和地址校验见 [contracts](../contracts/README.zh.md)，root 的 `provisioner` 配置见 [production 包](../production/README.zh.md)，主机部署见[部署指南](../../deploy/production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

单元测试使用伪造的命令执行器和伪造的目录；账号、配额、cgroup、Podman 和 gVisor 只能在真实 Linux 主机上验证。socket 协议只是一道检查，而非完整授权策略：部署还必须限制 socket 目录，并在服务端派生所有主机路径。
