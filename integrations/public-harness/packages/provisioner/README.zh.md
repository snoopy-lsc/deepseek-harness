---
description: "为每位用户创建主机账号、私有存储和 gVisor Harness 容器的 Linux 配置服务。"
kind: "package-library"
---

# @public-harness/provisioner

[English](README.md) | 中文

## Summary

此包是权限范围很窄的 Linux 配置服务。它通过固定的 Unix socket 协议与路由器通信，为每个不透明用户 ID 创建一个主机账号和私有存储目录树，并在 gVisor 下的无根 Podman 容器中运行该用户的 Harness，且必须设置资源限制。它还负责暂停、空闲停止、需确认的删除，以及主机重启后的恢复。所有主机命令都经由注入的执行器，因此此包的测试无需 root。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`createProvisionerService` 接收已校验的 `ProvisionerConfig`、额度控制客户端和 cgroup 探测函数，返回路由器处理函数和生命周期操作。`startProvisionerServer` 在允许指定用户组连接的 socket 上提供处理函数；处理函数只接收带已校验用户 ID 的 `ensure`、`launch-grant`、`stop` 或 `status`，`ProvisionerClient` 提供对应方法。`startAdminServer` 在另一个仅 root 可访问的 socket 上为 `AdminClient` 提供 `suspend`、`reactivate`、`request-deletion`、`confirm-deletion`、`delete`、`reconcile`、`idle-stop` 和 `status`。路由器拒绝类型 `CapacityError` 与 `AccountSuspendedError` 以固定词语穿过 socket，其他任何失败都变为 `invalid request`。

<a id="understand-the-implementation"></a>
## 了解实现

账号名和路径名由用户 ID 的哈希派生，从不使用显示名。配置在每用户锁下幂等，并能在中断后继续：账号、所有权和权限精确的私有存储、Git 工作区，以及持久状态记录。活动实例数已达上限时，新用户会在任何主机变更之前被拒绝。启动要求 gVisor、所有 cgroup 控制器、出站防火墙表、磁盘配额和额度代理都可用，否则拒绝；`assertSafeRunArgv` 会拒绝固定集合之外的任何 `podman` 参数。容器的就绪令牌经私有文件传递，主机侧转发器把每个实例一个受限的 Unix socket 桥接到容器发布的本机端口。`reconcile` 在重启后恢复或停止实例、清理过期 socket，且仅在删除已被请求、确认并过了恢复期后才清除账号。

<a id="further-exploration"></a>
## 延伸阅读

用户 ID 和地址校验见 [contracts](../contracts/README.zh.md)，root 的 `provisioner` 配置见 [production 包](../production/README.zh.md)，主机部署见[部署指南](../../deploy/production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

单元测试使用伪造的命令执行器和伪造的目录；账号、配额、cgroup、Podman 和 gVisor 只能在真实 Linux 主机上验证。socket 协议只是一道检查，而非完整授权策略：部署还必须限制 socket 目录，并在服务端派生所有主机路径。
