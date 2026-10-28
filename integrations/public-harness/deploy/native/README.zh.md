---
description: "在专用 Ubuntu 24.04 主机上以原生 systemd 方式部署公共 Harness：profile、unit、Caddy 边缘、预检与发布证据。"
kind: "package-library"
---

# 原生部署

[English](README.md) | 中文

## Summary

本目录包含公共 Harness 的原生部署。每个用户以锁定的 Linux 账号运行在独立的 system unit 和 slice 中，并受 AppArmor、cgroup 限制、XFS 配额和自有 nftables 表约束。Better Auth 负责注册和会话。Caddy 终止 TLS，只转发到 Unix socket。在真实主机证据通过发布检查之前，公共注册保持关闭。

此原生部署是运行时主线：未指定运行时时 `writeProductionProfile` 选择 `systemd`，新的运行时特性都落在这里。[容器部署](../production/README.zh.md)已冻结：继续维护并保留测试，但不再增加新特性。

## Table of Contents

- [在专用主机上安装](#install-on-a-dedicated-host)
- [服务边界](#service-boundaries)
- [市场防火墙](#market-firewall)
- [准入前验证](#validate-before-admission)
- [运维主机](#operate-the-host)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="install-on-a-dedicated-host"></a>
## 在专用主机上安装

安装由运维人员完成，每一步都需要在不运行其他服务的专用 Ubuntu 24.04 主机上使用 root 权限。在 `/srv/dsh-public` 挂载启用用户配额的 XFS 文件系统。设置 `kernel.apparmor_restrict_unprivileged_userns=1`，并让 `/etc/resolv.conf` 成为 root 拥有的普通文件。把 Node.js 24.9 或更新版本安装为 unit 使用的 `/usr/bin/node`，工具链中的 `/opt/dsh-public/toolchain/node` 也须满足同一下限。把发布包、工具链和固定版本浏览器安装为 root 拥有的只读目录树，并用 `install-browser.sh verify` 校验浏览器。把 `systemd/sysusers.conf` 和 `systemd/tmpfiles.conf` 复制为 `/etc/sysusers.d/dsh-public.conf` 和 `/etc/tmpfiles.d/dsh-public.conf` 并应用。把四个 `config/*.json.example` 复制到 `/etc/dsh-public/`，填入主机名和组 ID。参照 [identity.env.example](config/identity.env.example) 创建 `/etc/dsh-public/identity-secrets/identity.env`（root，0600），写入邮件和 CAPTCHA 服务及其密钥。identity unit 通过 `EnvironmentFile=` 加载该文件，缺少变量时拒绝启动。用 `writeProductionProfile(home, name, { runtime: 'systemd' })` 为 `identity`、`team-router`、`provisioner` 和 `quota` 写入 profile。安装 unit 和 [Caddyfile](Caddyfile)，然后运行预检：

```bash
tsx deploy/native/scripts/host-preflight.ts /etc/dsh-public/provisioner.json /etc/dsh-public/native.json
```

预检只读取主机状态。它报告操作系统版本、工具链与 `/usr/bin/node` 的 Node.js 版本、cgroup 控制器、AppArmor 与用户命名空间限制、XFS 配额强制、nftables、`resolv.conf`、资源所有权和浏览器版本，任何检查失败时以 1 退出。设置了 `ports.market` 时，它还会检查[市场防火墙](#market-firewall)的文件。

<a id="service-boundaries"></a>
## 服务边界

| 服务 | 账号 | 监听 | 可访问 |
| --- | --- | --- | --- |
| Caddy | `caddy` | 公网 443 | 身份公共 socket、路由器 socket |
| `dsh-identity` | `dsh-identity` | `identity/public.sock`、`identity-session/session.sock` | 自己的 SQLite 文件、额度账户 socket、sendmail 或 SMTP 中继、CAPTCHA 服务（阿里云、腾讯云或 Turnstile） |
| `dsh-router` | `dsh-router` | `router/router.sock` | 身份会话 socket、配置服务 socket、实例 socket |
| `dsh-provisioner` | root | `control/provisioner.sock` | 账号、配额、AppArmor、nftables、system unit |
| `dsh-quota` | `dsh-quota` | 额度控制 socket、`quota-account/account.sock`（仅身份服务可连）、`quota-jobs/jobs.sock`（仅知识库服务可连）和每实例回环端口 | 模型服务商 |
| `dsh-kb`（可选） | `dsh-kb` | `kb/kb.sock`（仅身份服务可连） | 自己的知识库根目录、额度任务 socket、root 助手 socket；无网络 |
| `dsh-kb-root@` | root，每个连接一个进程 | `kb-root.sock`（`root:dsh-kb 0660`，套接字激活） | 为一个校验过的助手请求执行 `systemd-run --uid` |

Caddy 会移除调用方提供的身份和转发标头。它无法访问会话 socket，因此只有路由器能把 cookie 解析为用户。配置服务以 root 运行，但从不运行租户代码：每个实例以自己的账号运行在 `dsh-user-<id>.slice` 下的 `dsh-user-<id>.service` 中。知识库服务是可选的：把 `deploy/production/config/kb.example.json` 和 `kb-root.example.json` 复制为 `/etc/dsh-public/kb.json` 和 `kb-root.json`，在额度配置中加入 `jobSocket` 和 `jobSocketGid`（组 `dsh-kb-quota`），把配置服务的 `paths.kbRoot` 设为 `/var/lib/dsh-public/kb`，把 `kb` profile 写入 `/var/lib/dsh-public/kb-home`，然后启用 `dsh-kb-root.socket` 和 `dsh-kb.service`。`dsh-kb` 组中只有 `dsh-kb` 一个成员，所以只有它能打开 root 助手 socket。

<a id="market-firewall"></a>
## 市场防火墙

`provisioner.json` 中未设置 `ports.market` 时跳过本节：市场保持关闭，不需要这些文件。否则每个实例账号都能在回环上访问整个市场端口段，只有 `inet dsh_market` 表能阻止一个账号访问另一个账号的市场端口。该表只放行这样的连接：连接标记（由 `dsh_native` 设为账号 uid）与目标端口组成的二元组在 `market_owner` 集合中，并且监听者位于 `dsh-plugins.socket` 的 cgroup。

1. 把 [load-dsh-market.sh](scripts/load-dsh-market.sh) 安装为 `/usr/lib/dsh-public/load-dsh-market.sh`，属主 root，权限 0755。
2. 在 `provisioner.json` 和 `plugins.json` 中设置相同的 `ports.market`，然后生成规则集和 socket unit：

   ```bash
   tsx deploy/native/scripts/render-market-firewall.ts /etc/dsh-public/provisioner.json /etc/dsh-public/plugins.json --rules /etc/dsh-public/dsh-market.nft --socket /etc/systemd/system/dsh-plugins.socket
   ```

   市场关闭或两处端口段不一致时，生成器拒绝运行。它以 0600 写入规则集、以 0644 写入 unit，每个市场端口一行 `ListenStream`。`--listener-cgroup` 可覆盖监听者 cgroup；默认值 `system.slice/dsh-plugins.socket` 要等[演练](rehearsal/README.zh.md)的 P0.8 实测后才算确认。
3. 执行 `systemctl daemon-reload`，启动 `dsh-plugins.socket`，再运行一次预检。

socket 以 `ExecStartPost=/usr/lib/dsh-public/load-dsh-market.sh /etc/dsh-public/dsh-market.nft` 运行加载器，没有 `-` 前缀。表加载失败时 socket 启动失败，所有市场监听随之关闭，因此缺表时端口绝不会向所有账号开放。规则文件不是 root 拥有、无组写和其他人写的普通文件，或含有 `dsh_market` 白名单以外的行时，加载器拒绝（退出码 2）。它先用 `nft -c` 检查，再用 `nft -f` 原子加载，然后核对链和集合（失败退出码 1）。重新加载会保留 `market_owner` 元素，所以可以安全地重复运行。主机规则集重载后，`PartOf=nftables.service` 会重启 socket，加载器也随之重跑。

实例启动时，配置服务加入该账号的 `uid . port` 二元组，并删除同一 uid 或同一端口的旧二元组；实例停止时删除该二元组。定期探测会重新加载缺失或被改动的表，直接重载失败时重启 socket，无法恢复时发出告警。预检的 `market-firewall` 检查会报告加载器和规则集的属主与权限、加载器会拒绝的规则行、非致命的 `ExecStartPost`，以及表是否已经加载。

<a id="validate-before-admission"></a>
## 准入前验证

在接纳任何公共账户之前，专用主机必须通过[部署计划 Task 3](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-deployment.zh.md) 的全部检查，涵盖工具、文件、进程、网络、资源、恢复、故障和升级恢复。[release-check](../release-check.ts) 中的 `validateNativeEvidence` 只接受在本主机上、针对本发布版本、策略和工具链、且在配置时效内记录的证据。模拟、跳过或过期的证据都会让注册保持关闭。

原生发布使用 schema 2 清单 [release-manifest.json](../release-manifest.json)，字段如下：

- `schema`：固定为 `2`。
- `release`：验证结果所绑定的发布编号。
- `harness`：Harness 包名与版本，与工作区 CLI 版本一致。
- `runtime`：主线为 `{ "kind": "systemd", "policyDigest", "toolchainDigest" }`；冻结的容器运行时在 [production/release-manifest.json](../production/release-manifest.json) 中为 `{ "kind": "podman-gvisor", "image" }`。
- `pluginApi` 与 `bundles`：固定的插件接口和 bundle 版本，两份清单相同。
- `previous`：可回滚到的发布集合（带自己的 `runtime`），或 `null`。
- `publicEnrollment`：固定为 `closed`；只有记录的验证结果才能开放注册。

每个摘要是 `sha256:` 加 64 位十六进制，覆盖已安装目录树的路径、权限、属主和内容，因此仓库中两者都为 `null`。安装发布后，在主机上写出加盖摘要的副本。输出必须是已存在目录中的绝对文件路径，并且位于每个 `--policy` 和 `--toolchain` 根目录之外，因为写进被摘要目录树的清单会改变该树的摘要。`stamp-manifest.ts` 会拒绝其他输出路径，包括经符号链接指向树内的路径：

```bash
tsx deploy/native/scripts/stamp-manifest.ts deploy/release-manifest.json /etc/dsh-public/release-manifest.stamped.json --policy <policy-dir> --toolchain /opt/dsh-public/toolchain
```

准入检查和演练都拒绝未加盖摘要的清单。schema 1 清单按仅容器读取，永远不能为原生主机放行。[rehearse.ts](scripts/rehearse.ts) 中的 `runNativeRehearsal` 只在设置 `DSH_NATIVE_REHEARSAL=dedicated-host` 时运行，已安装的策略或工具链摘要与清单不符时拒绝运行，任何检查缺少执行器或被跳过时把证据标记为 `realHost: false`。真实主机检查本身尚未实现。

<a id="operate-the-host"></a>
## 运维主机

在 `maxActiveInstances × limits` 之外至少预留一个实例的内存和 CPU，让服务和内核不与租户争用资源。内核和 AppArmor 更新同样要经过演练：主机或策略变更会使已记录的证据失效。处理滥用时，先在配置服务中暂停账户。路由器会拒绝下一个请求，会话复查会关闭已打开的流。随后在额度账本中审查用量，再决定是否删除。删除需要等待恢复期并完成已验证的停止。

[backup.ts](scripts/backup.ts) 写出一个 tar 归档，包含身份数据库的一致副本（`VACUUM INTO`）、配置与额度状态以及租户存储；从不包含密钥。恢复前先列出归档内容，拒绝缺失成员、绝对路径或 `..` 路径、硬链接、设备文件以及 `storage/` 之外的链接。它只解压到空目录，由运维人员在服务停止时把恢复的目录树移到位。

<a id="further-exploration"></a>
## 延伸阅读

参阅[部署与 P0 演练手册](rehearsal/README.zh.md)、[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[运行时 provider](../../packages/runtime-systemd/README.zh.md)、[身份服务](../../packages/identity/README.zh.md)与[容器部署](../production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

`tests/deploy-config.spec.ts` 解析本目录中的每个示例，并检查 unit、Caddy 路由、socket 所有权和预检。这些内容尚未在专用主机上运行过。
