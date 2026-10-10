# 公开 Harness 运行环境实施计划

[English](2026-10-10-public-harness-runtime.md) | 中文

> **供执行任务的 agent 使用：** 必须使用 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在 macOS 和 Windows 开发宿主机上运行真实的每用户 Harness Web 进程，并在一台 Linux 正式服务器上运行受隔离的每用户实例。

**架构：** 路由使用一个 Cordis `InstanceManager` 服务。开发 provider 启动各自拥有私有目录、只监听 loopback 的子进程；正式 provider 通过受保护的 Unix socket 调用有特权的配置服务。配置服务从不透明的 authentik 用户 ID 推导宿主机账号和存储名称，启动 gVisor 容器，并提供每用户专属的 Unix socket 入口。

**技术栈：** TypeScript、Node 22.19+ 或 24+、Cordis profiles、macOS 与 Windows 子进程、Linux systemd、rootless Podman、OCI、gVisor `runsc`、Vitest。

**规格：** [公开多用户 Harness 设计](../specs/2026-10-10-public-team-harness-design.zh.md)。

**执行顺序：** 先完成任务 1–2，再完成[额度计划](2026-10-10-public-harness-quota.zh.md)及本地路由与界面工作；Linux 任务 3–5 在真实 Linux 主机上继续。

## 全局约束

- 运行时代码放在独立版本的 `integrations/public-harness/` 项目中；不修改 Harness agent loop、Session 或核心 Web 实现。
- 显式开发模式在 macOS 和 Windows 上只监听 loopback，使用固定测试身份和相互独立的子进程目录，不声称具备宿主机安全隔离。
- 每位用户拥有一个不可登录的 Linux 服务账号、一个使用 gVisor `runsc` 的 rootless Podman 容器、私有 `DSH_HOME` 和 Git 工作区，并强制配置 CPU、内存、进程数、磁盘和网络限制。
- 容器不挂载管理 socket、平台模型密钥或其他用户的数据。缺少 gVisor 或任一必需限制时，配置服务拒绝启动。
- 用户的 Harness 只能由 `dsh --profile web` 启动；配置服务自身使用独立的 `dsh` profile。
- 配置服务只接受经过验证的不透明用户 ID 和固定操作；账号名、路径、镜像与服务名都由服务端推导。
- 任务文件列表中的路径若未写出 `integrations/public-harness/` 前缀，均相对于该目录。

## 重点审查

- 包含分隔符或 Unicode 相似字符的用户 ID 不能选择宿主机路径或账号名；任务 1 固定拒绝行为。
- 同一用户的两个首次请求只能创建一个账号和实例；任务 3 固定加锁与恢复行为。
- 断电后只创建了一部分账号或目录时，重试必须校正状态，且不能发布半成品入口；任务 3 固定此行为。
- gVisor 不可用或任一资源限制无法执行时，必须在启动容器前失败；任务 4 固定此行为。
- 账号停用后旧 socket 不能继续路由，已存储数据仍保持私有；任务 5 固定此行为。
- 开发模式绑定非 loopback 地址，或在 macOS/Windows 上启用正式模式，都必须在启动子进程前失败；任务 2 固定此行为。

---

### 任务 1：实例管理服务与固定配置协议

**文件：** 创建 `integrations/public-harness/package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`packages/contracts/src/index.ts`、`packages/provisioner/src/protocol.ts`、`packages/contracts/tests/instance-manager.spec.ts` 和 `packages/provisioner/tests/protocol.spec.ts`；添加各包 manifest 和项目 README 双语文件。

**接口：** 提供品牌类型 `UserId`、仅接受 `^[A-Za-z0-9_-]{1,128}$` 的 `parseUserId(value: string): UserId`，以及 Cordis `InstanceManager`，其方法为 `ensure(userId): Promise<InstanceEndpoint>`、`launchGrant(userId): Promise<string>` 和 `stop(userId): Promise<void>`。`InstanceEndpoint` 为 `{ kind: 'unix'; path: string } | { kind: 'tcp'; host: '127.0.0.1'; port: number }`。正式 provider 使用只含 `ensure`、`launch-grant`、`stop` 与 `status` 操作标签的 `ProvisionerClient`。路由使用 `InstanceManager`。

- [ ] **步骤 1：编写失败测试**，覆盖两种入口标签、规范用户 ID、分隔符和相似字符拒绝、未知字段和操作标签、socket 权限以及响应大小限制。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- instance-manager.spec.ts protocol.spec.ts`；确认新测试失败。
- [ ] **步骤 3：实现** Cordis 服务定义、品牌类型解析器、入口 schema，以及有大小上限和明确错误的 Unix socket 客户端与服务端消息封装。
- [ ] **步骤 4：运行** 同一组测试；确认通过，然后提交协议与 README 双语文件。

### 任务 2：macOS 与 Windows 开发运行环境

**文件：** 创建 `packages/dev-runtime/src/index.ts`、`processes.ts`、`config.ts` 和 `tests/dev-runtime.spec.ts`；创建 `packages/web-token/src/index.ts`、`tests/web-token.spec.ts` 及其 bundle；添加包 manifest 和 README 双语文件。

**接口：** 开发 provider 为每个固定测试身份使用真实的 `dsh --profile web` 子进程、私有 `DSH_HOME` 与 Git 工作区实现 `InstanceManager`，返回 loopback TCP `InstanceEndpoint`。它通过私有父子进程通道取得启动授权；`printUrl: false` 和 `--no-open` 防止显示令牌。

- [ ] **步骤 1：编写失败测试**，覆盖两个子进程的私有目录、真实 shell 和终端访问、启动授权保密、重启后保留 Session 数据、拒绝非 loopback 绑定，以及在 macOS/Windows 上拒绝正式模式。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- dev-runtime.spec.ts web-token.spec.ts`；确认失败。
- [ ] **步骤 3：使用** Node 路径 API 实现可跨平台的进程启动和清理、每用户目录映射、loopback 绑定、启动就绪检查和共享 Web 令牌 bundle。
- [ ] **步骤 4：在 macOS 和 Windows 上运行** 聚焦测试及两个真实 Web 进程的浏览器流程；确认通过后提交。

### 任务 3：幂等的 Linux 用户配置

**文件：** 在该项目下创建 `packages/provisioner/src/accounts.ts`、`storage.ts`、`state.ts` 和 `tests/provisioning.spec.ts`。

**接口：** 提供 `ensureUser(userId: UserId): Promise<UserRecord>` 和 `stopUser(userId: UserId): Promise<void>`。`UserRecord` 只包含推导出的账号名、私有存储路径和生命周期状态；调用方传入的路径不能进入记录。

- [ ] **步骤 1：编写失败测试**，覆盖并发 `ensureUser`、中断后的重试、现有目录属主错误、已停用用户，以及容量拒绝时不创建新账号。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- provisioning.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 每用户锁、持久生命周期记录、派生账号名、受限目录创建、属主检查，以及未发布部分结果的回滚。
- [ ] **步骤 4：运行** 聚焦测试；确认通过，然后提交配置状态机。

### 任务 4：隔离容器与 Web 入口

**文件：** 创建 `packages/provisioner-client/src/index.ts`、`packages/provisioner/src/runtime.ts`、`limits.ts`、`token-channel.ts`、`tests/runtime.spec.ts` 和 Linux 集成测试数据；复用任务 2 创建的 Web 令牌 bundle。

**接口：** 提供 `Runtime.start(record: UserRecord): Promise<InstanceEndpoint>`、`Runtime.stop(record): Promise<void>`，以及任务 1 的 `launchGrant(userId)`。正式 `InstanceManager` provider 通过 `ProvisionerClient` 调用此运行环境。Web 令牌插件读取 `ctx.connection.authenticatedUrl()`，只通过私有进程管理通道发送启动令牌；关闭常规令牌 URL 输出。

- [ ] **步骤 1：编写失败测试**，覆盖 gVisor 缺失、任一限制缺失、禁止挂载、无法访问其他用户容器与宿主机私有地址、额度代理不可达、令牌通道保密、就绪超时和精确的 Web profile 启动参数。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- runtime.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 使用 `runsc` 的 rootless Podman、按账号执行、私有网络与有界出站访问、宿主机 socket 转发、健康检查、令牌通道和限制缺失时拒绝启动；若这种运行方式无法在 Linux 上执行规格要求，则停止此任务。
- [ ] **步骤 4：运行** 聚焦测试；确认通过。在 Linux 主机上用真实 `dsh --profile web`、shell 工具、终端和 Git 工作区执行集成测试；记录结果后提交。

### 任务 5：停用、重启与恢复

**文件：** 创建 `packages/provisioner/src/reconcile.ts`、`tests/reconcile.spec.ts`，并在 `deploy/` 下创建 systemd unit 与备份恢复运行手册。

**接口：** `reconcile(): Promise<void>` 只恢复验证过的记录；`suspend(userId): Promise<void>` 停止容器并撤销路由 socket。删除是另一项受恢复期限制的操作。

- [ ] **步骤 1：编写失败测试**，覆盖宿主机重启、陈旧 socket、空闲唤醒、停用、重新启用，以及配置恢复期未结束时删除。
- [ ] **步骤 2：运行** `pnpm --dir integrations/public-harness test -- reconcile.spec.ts`；确认失败。
- [ ] **步骤 3：实现** 状态校正、socket 撤销、停止与唤醒，以及延迟删除；普通停止后保留账号数据。
- [ ] **步骤 4：运行** 聚焦测试和 Linux 重启、备份恢复演练；确认用户隔离正确，然后提交。
