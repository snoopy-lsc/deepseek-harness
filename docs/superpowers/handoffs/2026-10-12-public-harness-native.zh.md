# 原生公开 Harness 交接

[English](2026-10-12-public-harness-native.md) | 中文

## 摘要

这是 2026-10-12 的实现交接快照。运行阶段任务 1 已通过独立审查。运行阶段任务 2 已提交，但仍有待解决的问题，尚未独立审查。原生公开部署尚未完成，必须保持关闭公开准入。下一个 agent 应先审查任务 2 并解决浏览器策略问题，再继续后续计划。

## 目录

- [工作区与依据](#workspace-and-authorities)
- [进度与检查](#progress-and-checks)
- [待解决问题与后续工作](#open-concerns-and-next-work)
- [协调代理的实现决定](#controller-decisions)
- [本机恢复材料](#local-recovery-artifacts)

<a id="workspace-and-authorities"></a>

## 工作区与依据

使用 `/Users/anlin/.codex/worktrees/public-harness-native-research/deepseek-harness`，分支为 `codex/public-harness-native-research`。主目录 `/Users/anlin/ai/deepseek-harness` 和更早的开发工作树不在本次实现范围内。实现提交保存在本地；本次执行没有推送或创建拉取请求。准备本交接文档时工作树干净。

[已确认设计](../specs/2026-10-11-public-harness-native-design.zh.md)规定产品与安全要求。依次执行[运行计划](../plans/2026-10-11-public-harness-native-runtime.zh.md)、[身份计划](../plans/2026-10-11-public-harness-native-identity.zh.md)和[部署计划](../plans/2026-10-11-public-harness-native-deployment.zh.md)。编辑前阅读适用的 AGENTS 指令与包说明。用户已授权在此工作树内逐任务子代理实现和独立审查；本次交接不再派发后续实现任务。

目标是一台专用 Ubuntu 24.04 LTS 服务器，使用原生 Linux 账号、systemd、AppArmor、nftables 和 XFS 配额，实现公开验证注册、每人独立且功能完整的 Harness 进程、平台模型额度、Git 项目共享和统一插件界面。现有容器模式保留为显式选择的另一种实现。macOS/Windows 开发仍仅本机访问。目前没有专用 Linux 测试服务器。

<a id="progress-and-checks"></a>

## 进度与检查

| 计划任务 | 交接时状态 | 证据或下一步 |
| --- | --- | --- |
| 运行 1：服务与持久后端 | 完成，独立审查通过 | 运行接口、带标签配置、v1/v2 迁移和容器适配器；两轮定向修复已关闭全部审查问题。 |
| 运行 2：原生主机准备 | 实现并提交，待独立审查 | 原生库、配置/账号/存储检查和策略生成；下述浏览器问题仍未解决。 |
| 运行 3：网络与实际执行检查 | 未开始 | 实现独立管理的原子防火墙变更与实际保护检查。 |
| 运行 4：生命周期与就绪 | 未开始 | 组合提供者、资源记录、受限初始化、就绪检查和确认清理。 |
| 身份 1–3 | 未开始 | Better Auth、实时私有会话验证与账号页面。 |
| 部署 1–2 | 未开始 | 原生配置组合/主机配置、发布证据与离线备份恢复。 |
| 部署 3 | 未开始 | 可先实现演练工具；真实 Linux 验收需要专用主机和安全审查。 |

实现历史包含提交主题 `refactor: introduce explicit public Harness runtime providers`、`fix: synchronize public Harness admission and runtime ownership`、`fix: preserve current public Harness launch ownership` 和 `feat: prepare confined systemd Harness accounts`。准确提交标识以分支历史为准；本交接不要求重置或修改这些提交。

任务 1 的独立审查修复了容量拒绝前分配资源、启动覆盖暂停状态、恢复实例漏清理以及旧观察覆盖当前实例清理记录的问题。最后的提供者定向测试为 9 项通过；更早的受影响生命周期测试为 43 项通过。任务 2 最后六文件测试为 81 项通过、2 项明确的 Linux/root 检查跳过。集成构建和类型检查通过。任务 2 文档检查为 21 项通过，doc-sync 为 43 项通过。根目录代码检查通过，仅有一条既存的无效禁用指令警告。跳过的描述符/root 测试与策略文本均不代表 Linux 保护已实际生效。

下列是任务 2 已执行的行为检查。这些命令记录前任的验证结果，不代表接手代理已执行；修改源码后应先构建，再测试依赖构建产物的导入。集成测试脚本中独立的 `--` 曾被错误转发而选中整个集成测试集，因此使用直接 Vitest 路径。

```sh
pnpm --dir integrations/public-harness run build
pnpm --dir integrations/public-harness exec vitest run --config vitest.config.ts packages/runtime-systemd/tests/host-policy.spec.ts packages/runtime-systemd/tests/storage.spec.ts packages/provisioner/tests/config.spec.ts packages/provisioner/tests/provisioning.spec.ts packages/provisioner/tests/reconcile.spec.ts packages/provisioner/tests/runtime-provider.spec.ts
pnpm --dir integrations/public-harness exec tsc --noEmit
```

文档检查使用 `pnpm run test:docs` 和 `env -u all_proxy -u ALL_PROXY pnpm run doc-sync`。被移除的 SOCKS 代理变量会在本环境产生无关的 CLI 帮助诊断。无需仅为提交重复已通过的宽范围检查；应针对接手代理的实际变更选择检查。

<a id="open-concerns-and-next-work"></a>

## 待解决问题与后续工作

1. 按任务说明和下述决定审查运行任务 2，再标记完成。[原生包说明](../../../integrations/public-harness/packages/runtime-systemd/README.zh.md)负责配置与限制；当前是准备阶段的库，提供者注册和生命周期仍属于运行任务 4。[配置管理包说明](../../../integrations/public-harness/packages/provisioner/README.zh.md)和[升级指南](../../upgrade-guide/v0.2.1-alpha.2/public-harness-backends/guide.zh.md)说明共享行为与迁移。
2. 解决已确认的浏览器策略缺口。现有 Chromium 启动器使用操作系统分配的 CDP 端口，并保留浏览器内部沙箱。Chromium 的命名空间沙箱会写 UID/GID 映射，并使用命名空间能力和 chroot；当前 AppArmor 策略没有授予所需的映射写入与能力操作。因此完整浏览器兼容性尚未验证，且可能被阻塞。未实现不受限策略或关闭沙箱的绕过。应依据一手资料和真实 Linux 证据选择兼容策略或通信方式，同时保留全部强制外层保护。
3. 在把仅允许 Web/配额回环端口视为完整工具支持之前，解决网络兼容性。浏览器 CDP 和其他本地工具可能使用临时 TCP 监听端口。其他用户的回环服务、主机/私网/元数据地址、IPv6 绕过和用户任意监听器的公网直连必须继续被拒绝。相关代码为 `packages/experimental/browser-use-stagehand-native/src/launch.ts`；如果计划的浏览器要求与端口策略冲突，必须明确解决。
4. 运行任务 4 应加载公共配置和引用的原生选项，在注册 `instanceRuntime` 前验证只读资产，并通过导出的准备步骤逐项持久记录资源。工作区初始化前安装并检查实际保护。令牌/就绪文件放在私有 home；根管理目录保持独立。公共账号命令仍使用原运行器超时，因此若全流程需要原生 `operationTimeoutMs`，应在生产组合中注入相应超时的运行器。
5. 删除必须经过确认/恢复期限，并确认整个 cgroup、UID 和进程均已静止。用户进程仍能与遍历竞争时，不能执行现有递归数据删除。清理失败时保留不确定的分配并隔离；不能猜测成功后复用 UID/端口。
6. 部署必须在 SSH 入口拒绝受管 Linux 账号，或验证不存在 SSH。锁定密码与 nologin 本身不能证明公钥认证/转发被拒绝。应检查实际 SSH 配置，并在演练中尝试真实拒绝场景，同时保留对外 Git SSH 能力。[OpenSSH 配置](https://man.openbsd.org/sshd_config)区分账号登录拒绝与转发限制。
7. 本 Mac 尚未验证真实 AppArmor 加载/保护、cgroup 限制、XFS 字节/inode 耗尽、防火墙行为、重启恢复、恶意用户尝试和升级恢复。可实现专用主机测试与证据验证器，但在真实 Linux 证据和安全审查满足设计前，必须关闭公开准入。

<a id="controller-decisions"></a>

## 协调代理的实现决定

这些决定补充或澄清书面计划；接手代理应对照已确认设计评估。下表保留全部记录的决定及其返工代价。

| 决定 | 原因 | 若判断错误的代价 |
| --- | --- | --- |
| 身份模块分别使用 Host、Client 叶级 TypeScript 程序和聚合根配置。 | 仓库的编译程序分离规则。 | 多几个构建/配置文件。 |
| 本地实现 Linux 演练，但真实主机验收保持待完成。 | 没有测试主机，禁止模拟批准。 | 延后公开部署。 |
| 先建立显式运行提供者选择；容器资产/工具/网络/linger 留在容器标签下。 | 原生模式不能要求容器依赖。 | 容器测试夹具与配置迁移。 |
| 增加运行 `allocate` 和持久的部分分配记录。 | 完整实例必须具有真实端口和同一启动标识。 | 增加生命周期方法与适配器变更。 |
| 增加 `releaseAllocation`，恢复不完整分配。 | 完整 `stop` 需要完整端点，不能在不确定清理中编造端口。 | 增加清理方法，并共享清理实现。 |
| 原生配置从唯一公共配置与严格伴随选项解析；公共 systemd 标签保存绝对 `configFile`。 | 公共路径/限额/端口/超时只有一个来源，原生字段由提供者负责。 | 伴随配置文件与加载组合。 |
| 原生文件准备交由提供者；准备成功后记录存储，失败时保留分配。 | 共享容器所有权变更不适用于原生根管理目录。 | 调整准备顺序和测试。 |
| 原生根控制目录使用 `stateDir/runtime/<account>`；用户可读令牌/就绪文件留在 home。 | 管理目录位于用户目录外，消费方无需导入原生选项。 | 调整令牌/转发器布局。 |
| 验证目标/祖先后允许只读资产内部链接；根写入保持描述符与不跟随链接。 | 普通 pnpm 布局使用链接，仍拒绝可写、越界和循环目标。 | 增加资产检查与测试。 |
| 恢复测试中用户目录与服务使用同一运行依赖。 | 混合真实/模拟所有权产生无效清理证据，已在基线复现。 | 诊断错误时返工夹具，不改变生产 API。 |

<a id="local-recovery-artifacts"></a>

## 本机恢复材料

本工作树被忽略的 `.superpowers/sdd/2026-10-11-public-harness-native-runtime/` 目录保存 `progress.md`、任务说明/报告、审查发现和定向差异包。它不在提交中，新克隆可能不存在。请保留本机材料，交接时不要清理被忽略文件。记录中任务 1 已完成；任务 2 应标记为已实现但待审查，不能标记完成。

接手代理可从 `feat: prepare confined systemd Harness accounts` 前一个提交到该任务提交生成任务 2 审查包。使用已确认的子代理流程，并取得规格与质量两个结论；不要把交接文档混入更宽的审查范围，也不要重新实现已完成的任务 1。尚未进行最终整分支审查。
