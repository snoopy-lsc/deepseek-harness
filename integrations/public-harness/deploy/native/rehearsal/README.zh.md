---
description: "原生部署顺序与专用 systemd 主机上特权 Phase 0 演练（P0.4、P0.5、P0.8）的操作手册。"
kind: "package-library"
---

# 原生部署与 P0 演练手册

[English](README.md) | 中文

## Summary

本手册给出原生主机上线的顺序，以及插件市场设计遗留的特权 Phase 0 检查。检查项为 P0.4（reconcile 临时 unit）、P0.5（`meta skuid` 匹配）和 P0.8（市场 socket 监听者所在 cgroup 与 `dsh_market` 加载器）。[p0-rehearsal.sh](p0-rehearsal.sh) 以 root 在专用演练主机上运行这些检查，在其他环境一律拒绝运行；`--dry-run` 只打印计划，不触碰主机。这些检查都还没有在真实主机上运行过。

## Table of Contents

- [部署顺序](#deployment-order)
- [演练前准备](#before-the-rehearsal)
- [运行 P0 演练](#run-the-p0-rehearsal)
- [各探针检查什么](#what-each-probe-checks)
- [结果与证据](#results-and-evidence)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="deployment-order"></a>
## 部署顺序

1. 按[在专用主机上安装](../README.zh.md#install-on-a-dedicated-host)准备主机并安装发布包，包括 Node.js 24.9 或更新版本。
2. 运行 `host-preflight.ts`，修复所有失败项。
3. 用已安装的策略与工具链摘要为随附的原生清单加盖摘要（见[准入前验证](../README.zh.md#validate-before-admission)）。
4. 运行下面的 P0 演练，并把证据目录与发布记录一起保存。
5. 设置 `DSH_NATIVE_REHEARSAL=dedicated-host` 运行 `runNativeRehearsal`，把证据交给 `validateNativeEvidence`。该证据被接受之前，公共注册保持关闭。

<a id="before-the-rehearsal"></a>
## 演练前准备

使用不运行其他服务、允许重启服务的主机。脚本需要 root、正在运行的 systemd（`/run/systemd/system`）以及 `DSH_NATIVE_REHEARSAL=dedicated-host`。它还需要 `systemd-run`、`nft`、`ss`、Node.js 24.9 工具链和 pnpm 可执行文件。它使用一个已有的非特权账号（默认 `nobody`）和一个空闲的回环端口（默认 28672）。P0.8 需要先安装并启动带 `ExecStartPost=-/usr/lib/dsh-public/load-dsh-market.sh` 加载器的 `dsh-plugins.socket`。仓库目前尚未提供该加载器，因此在安装器提供它之前，P0.8 会报告缺少 `dsh_market` 表。P0.5 的容器部分另外需要无根 Podman、gVisor `runsc`、`pasta` 和一个包含 `node` 的实例镜像。

先阅读计划：

```bash
deploy/native/rehearsal/p0-rehearsal.sh --dry-run
```

<a id="run-the-p0-rehearsal"></a>
## 运行 P0 演练

```bash
sudo DSH_NATIVE_REHEARSAL=dedicated-host deploy/native/rehearsal/p0-rehearsal.sh --account dsh-p0 --node /opt/dsh-public/toolchain/node --pnpm /opt/dsh-public/toolchain/pnpm
```

`--only P0.4,P0.8` 选择探针。`--evidence-dir` 指定证据目录，该目录必须尚不存在。`--probe-port` 和 `--socket-unit` 修改端口和市场 socket。`--container --container-image <image>` 加入 P0.5 的 pasta 部分。所有探针资源都命名为 `dsh-p0-*` 或 `dsh_p0_probe`，退出时删除。脚本只读取 `dsh_market` 表，从不修改它。P0.8 会重启市场 socket，因此主机必须是专用的。

<a id="what-each-probe-checks"></a>
## 各探针检查什么

| 探针 | 通过条件 |
| --- | --- |
| P0.4 | 在 `dsh-p0-probe.slice` 中以该账号和 reconcile 属性运行的 `systemd-run --wait --collect` unit，能在 `/proc/self/cgroup` 中看到该 slice。在 `IPAddressDeny=any` 和 `IPAddressAllow=localhost` 下，它能连到 127.0.0.1，连 192.0.2.1 时被拒绝（`EPERM`）。会抛错的 `.pnpmfile.cjs` 会让普通的 `pnpm install --offline` 失败，而 `--ignore-pnpmfile --config.userconfig=/dev/null` 会跳过它和恶意的 `.npmrc`。 |
| P0.5 | 带 `meta skuid <账号 uid>` 的出站规则只计入该账号的回环连接而不计入 root 的连接，`meta skuid 0` 规则只计入 root 的连接。加上 `--container` 时，`runsc` 容器经 `pasta:--map-host-loopback` 发起的连接也计入该账号的 uid；不加时 P0.5 报告 `SKIP`。 |
| P0.8 | 连接市场 socket 的端口即可确定监听者的 cgroup：第 1 级 `init.scope` 或第 2 级 `system.slice/dsh-plugins.socket`。`dsh_market` 表存在，且其 `market_listener` 规则指向该 cgroup。执行 `systemctl restart dsh-plugins.socket` 后两者仍然成立。 |

一次性 reconcile 容器的参数（`assertSafeReconcileArgv`）由单元测试覆盖，不在本脚本范围内。

<a id="results-and-evidence"></a>
## 结果与证据

每个探针输出一行：`PASS`、`FAIL`、`SKIP` 或 `BLOCKED`，后接原因。只有所有选中的探针都通过时退出码才为 0；任一探针失败为 1；有探针被跳过或受阻为 3（不完整，绝不算通过）；脚本拒绝运行为 2。证据目录（默认 `/var/lib/dsh-public/rehearsal/p0-<UTC 时间>`）权限为 0700，其中文件为 0600。目录包含 `host.txt`（内核、systemd 与 nft 版本，以及 machine ID 的 SHA-256）、每个探针一份记录所有命令及输出的日志，以及 `summary.tsv`。脚本从不打印环境变量。看起来像密钥、令牌、密码或私钥的输出在写到终端或文件之前都会被遮蔽。

<a id="further-exploration"></a>
## 延伸阅读

参见[原生部署指南](../README.zh.md)、[插件市场计划](../../../../../docs/superpowers/plans/2026-10-23-plugin-market.zh.md)和 [Phase 0 结果](../../../../../docs/superpowers/plans/phase0-results.zh.md)。

<a id="dev-note"></a>
## 开发说明

`tests/p0-rehearsal.spec.ts` 用 `bash -n`、`shellcheck`（已安装时）、dry-run 计划、拒绝运行和遮蔽来检查脚本。测试从不运行探针。
