---
description: "Team Harness 的 Linux 生产部署、升级、备份和公开注册发布指南。"
kind: "package-library"
---

# 生产部署

[English](README.md) | 中文

## Summary

此目录包含 Team Harness 的 Linux 部署：带 authentik 转发认证的 Caddy 入口、作为 systemd 单元的路由器、配置服务和额度服务、出站防火墙、实例镜像、备份脚本以及发布检查。在发布检查允许之前，公开注册保持关闭。

## Table of Contents

- [在 Linux 主机上安装](#install-on-a-linux-host)
- [网络边界](#network-boundaries)
- [资源限制](#resource-limits)
- [进程可见性](#process-visibility)
- [升级与回滚](#upgrade-and-roll-back)
- [备份与恢复](#back-up-and-restore)
- [发布检查](#release-check)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="install-on-a-linux-host"></a>
## 在 Linux 主机上安装

使用专用主机，需具备 systemd、用户管理器已委派 `cpu`、`cpuset`、`hugetlb`、`io`、`memory` 和 `pids` 的 cgroup v2（实验室中无根 Podman 配合 `runsc` 缺少其中任何一个都无法启动，因此缺少时配置服务拒绝启动实例）、无根 Podman、gVisor `runsc`、nftables、Caddy 2.7 或更新版本，以及为 `quotaMount` 启用用户配额的文件系统。Caddyfile 使用 `servers { trusted_proxies }`，Debian 打包的 Caddy 2.6.2 无法解析；已用 Caddy 2.11.7 验证，请安装当前的官方构建。把构建好的集成项目和 Harness 安装到 `/opt/dsh-public`，再复制下列文件。

```bash
install -m 0644 deploy/production/systemd/sysusers.conf /etc/sysusers.d/dsh-public.conf
install -m 0644 deploy/production/systemd/tmpfiles.conf /etc/tmpfiles.d/dsh-public.conf
install -m 0644 deploy/production/systemd/*.service deploy/production/systemd/*.target /etc/systemd/system/
install -D -m 0644 deploy/production/caddy-dropin/dsh-public.conf /etc/systemd/system/caddy.service.d/dsh-public.conf
install -m 0644 deploy/production/Caddyfile /etc/caddy/Caddyfile
install -m 0644 deploy/production/nftables/dsh-public.nft /etc/nftables.d/dsh-public.nft
systemd-sysusers && systemd-tmpfiles --create && nft -f /etc/nftables.d/dsh-public.nft
```

把每个 `deploy/production/config/*.example.json` 去掉 `.example` 后复制到 `/etc/dsh-public/`，属主为 root 且其他用户不可写，并替换所有占位符：两个组 ID、authentik audience 和密钥文件、模型上游、实例镜像以及主机名。把平台模型密钥、令牌密钥和健康密钥作为属主为 `dsh-quota` 的 `0600` 文件放入 `/etc/dsh-public/secrets/`。将 `deploy/authentik/brand.yml` 和 `deploy/authentik/public-harness.yaml` 作为 authentik 蓝图导入，CAPTCHA 密钥放在 authentik 的环境变量中。用 `scripts/build-image.sh` 和 `scripts/build-assets.sh` 构建镜像和运行时资源发布版，把 `/opt/dsh-public/assets/current` 指向该发布版，用 `deploy/production-profile.ts` 生成三个配置，再启动 `dsh-public.target`。在出站表、限制和 gVisor 验证通过之前，配置服务拒绝启动任何实例。

`scripts/build-image.sh` 还会导出 `imageArchive` 指定的镜像归档（默认 `/opt/dsh-public/image/dsh-instance.tar`，所有账号可读）。配置服务不共享镜像存储：每个账号有自己的无根存储，因此账号首次启动时会以该账号身份执行 `podman load` 加载归档（未配置归档时则 `podman pull` `image`），一次只处理一个账号；之后若配置的镜像引用仍不存在，则拒绝启动。容器以 `--userns keep-id:uid=10001,gid=10001` 启动，因此镜像用户（uid 10001）写入的内容归主机账号所有；请保持 Containerfile 中的用户与该映射一致。首次启动会较慢，且每个账号保存一份镜像并计入该账号的磁盘配额，因此 `diskBytes` 要按镜像加用户数据来估算。

<a id="network-boundaries"></a>
## 网络边界

实例只能通过 pasta 的主机回环映射访问主机，防火墙只允许一段回环端口：`dsh-public.nft` 中的 `QUOTA_PORTS`。它必须与 `quota.json` 的 `listenPorts` 和 `provisioner.json` 的 `ports.quota` 相等，测试会比较三份示例。配置服务从另一段 `ports.sidecar` 为每个实例发布 sidecar，只有主机侧转发器使用它，防火墙不放行，因此实例无法连接其他实例的 sidecar，也无法连接任何其他回环服务（路由器健康 socket、Caddy、authentik、数据库）。端口段必须很窄（至多 4096 个端口）、位于 1024-32767 以避开内核的临时端口范围、互不重叠、至少容纳 `maxActiveInstances` 个端口，并且不得与其他服务使用的端口冲突。放行范围内其他用户的额度监听地址仍可连通，所以每个监听地址只接受绑定到自己实例的凭据；这一决定让防火墙不必按用户建规则。其他服务仍应尽量绑定到 Unix socket。

Caddy 的管理 API 只监听 `unix//run/caddy/admin.sock`（权限 0600），从不监听 TCP，因此用 `caddy reload --address unix//run/caddy/admin.sock` 重新加载。请把每个 DNS 解析器都列入 `RESOLVERS`：解析器规则排在私有网段丢弃规则之前，所以位于 10/8、172.16/12 或 192.168/16 的解析器也能工作。配置服务自己构造 pasta 参数，带有 `--map-host-loopback` 和 `--no-splice`（缺少 `--no-splice` 时，gVisor 下已发布端口会返回连接重置），因此配置里只需写 `pasta`。

把路由器的 `publicAuthority` 设为浏览器实际发送的主机，写法要完全一致。Caddy 转发 `Host` 时保留端口，所以标准的 443 部署使用不带端口的主机名（路由器拒绝 `:443` 和 `:80`，因为浏览器从不发送它们）；在其他端口上的预发布部署，例如 `staging.example.com:8443`，必须写上该端口，否则每个请求都会返回 421。

<a id="resource-limits"></a>
## 资源限制

在 gVisor 下，耗尽 pids 限制在两次实验室运行中都杀掉了整个沙箱而不是单个进程；超出内存限制在第一次运行中杀掉了整个沙箱，在第二次运行中（四次尝试）却只杀掉一个进程，所以结果取决于内核、gVisor 构建和 cgroup 配置：请按可能丢失整个沙箱来规划，但不要依赖这一点。pids 限制统计的是沙箱的主机线程（空闲时约 45 个，每个来宾进程再加两三个），而不是来宾进程；实验室中限制为 128 时只允许约 35 个来宾进程。因此配置服务拒绝少于 256 个 pids 或不足 512 MiB 的设置，示例使用 2048 个 pids 和 4 GiB。被杀掉的实例（演练时可耗尽 pids 或杀掉 `runsc-sandbox`，因为耗尽内存并不总会杀掉沙箱）会由 `status`（每个用户至多每五秒检查一次）和 `reconcile` 报告为 `stopped`，其 socket 和额度监听地址随之释放，下一次请求会再次启动；未保存的内存中工作会丢失，主目录和工作区文件保留。停止有时限：先在 `stopTimeoutMs` 内执行 `podman rm`，再发送 SIGKILL 并强制删除；若容器仍然存在，停止会失败，由 `reconcile` 重试。

<a id="process-visibility"></a>
## 进程可见性

没有 `hidepid` 时，任何账号都能用 `ps` 读取其他账号的进程命令行，从而暴露其他用户 Podman 和 gVisor 进程的容器 ID 和存储路径。`scripts/enable-hidepid.sh`（以 root 运行，在 `systemd-sysusers` 之后）通过 `/etc/fstab` 和即时重新挂载，以 `hidepid=2,gid=<dsh-procview>` 挂载 `/proc`，使账号只能看到自己的进程。除 root 外，唯一的豁免对象是 `sysusers.conf` 创建的 `dsh-procview` 组：`logind-dropin/dsh-public.conf` 把它加给 `systemd-logind`，会话因此保持正常，你也可以把监控账号加入该组。切勿加入实例账号、路由器或额度服务。首次运行会把原始 `/etc/fstab` 保存为 `/etc/fstab.dsh-backup`，之后的运行从不覆盖该备份。`scripts/verify-hidepid.sh [account ...]` 检查挂载选项，并对每个实例账号检查：以该账号运行的 `ps` 看不到其他用户的进程，且该账号不在豁免组中。该账号自己的无根沙箱进程运行在它的 subuid 范围内，不算外来进程（脚本读取该账号在 `/etc/subuid` 中的条目），而其他账号的范围和 uid 仍然算外来，因此正在运行实例的账号也可以通过验证；失败时以 `FAIL` 行和退出码 1 关闭，其结果即 `process-visibility` 发布证据。这只隐藏命令行和 `/proc` 条目，并不能阻止账号猜测路径或端口。

<a id="upgrade-and-roll-back"></a>
## 升级与回滚

`deploy/release-manifest.json` 固定一个发布版：Harness 版本、插件接口版本、每个 bundle 以及实例镜像。接触任何用户之前，先对已安装候选版本的非生产配置运行 `preflightUpgrade`；它检查接口和 bundle 固定版本、Session 迁移，以及登录、模型调用、终端、Session 和插件加载流程，并在第一个接口不匹配时停止。随后 `rolloutUpgrade` 把 `assets/current` 链接切换到新发布目录，先重启一个金丝雀用户，再分批进行。它记录进度，使中断的发布可以继续；第一个实例失败时，它恢复先前的发布链接并停止。回滚只改变代码：从不移动或删除 `DSH_HOME`、Session 或 Git 工作区。更换实例镜像需要在修改配置后重启配置服务。

<a id="back-up-and-restore"></a>
## 备份与恢复

以 root 运行 `scripts/backup.sh`。它对额度账本做在线 SQLite 备份，再归档配置服务状态、保留属主的每位用户存储以及非密钥配置，并记录校验和。密钥文件应通过运维人员的密钥管理器单独备份。恢复时，先停止 `dsh-public.target`，对空目标运行 `scripts/restore.sh`，启动服务，再运行 `dshctl reconcile`。恢复失败或尚未演练时，公开注册保持关闭。

<a id="release-check"></a>
## 发布检查

仅当机器检查的配置事实全部成立，且每项演练都有最新的已记录结果时，`checkPublicEnrollment` 才返回 `allow`：Caddy TLS 和标头剥离、authentik 安全版本、邮件和 CAPTCHA、gVisor 下完整工具执行、双用户隔离、进程可见性、回环隔离、沙箱被杀后的恢复、额度失败即关闭、账号生命周期、重启恢复、备份恢复以及容量。每条结果带有主机、发布版和时间；来自其他主机、其他发布版或超过七天的结果会被拒绝，看起来像密钥或用户数据的详情也会被拒绝。用 `dshctl release-check evidence.json /etc/dsh-public` 运行，只有输出 `allow` 之后才开放注册。

<a id="further-exploration"></a>
## 延伸阅读

参阅[设计](../../../../docs/superpowers/specs/2026-10-10-public-team-harness-design.zh.md)、[UI 与发布计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-ui-release.zh.md)和 [production 包](../../packages/production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

测试以静态方式和模拟方式检查这些文件；设置 `CADDY_BIN` 和 `NFT_BIN` 后，Caddy 和 `nft -c` 也能解析 Caddyfile 和防火墙文件。在没有 systemd 的主机上做过一次实验室验证（真实的 Podman、gVisor、nftables 和 Caddy 2.11.7，身份提供方为桩），发现了本指南现已处理的问题；端口段、防火墙规则顺序、pasta 选项、控制器列表、镜像加载和被杀恢复此后只在模拟环境中运行过。`hidepid`、这些单元、真实防火墙、容器镜像、authentik 蓝图、备份、恢复以及上述每项演练仍需在真实主机上运行。
