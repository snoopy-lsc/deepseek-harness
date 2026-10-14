---
description: "在专用 Ubuntu 24.04 主机上以原生 systemd 方式部署公共 Harness：profile、unit、Caddy 边缘、预检与发布证据。"
kind: "package-library"
---

# 原生部署

[English](README.md) | 中文

## Summary

本目录包含公共 Harness 的原生部署。每个用户以锁定的 Linux 账号运行在独立的 system unit 和 slice 中，并受 AppArmor、cgroup 限制、XFS 配额和自有 nftables 表约束。Better Auth 负责注册和会话。Caddy 终止 TLS，只转发到 Unix socket。在真实主机证据通过发布检查之前，公共注册保持关闭。

## Table of Contents

- [在专用主机上安装](#install-on-a-dedicated-host)
- [服务边界](#service-boundaries)
- [准入前验证](#validate-before-admission)
- [运维主机](#operate-the-host)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="install-on-a-dedicated-host"></a>
## 在专用主机上安装

安装由运维人员完成，每一步都需要在不运行其他服务的专用 Ubuntu 24.04 主机上使用 root 权限。在 `/srv/dsh-public` 挂载启用用户配额的 XFS 文件系统。设置 `kernel.apparmor_restrict_unprivileged_userns=1`，并让 `/etc/resolv.conf` 成为 root 拥有的普通文件。把发布包、工具链和固定版本浏览器安装为 root 拥有的只读目录树，并用 `install-browser.sh verify` 校验浏览器。把 `systemd/sysusers.conf` 和 `systemd/tmpfiles.conf` 复制为 `/etc/sysusers.d/dsh-public.conf` 和 `/etc/tmpfiles.d/dsh-public.conf` 并应用。把四个 `config/*.json.example` 复制到 `/etc/dsh-public/`，填入主机名和组 ID。参照 [identity.env.example](config/identity.env.example) 创建 `/etc/dsh-public/identity-secrets/identity.env`（root，0600），写入邮件和 CAPTCHA 服务及其密钥。identity unit 通过 `EnvironmentFile=` 加载该文件，缺少变量时拒绝启动。用 `writeProductionProfile(home, name, { runtime: 'systemd' })` 为 `identity`、`team-router`、`provisioner` 和 `quota` 写入 profile。安装 unit 和 [Caddyfile](Caddyfile)，然后运行预检：

```bash
tsx deploy/native/scripts/host-preflight.ts /etc/dsh-public/provisioner.json /etc/dsh-public/native.json
```

预检只读取主机状态。它报告操作系统版本、cgroup 控制器、AppArmor 与用户命名空间限制、XFS 配额强制、nftables、`resolv.conf`、资源所有权和浏览器版本，任何检查失败时以 1 退出。

<a id="service-boundaries"></a>
## 服务边界

| 服务 | 账号 | 监听 | 可访问 |
| --- | --- | --- | --- |
| Caddy | `caddy` | 公网 443 | 身份公共 socket、路由器 socket |
| `dsh-identity` | `dsh-identity` | `identity/public.sock`、`identity-session/session.sock` | 自己的 SQLite 文件、额度账户 socket、sendmail 或 SMTP 中继、CAPTCHA 服务（阿里云、腾讯云或 Turnstile） |
| `dsh-router` | `dsh-router` | `router/router.sock` | 身份会话 socket、配置服务 socket、实例 socket |
| `dsh-provisioner` | root | `control/provisioner.sock` | 账号、配额、AppArmor、nftables、system unit |
| `dsh-quota` | `dsh-quota` | 额度控制 socket、`quota-account/account.sock`（仅身份服务可连）和每实例回环端口 | 模型服务商 |

Caddy 会移除调用方提供的身份和转发标头。它无法访问会话 socket，因此只有路由器能把 cookie 解析为用户。配置服务以 root 运行，但从不运行租户代码：每个实例以自己的账号运行在 `dsh-user-<id>.slice` 下的 `dsh-user-<id>.service` 中。

<a id="validate-before-admission"></a>
## 准入前验证

在接纳任何公共账户之前，专用主机必须通过[部署计划 Task 3](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-deployment.zh.md) 的全部检查，涵盖工具、文件、进程、网络、资源、恢复、故障和升级恢复。[release-check](../release-check.ts) 中的 `validateNativeEvidence` 只接受在本主机上、针对本发布版本、策略和工具链、且在配置时效内记录的证据。模拟、跳过或过期的证据都会让注册保持关闭。

原生发布使用 schema 2 清单，其 `runtime` 标记为 `systemd` 并带有策略和工具链摘要；schema 1 清单按仅容器读取，永远不能为原生主机放行。[rehearse.ts](scripts/rehearse.ts) 中的 `runNativeRehearsal` 只在设置 `DSH_NATIVE_REHEARSAL=dedicated-host` 时运行，已安装的策略或工具链摘要与清单不符时拒绝运行，任何检查缺少执行器或被跳过时把证据标记为 `realHost: false`。真实主机检查本身尚未实现。

<a id="operate-the-host"></a>
## 运维主机

在 `maxActiveInstances × limits` 之外至少预留一个实例的内存和 CPU，让服务和内核不与租户争用资源。内核和 AppArmor 更新同样要经过演练：主机或策略变更会使已记录的证据失效。处理滥用时，先在配置服务中暂停账户。路由器会拒绝下一个请求，会话复查会关闭已打开的流。随后在额度账本中审查用量，再决定是否删除。删除需要等待恢复期并完成已验证的停止。

[backup.ts](scripts/backup.ts) 写出一个 tar 归档，包含身份数据库的一致副本（`VACUUM INTO`）、配置与额度状态以及租户存储；从不包含密钥。恢复前先列出归档内容，拒绝缺失成员、绝对路径或 `..` 路径、硬链接、设备文件以及 `storage/` 之外的链接。它只解压到空目录，由运维人员在服务停止时把恢复的目录树移到位。

<a id="further-exploration"></a>
## 延伸阅读

参阅[原生部署设计](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.zh.md)、[运行时 provider](../../packages/runtime-systemd/README.zh.md)、[身份服务](../../packages/identity/README.zh.md)与[容器部署](../production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

`tests/deploy-config.spec.ts` 解析本目录中的每个示例，并检查 unit、Caddy 路由、socket 所有权和预检。这些内容尚未在专用主机上运行过。
