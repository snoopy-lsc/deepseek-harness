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
- [升级与回滚](#upgrade-and-roll-back)
- [备份与恢复](#back-up-and-restore)
- [发布检查](#release-check)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="install-on-a-linux-host"></a>
## 在 Linux 主机上安装

使用专用主机，需具备 systemd、已委派 `cpu`、`memory` 和 `pids` 控制器的 cgroup v2、无根 Podman、gVisor `runsc`、nftables，以及为 `quotaMount` 启用用户配额的文件系统。把构建好的集成项目和 Harness 安装到 `/opt/dsh-public`，再复制下列文件。

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

<a id="upgrade-and-roll-back"></a>
## 升级与回滚

`deploy/release-manifest.json` 固定一个发布版：Harness 版本、插件接口版本、每个 bundle 以及实例镜像。接触任何用户之前，先对已安装候选版本的非生产配置运行 `preflightUpgrade`；它检查接口和 bundle 固定版本、Session 迁移，以及登录、模型调用、终端、Session 和插件加载流程，并在第一个接口不匹配时停止。随后 `rolloutUpgrade` 把 `assets/current` 链接切换到新发布目录，先重启一个金丝雀用户，再分批进行。它记录进度，使中断的发布可以继续；第一个实例失败时，它恢复先前的发布链接并停止。回滚只改变代码：从不移动或删除 `DSH_HOME`、Session 或 Git 工作区。更换实例镜像需要在修改配置后重启配置服务。

<a id="back-up-and-restore"></a>
## 备份与恢复

以 root 运行 `scripts/backup.sh`。它对额度账本做在线 SQLite 备份，再归档配置服务状态、保留属主的每位用户存储以及非密钥配置，并记录校验和。密钥文件应通过运维人员的密钥管理器单独备份。恢复时，先停止 `dsh-public.target`，对空目标运行 `scripts/restore.sh`，启动服务，再运行 `dshctl reconcile`。恢复失败或尚未演练时，公开注册保持关闭。

<a id="release-check"></a>
## 发布检查

仅当机器检查的配置事实全部成立，且每项演练都有最新的已记录结果时，`checkPublicEnrollment` 才返回 `allow`：Caddy TLS 和标头剥离、authentik 安全版本、邮件和 CAPTCHA、gVisor 下完整工具执行、双用户隔离、额度失败即关闭、账号生命周期、重启恢复、备份恢复以及容量。每条结果带有主机、发布版和时间；来自其他主机、其他发布版或超过七天的结果会被拒绝，看起来像密钥或用户数据的详情也会被拒绝。用 `dshctl release-check evidence.json /etc/dsh-public` 运行，只有输出 `allow` 之后才开放注册。

<a id="further-exploration"></a>
## 延伸阅读

参阅[设计](../../../../docs/superpowers/specs/2026-10-10-public-team-harness-design.zh.md)、[UI 与发布计划](../../../../docs/superpowers/plans/2026-10-10-public-harness-ui-release.zh.md)和 [production 包](../../packages/production/README.zh.md)。

<a id="dev-note"></a>
## 开发说明

测试以静态方式和模拟方式检查这些文件；Caddy 还通过其配置适配器运行过。这些单元、防火墙、容器镜像、authentik 蓝图、备份、恢复以及上述每项演练都尚未在真实主机上运行。
