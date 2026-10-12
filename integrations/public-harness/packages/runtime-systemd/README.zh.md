---
description: "为原生 Harness 进程准备私有 Linux 账号、具有配额的存储和 systemd/AppArmor 策略。"
kind: "package-library"
---

# @public-harness/runtime-systemd

[English](README.md) | 中文

## Summary

为原生 Harness 部署准备锁定的 Linux 账号、私有数据目录、磁盘硬限制和每个账号的 systemd/AppArmor 文件。生成的服务通过具名 `dsh` profile 启动 Node，并在后代进程中保留账号和 cgroup 限制。这些准备函数不启动工作负载，也不提供强制执行证据。公共准入要求另行实现 provider 生命周期并完成专用 Linux 验证。

## Table of Contents

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`parseSystemdConfig({ common, native })` 将已校验的通用配置服务设置与严格的原生选项组合。通用 `runtime` 标签要求 `kind: systemd` 和指向原生配套 JSON 的绝对 `configFile` 路径。位于 `/home`、`/root`、`/run/user`、`/run/systemd` 或 `/run/dbus` 下的存储、发布和工具链路径会被拒绝，因为生成的单元会隐藏这些目录树。通用设置统一决定数据/状态/socket/配额路径、账号工具、CPU/内存/PID/文件描述符/字节限制、额度端口与就绪/停止超时。原生选项提供不可变发布/工具链资源、Node 和主机强制执行工具、具名 profile 及启动补丁、inode/共享内存限制、Web 端口、解析器/公共出站规则与操作超时。未知字段、重叠范围或路径、不安全路径语法和无效限制会在产生副作用前被拒绝。精确字段见[解析器](src/config.ts)。

在注册运行时服务前调用 `validateNativeAssets`，避免依赖的配置流程调用未经校验的主机程序。发布和工具链目录树及其祖先必须由 root 拥有，且组和其他用户无写权限。不可变链接只能解析到声明的不可变根目录中；悬空、循环、逃逸或可写目标均拒绝。操作系统命令链接只能解析到受信任的系统工具根目录下。root 写入的数据/控制路径使用不跟随链接的目录描述符，遇到链接直接拒绝。

`ensureNativeAccount` 使用锁定密码、nologin shell 和私有主用户组，不启用用户管理器 linger。已有原生账号必须保留密码锁定，且没有补充用户组。`prepareHost` 校验资源、应用 XFS 字节/inode 硬限制、准备存储并写入生成的 unit/策略文本。它不加载 AppArmor，也不启动系统 unit。调用方必须在任何用户代码执行前完成网络策略和实际强制执行检查，包括工作区初始化。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

通用配置服务在准备前预留并持久化分配。只有 provider 准备成功后才记录原生存储完成。root 拥有 `storageRoot/users` 和每个账号的顶层父目录；四个用户拥有的子目录是 `home`、`workspace`、`cache` 和 `tmp`。仅 root 可访问的控制目录为 `stateDir/runtime/<account>`。用户令牌和就绪文件属于私有 home，与控制文件分离。目录所有权变更作用于已打开的顶层句柄，不递归遍历用户数据。每个磁盘可写目录必须位于配置的配额文件系统；私有共享内存受大小/inode 限制，并计入服务内存 cgroup。

导出的准备阶段 `validateNativeAssets`、`applyDiskLimits`、`prepareNativeStorage` 和 `writeControlFile` 允许生命周期 provider 在副作用之间记录各项已获得资源。拒绝的操作可能留下部分目录、配额设置或文件；应保留分配、拒绝路由，并在重试前对账。写入中断后保留独占暂存文件。`NativeHostError` 提供稳定失败代码和失败操作，同时保留原因。确认删除数据还要求已验证 UID/cgroup 完全停止，并满足通用恢复期。

生成的 unit 使用空能力集、禁止新增特权、只读系统、受保护的其他用户进程、不委派 cgroup 和整个 cgroup 终止。AppArmor 为开发工具和私有程序授予继承执行权限，允许同一 profile 内发送信号/检查进程、读取选定系统文件及写入私有数据。它不授予不受限 profile 转换或管理 socket 访问权限。unit 保留 JIT 执行和用户命名空间，profile 授予 PTY 访问。编译器和浏览器兼容性要求真实 Linux 测试。网络目的地和公共入站由 unit 渲染器之外的机制强制执行。

</details>

<a id="further-exploration"></a>
## 延伸阅读

参阅[配置服务所有权](../provisioner/README.zh.md)、[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[Ubuntu systemd 执行控制](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html)、[AppArmor profile 语法](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)与 [XFS 配额](https://manpages.ubuntu.com/manpages/noble/man8/xfs_quota.8.html)。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 准备和策略文本测试不能证明已加载 AppArmor 强制模式、cgroup 行为、有效 XFS 配额或网络隔离。准入前必须完成原生服务生命周期、策略安装和实际探测。
- 基于描述符的写入要求 Linux `/proc/self/fd`。macOS 测试覆盖策略、账号命令和真实文件拒绝路径；Linux 描述符替换测试在该平台明确跳过。
- 在专用 Ubuntu 24.04 主机通过多用户恶意代码测试、资源耗尽、Node/编译器/PTY/无头浏览器兼容性、重启恢复和安全审查前，公共工作负载保持禁用。原生实例共享宿主机内核。

- 锁定密码和 nologin shell 还需要 SSH 入站策略：部署必须在 sshd 拒绝受管理账号名称，或验证没有 SSH 服务，并覆盖公钥认证与转发尝试。出站 Git SSH 属于独立的出站选择。

- 浏览器验收尚未通过：Chromium 需要写入自身命名空间的 UID/GID 映射，并执行本 AppArmor profile 尚未授予的额外命名空间能力操作。必须经过审查并在 Linux 上调整策略；禁用浏览器沙箱或切换到不受限 profile 均不是可接受的回退方案。

<a id="dev-note"></a>
## 开发说明

本地测试不执行特权账号、unit、配额或防火墙变更。
