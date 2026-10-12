---
kind: upgrade-guide
description: "公共 Harness 配置服务的配置与生命周期记录要求显式运行时选择。"
---

# 显式选择公共 Harness 运行时

[English](guide.md) | 中文

## 变更

公共 Harness 操作员必须选择 `provisioner.runtime.kind`。容器可执行文件、`runtimeAssets`、`image`、`imageArchive`、额度 `hostAddress`、`limits.network` 和 `ports.sidecar` 移入 `podman-gvisor` 运行时标签。通用账号工具、存储路径、数值资源限制、额度端口和生命周期配置保留为通用设置。[配置示例](../../../../integrations/public-harness/deploy/production/config/provisioner.example.json) 给出完整替代配置。`systemd` 选择要求通过绝对 `runtime.configFile` 指定原生配套选项，并单独挂载匹配的 provider；选择本身不安装 provider。

配置服务写入 v2 生命周期记录，包含显式后端所有权、已获得资源以及完整或部分启动分配。它将 v1 记录读为容器状态，读取时不重写源文件。不支持或损坏的记录会被拒绝。Harness Session 格式和 `InstanceManager` 不变。`createProvisionerService` 和 `createUserProvisioner` 要求注入运行时；`InstanceRuntime` 包含用于持久化预留和部分清理的 `allocate` 与 `releaseAllocation`。

## 迁移

1. 停止配置服务和所有用户容器，验证转发和额度授权已撤销，并在启动新写入方之前备份生命周期记录和用户存储。保留备份用于回退；v1 写入方不能读取 v2 记录。
2. 根据带标签的配置示例更新 root 拥有的 `provisioner.json`。通过 `writeProductionProfile` 生成 `provisioner` profile，使其补丁在 `provisioner-service` 前挂载 `container-runtime`。先归档旧的生成 profile：生成器拒绝已编辑或不同的文件。
3. 启动 profile 并检查管理对账报告。从备份恢复无效文件；通过已验证的 provider 清理解决隔离分配，然后重试。确认已有用户在唤醒后保留容器运行时引用、私有工作区和 Session 数据。
4. 转移后端时保持准入关闭，备份数据，停止所有后代进程和连接，撤销授权，并在允许用户进入前验证目标 provider 下的恢复。修改 `runtime.kind` 不能转移已有记录；本次变更不提供在线转移操作。

5. 原生部署操作员必须提供 `parseSystemdConfig` 接受的 root 所有配套选项，将控制文件保存在 `stateDir/runtime/<account>`，并将用户令牌/就绪文件放在私有 home。在注册原生 provider 前校验不可变资源。[原生验证要求](../../../../integrations/public-harness/packages/runtime-systemd/README.zh.md#known-limitations-and-deferred-work)通过前保持准入关闭；仅解析配置不启用原生部署。
