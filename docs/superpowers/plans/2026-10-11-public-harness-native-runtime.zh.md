# 无容器 Harness 运行环境实施计划

[English](2026-10-11-public-harness-native-runtime.md) | 中文

> **供代理执行：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 新增 systemd 提供者，约束每位用户的完整进程树，并保留已有容器提供者。

**架构：** Cordis 运行服务将用户开通与后端执行分开。systemd 提供者先安装账号、存储、AppArmor、配额及按 UID 生效的网络限制，再启动用户代码。开通服务只发布完成身份认证和校验的端点。

**技术栈：** TypeScript, Node ^22.19 || >=24, Cordis, Vitest, Ubuntu 24.04 LTS, systemd, cgroup v2, AppArmor, nftables, XFS.

**规格：** [已确认的无容器部署设计](../specs/2026-10-11-public-harness-native-design.zh.md)。

**依赖顺序：** 可先执行；[身份服务](2026-10-11-public-harness-native-identity.zh.md)可独立开发。[部署计划](2026-10-11-public-harness-native-deployment.zh.md)依赖这两部分。

## 全局约束

- 下列文件路径相对于 `integrations/public-harness/`；`docs/` 路径相对于仓库根目录。改动保留在独立插件和配置档中；Harness 会话格式与 `InstanceManager` 保持不变。

- 使用严格 TypeScript、带品牌类型的不透明 ID、ESM、导出文档、经过校验且可配置的部署参数，并由 `ctx.effect()` 管理生命周期。所有 Node 服务都通过 `dsh` 配置档启动。

- 本计划中的命令和断言描述待执行的检查及预期结果，不代表已经完成的部署证据。定向命令从仓库根目录执行；测试已构建模块的导入前先构建集成项目。

- 无容器模式不要求容器引擎、OCI 镜像、gVisor 或用户管理器驻留。macOS/Windows 保留仅本机访问的开发模式；无容器隔离验证需要专用 Linux 主机。

## 审查重点

- 旧版或损坏状态：有效 v1 记录标记为容器；拒绝损坏记录和后端不匹配（任务 1）。
- 用户把路径换成符号链接：root 不沿链接进入用户数据或其他账号（任务 2）。
- IPv6、已建立连接或无关的主机防火墙规则：拒绝禁止目的地并保留主机规则（任务 3）。
- 并发启动、伪造就绪或无法确认进程状态：不重复创建实例，也不发布未经验证的端点（任务 4）。
- 清理失败或停止后仍有子进程：撤销访问并隔离 UID/端口，不重新分配（任务 4）。

---

### 任务 1：运行服务与持久化后端选择

**文件：** 创建 `packages/contracts/src/runtime.ts`、`packages/provisioner/src/runtime-provider.ts`、`packages/contracts/tests/runtime.spec.ts`；修改 contracts 的 `src/index.ts`、provisioner 的 `src/{config,state,users,service,reconcile}.ts`、`tests/{config,provisioning,reconcile}.spec.ts`、包 README 双语文件，以及 `docs/upgrade-guide/v0.2.1-alpha.2/public-harness-backends/guide.md`、中文对应文件和配对记录。

**接口：** 在 contracts 定义以下类型；`InstanceId`、`UnitName` 和 `ContainerName` 使用 `Branded` 及校验解析器。`InstanceId` 接受 `^[A-Za-z0-9_-]{1,128}$`；`ContainerName` 接受现有派生账号名格式。`UnitName` 只接受服务端派生的 `dsh-user-<24 位小写十六进制>.service` 名称。

```text
RuntimeKind = 'systemd' | 'podman-gvisor'
RuntimeState = 'running' | 'stopped' | 'unknown'
RuntimeRef = { kind: 'systemd'; unit: UnitName } | { kind: 'podman-gvisor'; container: ContainerName }
RuntimeInstance = { userId: UserId; instanceId: InstanceId; runtime: RuntimeRef;
  account: string; uid: number; gid: number; home: string; workspace: string;
  cache: string; tmp: string; controlDir: string; webPort: number; quotaPort: number }
InstanceRuntime = {
  kind: RuntimeKind;
  prepare(instance: RuntimeInstance): Promise<void>;
  initializeWorkspace(instance: RuntimeInstance): Promise<void>;
  start(instance: RuntimeInstance): Promise<InstanceEndpoint>;
  launchGrant(instance: RuntimeInstance): Promise<string>;
  stop(instance: RuntimeInstance): Promise<void>;
  state(instance: RuntimeInstance): Promise<RuntimeState>;
}
Context.instanceRuntime: InstanceRuntime
UserStateV2 = Omit<UserState, 'version' | 'lifecycle'> & { version: 2; runtime: RuntimeRef;
  instance: RuntimeInstance | null; lifecycle: UserState['lifecycle'] | 'quarantined';
  acquired: ('account' | 'storage' | 'policy' | 'network' | 'quota' | 'unit' | 'forwarder')[] }
```

- [ ] **1. 编写失败测试：** `legacy_records_keep_container_backend` 断言 `migrateUserState(v1).runtime.kind === "podman-gvisor"`；`backend_mismatch_refuses_start` 断言拒绝请求且 runner 调用次数为零；格式错误或未知版本拒绝解析，原文件不被改写。`capacity_refusal_allocates_nothing` 断言已验证用户超过容量时不分配账号/单元。已有容器生命周期测试仍通过。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- runtime.spec.ts config.spec.ts provisioning.spec.ts reconcile.spec.ts`；预期新接口缺失或迁移断言失败。

- [ ] **3. 实现** `state.ts` 中的 `migrateUserState(value: unknown): UserStateV2`、显式带标签的配置解析器，以及实现 `InstanceRuntime` 的容器适配器，通过 Cordis `apply` 提供者注册并管理服务清理。拒绝重复提供者。v2 持久化后端引用、启动 ID、分配端点及 `quarantined` 生命周期；取得每项资源后先记录再继续。保留现有 v1 读取器和结构历史供迁移审查。开通服务使用注入的服务；不导入提供者，也不自动迁移后端。

- [ ] **4. 验证** 定向测试及集成项目的 `typecheck`；预期通过。更新 JSDoc、README 双语文件，以及升级指南中的离线迁移前提；提交 `refactor: introduce explicit public Harness runtime providers`。

### 任务 2：本机账号、存储与受约束的服务单元

**文件：** 创建 `packages/runtime-systemd/{package.json,tsconfig.build.json,README.md,README.zh.md}`、`src/{config,accounts,storage,units,apparmor,limits}.ts`、`tests/{host-policy,storage}.spec.ts`；修改集成锁文件及 provisioner 的 `src/{accounts,storage,users}.ts`，支持各提供者的账号主目录与存储布局。

**接口：** 提供 `parseSystemdConfig(value: unknown): SystemdConfig`、`ensureNativeAccount(userId: UserId, config: SystemdConfig, runner: CommandRunner): Promise<AccountIdentity>`, `prepareHost(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`、`renderUnit(instance: RuntimeInstance, config: SystemdConfig): string` 和 `renderAppArmor(instance: RuntimeInstance, config: SystemdConfig): string`。`SystemdConfig` 管理工具、版本、控制与数据的绝对路径，CPU/内存/PID/文件句柄/字节/inode 限制，解析器和公网出站规则，端口范围及操作/就绪超时；拒绝未知字段、重叠范围和可写版本资源。

- [ ] **1. 编写失败测试：** `account_requires_no_linger` 断言不会调用 `loginctl`；`symlink_cannot_redirect_root_write` 断言目标文件内容与所有者保持不变且准备操作被拒绝。`unit_confines_descendants` 断言系统服务配置了 `User`/`Group`、强制执行的 AppArmor 配置、空 capabilities、`NoNewPrivileges`、完整 cgroup 停止、受保护的 proc 且不委派控制权限；所有可写路径都有字节/inode 限制或计入内存额度。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- host-policy.spec.ts storage.spec.ts`；预期提供者文件缺失或策略断言失败。

- [ ] **3. 实现** 已声明的主机函数，通过显式依赖使用现有 `CommandRunner`。账号密码保持锁定，使用 nologin，不授予管理或 SSH 权限。管理目录的上级路径由 root 拥有，通过不跟随链接的文件描述符创建用户顶层目录，绝不递归 chown/chmod 用户目录树。root 控制文件与用户令牌文件分开。AppArmor 子进程执行继承约束，拒绝访问其他用户文件和管理套接字，同时保留 Node JIT、PTY、编译器及无头浏览器能力。

- [ ] **4. 验证** 定向测试及集成项目的 `typecheck`；预期通过。在 README 双语文件中记录策略限制与专用 Linux 验证前提；提交 `feat: prepare confined systemd Harness accounts`。

### 任务 3：按 UID 限制网络并检查实际执行状态

**文件：** 创建 runtime-systemd 的 `src/{network,probe}.ts`、`tests/{network,probe}.spec.ts`；修改其 `config.ts` 和 README 双语文件。

**接口：** 提供 `installNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`、`removeNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>` 和 `verifyEnforcement(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`。最后一个函数拒绝 AppArmor 禁用/complain/配置缺失、cgroup 控制器或有效限制缺失、磁盘/inode 配额未启用；仅命令退出成功不够。

- [ ] **1. 编写失败测试：** `foreign_loopback_and_ipv6_are_denied` 断言仅允许自己的已分配端点；`established_flow_does_not_bypass_uid_policy` 拒绝禁止的已有连接；`atomic_update_preserves_host_rules` 在成功或失败时都保持无关表不变。`disabled_enforcement_refuses_prepare` 对每项缺失的必需保护都断言在用户进程启动前拒绝。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- network.spec.ts probe.spec.ts`；预期函数缺失或执行状态断言失败。

- [ ] **3. 实现** 自有 nftables 表的原子变更，按 UID 的限制先于通用连接状态放行。拒绝主机/私网/链路本地/元数据目的地、其他用户回环端口、未经允许的 IPv4/IPv6，以及外部直接连接任意用户监听器；只允许配置的 DNS/公网出站及自己的 Web/额度端口。检查内核和已挂载文件系统的实际限制，不仅检查生成的配置。

- [ ] **4. 验证** 定向测试及 `typecheck`；预期通过。记录 UDS 由文件权限和 AppArmor 保护，并说明清理失败后的隔离保留机制；提交 `feat: enforce native per-user network and resource policy`。

### 任务 4：无容器运行生命周期与就绪校验

**文件：** 创建 runtime-systemd 的 `src/{index,runtime}.ts`、`tests/lifecycle.spec.ts`；修改 provisioner 的 `src/{users,service,reconcile,token-channel,forwarder}.ts`、production 的 `src/provisioner-service.ts`、相应生命周期测试及 README 双语文件。

**接口：** 提供 `createSystemdRuntime(config: SystemdConfig, deps: SystemdRuntimeDeps): InstanceRuntime` 和 Cordis 的 `apply(ctx: Context, config: { configFile: string }): Promise<void>`。`SystemdRuntimeDeps` 提供现有 `CommandRunner`、`QuotaBridge` 及经过身份认证的 Web 探针 `(instance: RuntimeInstance, grant: string) => Promise<boolean>`；把额度实例 ID 在所有使用方迁移为共享品牌类型。注册 `ctx.instanceRuntime`；开通服务要求注入它。

- [ ] **1. 编写失败测试：** `parallel_ensure_starts_once` 断言只有一个服务单元/账号/额度授权；`spoofed_ready_never_publishes` 拒绝启动 ID/端口不匹配和未认证的 Web 就绪信息。`unknown_state_withholds_route` 不返回端点；`failed_stop_quarantines_allocation` 保留 UID/端口预留、撤销额度授权并关闭转发。`workspace_hooks_run_only_confined` 断言工作区初始化在安装策略之后且在受约束服务单元内执行。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- lifecycle.spec.ts runtime.spec.ts provisioning.spec.ts reconcile.spec.ts`；预期无容器用例失败。

- [ ] **3. 实现** 顺序为准备 → 受约束的 Git 初始化 → 额度授权 → Web 启动 → 实际限制/认证就绪校验 → 发布。复用私有 Unix 转发器，只连接记录中的端口。停止/恢复核对 systemd 和 cgroup 成员；暂停先禁止路由、撤销额度和转发，禁止该 UID 新建连接，再终止所有子进程；只有确认完整清理后才移除网络分配。空闲停止保留私有数据；删除要求确认、恢复期结束，以及确认清理完成后才释放账号/端口。部分启动从持久化资源记录重试。

- [ ] **4. 验证** 定向测试、集成构建/typecheck 及已有真实 Web 端到端测试；预期通过。按 CI 可靠性技能处理注入时钟、独占端口预留和清理。提交 `feat: integrate recoverable native Harness lifecycle`；Linux/公开运行就绪由部署任务 3 确认。
