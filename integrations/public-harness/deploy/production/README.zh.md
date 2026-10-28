---
description: "Team Harness 的 Linux 生产部署、升级、备份和公开注册发布指南。"
kind: "package-library"
---

# 生产部署

[English](README.md) | 中文

## Summary

此目录包含 Team Harness 的 Linux 部署：带 authentik 转发认证的 Caddy 入口、作为 systemd 单元的路由器、配置服务和额度服务、出站防火墙、实例镜像、备份脚本以及发布检查。在发布检查允许之前，公开注册保持关闭。

此容器运行时（无根 Podman 加 gVisor）已冻结：继续维护、保持可用并保留测试，问题照常修复，但不再增加新特性。[原生部署](../native/README.zh.md)是运行时主线，也是 `writeProductionProfile` 的默认值，因此容器部署必须显式选择 `runtime: 'podman-gvisor'`。

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
install -m 0644 deploy/production/nftables/dsh-market.nft /etc/nftables.d/dsh-market.nft
systemd-sysusers && systemd-tmpfiles --create && nft -f /etc/nftables.d/dsh-public.nft
```

把 `dsh-market.nft` 放到位，供插件市场 socket 单元使用，但**不要**用上面的 `nft -f`（或 `nftables.service` 对 `dsh-public.nft` 的 include）加载它。`dsh-plugins.socket` 通过 `ExecStartPost=-`（失败不致命）加载 `inet dsh_market`；配置服务的探测也会恢复它。若与 `dsh-public.nft` 同路径加载，会把两张表绑在一起，并在 `flush ruleset` 清空后缺少 socket 单元的重载路径。

把每个 `deploy/production/config/*.example.json` 去掉 `.example` 后复制到 `/etc/dsh-public/`，属主为 root 且其他用户不可写，并替换所有占位符：两个组 ID、authentik audience 和密钥文件、模型上游、实例镜像以及主机名。把平台模型密钥、令牌密钥和健康密钥作为属主为 `dsh-quota` 的 `0600` 文件放入 `/etc/dsh-public/secrets/`。将 `deploy/authentik/brand.yml` 和 `deploy/authentik/public-harness.yaml` 作为 authentik 蓝图导入，CAPTCHA 密钥放在 authentik 的环境变量中。用 `scripts/build-image.sh` 和 `scripts/build-assets.sh` 构建镜像和运行时资源发布版，把 `/opt/dsh-public/assets/current` 指向该发布版，用 `deploy/production-profile.ts` 中的 `writeProductionProfile` 并传入 `runtime: 'podman-gvisor'` 生成三个配置（默认是原生运行时），再启动 `dsh-public.target`。在出站表、限制和 gVisor 验证通过之前，配置服务拒绝启动任何实例。

`scripts/build-image.sh` 还会导出 `runtime.imageArchive` 指定的镜像归档（默认 `/opt/dsh-public/image/dsh-instance.tar`，所有账号可读）。配置服务不共享镜像存储：每个账号有自己的无根存储，因此账号首次启动时会以该账号身份执行 `podman load` 加载归档（未配置归档时则 `podman pull` `runtime.image`），一次只处理一个账号；之后若配置的镜像引用仍不存在，则拒绝启动。容器以 `--userns keep-id:uid=10001,gid=10001` 启动，因此镜像用户（uid 10001）写入的内容归主机账号所有；请保持 Containerfile 中的用户与该映射一致。在主机上验证该映射时，以 root 读取该账号正在运行的 gVisor 沙箱的映射：用 `ps -eo pid,user,args | grep runsc-sandbox` 找到其进程，再运行 `cat /proc/<pid>/uid_map`；其中 `10001 <该账号的主机 uid> 1` 这一行（`gid_map` 中同样）就是证据，另一项证据是运行参数列表，`assertSafeRunArgv` 只接受恰好带这一个 `--userns` 值的参数。conmon 的命令行（Podman 不会把自己的参数传给 conmon）和 `podman inspect`（它把 `UsernsMode` 报告为 `private`）都不会显示 keep-id 值，因此二者都不能作为证据，无论正反。首次启动会较慢（实验中 5.1 GB 的归档加载耗时 31 秒；路由器配置的 `provisionerEnsureTimeoutMs` 决定路由器最多等待多久，示例中为 20 分钟，且不得小于 `routeWaitMs`），且每个账号保存一份镜像并计入该账号的磁盘配额，因此 `diskBytes` 要按镜像加用户数据来估算。

<a id="network-boundaries"></a>
## 网络边界

实例只能通过 pasta 的主机回环映射访问主机。在 `dsh-public.nft` 中，实例 UID 范围在 `127.0.0.1` 上只能到达两段回环端口：`QUOTA_PORTS` 与 `MARKET_PORTS`。`QUOTA_PORTS` 必须与 `quota.json` 的 `listenPorts` 和 `provisioner.json` 的 `ports.quota` 相等；`MARKET_PORTS` 必须与 `provisioner.json`（以及 `plugins.json`）的 `ports.market` 相等；测试会比较这些示例。配置服务从另一段 `ports.sidecar` 为每个实例发布 sidecar，只有主机侧转发器使用它，防火墙不放行，因此实例无法连接其他实例的 sidecar，也无法连接任何其他回环服务（路由器健康 socket、Caddy、authentik、数据库）。端口段必须很窄（至多 4096 个端口）、位于 1024-32767 以避开内核的临时端口范围、互不重叠、额度/sidecar 至少容纳 `maxActiveInstances` 个端口（市场段为账户上限，≤ 4096），并且不得与其他服务使用的端口冲突。额度放行范围内其他用户的监听地址仍可连通，所以每个监听地址只接受绑定到自己实例的凭据。其他服务仍应尽量绑定到 Unix socket。

**Q7（仅对市场端口范围推翻原决定）。** 「容器防火墙没有按用户规则」这一记录决定对额度和所有其他回环服务仍然成立。仅对 `ports.market`，生产侧在单独加载的 `inet dsh_market` 表（`deploy/production/nftables/dsh-market.nft`）中增加 per-user 的 `market_owner` 集合元素与收包 socket 规则：优先级为 `filter - 2` 的输出链丢弃不在集合中的 UID/端口对，输入侧 `market_listener` 子链只放行 systemd 持有的监听 cgroup。再配合 `dsh-public.nft` 中整段 `MARKET_PORTS` 的 accept，只有属主实例账户能到达自己的市场端口，且只有 `dsh-plugins` 能在这些端口上收包。root、`dsh-router`、`dsh-identity` 及其他主机账户仍不能进入市场端口范围。重启 `nftables.service` 会执行 `flush ruleset`，一并清掉 `dsh_market`；配置服务探测会在一分钟内恢复表与集合——运维不应单独重载规则集。表缺失期间，仅靠整段 accept 会使任一实例账户都能访问任一市场端口；`dsh-plugins` 中的 `inet_diag` 对端校验（及其后的 bearer 令牌）仍是纵深防御。`dsh-plugins-fetch` 由 `dsh-public.nft` 限制为只能连接 `127.0.0.1:$EGRESS_PORT`（在 `systemd-sysusers` 之后设置 `PLUGINS_FETCH_UID`）。二期的 `egress_locked` drop 不在此落地。

Caddy 的管理 API 只监听 `unix//run/caddy/admin.sock`（权限 0600），从不监听 TCP，因此用 `caddy reload --address unix//run/caddy/admin.sock` 重新加载。请把每个 DNS 解析器都列入 `RESOLVERS`：解析器规则排在私有网段丢弃规则之前，所以位于 10/8、172.16/12 或 192.168/16 的解析器也能工作。配置服务自己构造 pasta 参数，带有 `--map-host-loopback` 和 `--no-splice`（缺少 `--no-splice` 时，gVisor 下已发布端口会返回连接重置），因此配置里只需写 `pasta`。

把路由器的 `publicAuthority` 设为浏览器实际发送的主机，写法要完全一致。Caddy 转发 `Host` 时保留端口，所以标准的 443 部署使用不带端口的主机名（路由器拒绝 `:443` 和 `:80`，因为浏览器从不发送它们）；在其他端口上的预发布部署，例如 `staging.example.com:8443`，必须写上该端口，否则每个请求都会返回 421。

<a id="resource-limits"></a>
## 资源限制

在 gVisor 下，耗尽 pids 限制在两次实验室运行中都杀掉了整个沙箱而不是单个进程；超出内存限制在第一次运行中杀掉了整个沙箱，在第二次运行中（四次尝试）却只杀掉一个进程，所以结果取决于内核、gVisor 构建和 cgroup 配置：请按可能丢失整个沙箱来规划，但不要依赖这一点。pids 限制统计的是沙箱的主机线程（空闲时约 45 个，每个来宾进程再加两三个），而不是来宾进程；实验室中限制为 128 时只允许约 35 个来宾进程。真实的空闲 Harness 实例约占 48-52 个 pids、175-200 MiB（峰值 216 MiB）。因此对 `podman-gvisor` 运行时，配置服务拒绝少于 512 个 pids 或不足 1 GiB 的设置，示例使用 2048 个 pids 和 4 GiB。被杀掉的实例（演练时可耗尽 pids 或杀掉 `runsc-sandbox`，因为耗尽内存并不总会杀掉沙箱）会由 `status`（每个用户至多每五秒检查一次）和 `reconcile` 报告为 `stopped`，其 socket 和额度监听地址随之释放，下一次请求会再次启动；未保存的内存中工作会丢失，主目录和工作区文件保留。停止有时限：先在 `stopTimeoutMs` 内执行 `podman rm`，再发送 SIGKILL 并强制删除；若容器仍然存在，停止会失败，由 `reconcile` 重试。

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

测试以静态方式和模拟方式检查这些文件；设置 `CADDY_BIN` 和 `NFT_BIN` 后，Caddy 和 `nft -c` 也能解析 Caddyfile 和防火墙文件。市场 nftables 覆盖仅为文本/夹具（CI 机器上的 Q7 市场表不要求真实 `nft` apply）。在没有 systemd 的主机上做过一次实验室验证（真实的 Podman、gVisor、nftables 和 Caddy 2.11.7，身份提供方为桩），发现了本指南现已处理的问题；端口段、防火墙规则顺序、pasta 选项、控制器列表、镜像加载和被杀恢复此后只在模拟环境中运行过。`hidepid`、这些单元、真实防火墙（含经 `ExecStartPost=-` 加载的 `dsh_market`）、容器镜像、authentik 蓝图、备份、恢复以及上述每项演练仍需在真实主机上运行。
