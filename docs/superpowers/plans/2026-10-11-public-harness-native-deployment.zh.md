# 无容器 Harness 部署实施计划

[English](2026-10-11-public-harness-native-deployment.md) | 中文

> **供代理执行：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 组合无容器服务，并在真实主机证据批准具体版本前保持公开准入关闭。

**架构：** 无容器配置档组合运行和身份提供者，不要求容器组件。版本清单及执行限制证据按后端区分。专用 Linux 演练负责功能、对抗及恢复验证。

**技术栈：** TypeScript, Cordis profiles, Caddy HTTPS, systemd, AppArmor, nftables, XFS, Vitest.

**规格：** [已确认的无容器部署设计](../specs/2026-10-11-public-harness-native-design.zh.md)。

**依赖顺序：** 在[运行环境](2026-10-11-public-harness-native-runtime.zh.md)和[身份服务](2026-10-11-public-harness-native-identity.zh.md)之后执行。本机开发完成任务 1–2；任务 3 需要专用 Linux 测试主机。

## 全局约束

- 下列文件路径相对于 `integrations/public-harness/`；`docs/` 路径相对于仓库根目录。改动保留在独立插件和配置档中；Harness 会话格式与 `InstanceManager` 保持不变。

- 使用严格 TypeScript、带品牌类型的不透明 ID、ESM、导出文档、经过校验且可配置的部署参数，并由 `ctx.effect()` 管理生命周期。所有 Node 服务都通过 `dsh` 配置档启动。

- 本计划中的命令和断言描述待执行的检查及预期结果，不代表已经完成的部署证据。定向命令从仓库根目录执行；测试已构建模块的导入前先构建集成项目。

- 初始目标：专用 Ubuntu 24.04 LTS、cgroup v2、强制执行 AppArmor、nftables 及 XFS 字节/inode 配额。无容器隔离共享主机内核；本机替身或容器证据均不能批准它。

- 只有 Caddy 对外开放。路由、身份和额度服务分别使用服务 UID；仅开通服务执行有限的 root 操作。本范围不包含公开预览发布或隐藏官方模型页面。

## 审查重点

- 无 Podman/runsc/镜像的主机选择无容器模式：配置成功且不探测容器组件（任务 1）。
- AppArmor 为 complain、主机/策略/后端不匹配或证据不完整：注册准入保持关闭（任务 2–3）。
- 升级中断或结构无法向后兼容：保留数据并拒绝不安全回滚/迁移（任务 2）。
- 备份遗漏身份状态或把平台凭据放进用户归档：拒绝或修复备份（任务 2–3）。
- 恶意公开代码攻击文件、套接字、子进程、资源或网络：真实 Linux 检查必须拒绝（任务 3）。

---

### 任务 1：无容器配置档与主机配置

**文件：** 创建 `deploy/native/{README.md,README.zh.md,Caddyfile}`、`config/{identity,router,provisioner}.json.example`、`systemd/{dsh-identity,dsh-router,dsh-quota,dsh-provisioner}.service`、`systemd/{sysusers.d,tmpfiles.d}/dsh-public.conf`、`scripts/host-preflight.ts`；创建 production 的 `src/identity-service.ts`；修改 `deploy/production-profile.ts`、production 包导出、配置解析及 `tests/deploy-config.spec.ts`。

**接口：** 为 `writeProductionProfile` 扩展显式无容器组合与 `identity` 配置档；开通配置档先挂载选定的运行服务，再挂载使用方。提供 `preflightNativeHost(config: SystemdConfig): Promise<void>`，调用运行环境的实际状态探针。无容器配置要求 Better Auth 文件、工具/策略/限制/端点；容器配置只在自己的标签内保留 authentik/镜像/runsc 字段。

- [ ] **1. 编写失败测试：** `native_profile_omits_container_requirements` 断言没有 Podman/runsc/镜像也可生成有效配置档，且不调用引擎命令。`all_services_launch_through_dsh` 检查配置档入口；`private_services_are_not_public` 断言私有套接字及独立 UID。Caddy 保留精确来源/主机信息，不允许调用方请求头选择用户身份或上游。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- deploy-config.spec.ts production.spec.ts`；预期无容器组合断言失败。

- [ ] **3. 实现** 带标签的配置档组合、可信服务独立所有者/套接字授权、root 所有的只读版本资源，以及 Caddy 账号/认证/用户路径。加入支持主机、控制器、已加载策略、配额及目的地规则的预检。在 `deploy/native/systemd/` 提供 sysusers/tmpfiles 配置；默认关闭注册，并将特权安装列为运维人员的工作。

- [ ] **4. 验证** 定向测试、构建/typecheck 及已构建配置档启动检查；预期在没有容器工具时通过。在无容器 README 双语文件中记录待执行的 Linux 验证步骤、容量预留、主机更新和滥用处置职责；提交 `feat: compose native public Harness deployment profiles`。

### 任务 2：证据、备份与安全升级

**文件：** 修改 `deploy/{release-check,upgrade,dshctl}.ts`、`tests/{release-check,upgrade}.spec.ts`；创建 `deploy/native/scripts/{backup,restore}.ts`；修改无容器 README 双语文件及后端升级指南。

**接口：** 定义 `RuntimeRelease = { kind: "systemd"; policyDigest: string; toolchainDigest: string } | { kind: "podman-gvisor"; image: string }`；v2 `ReleaseManifest` 使用该标签，保留 Harness/插件版本、前一版本及关闭注册字段。定义 `NativeEvidence = { schema: 1; backend: "systemd"; hostId: NativeHostId; release: string; policyDigest: string; toolchainDigest: string; architecture: string; kernel: string; checks: Record<NativeCheck, "passed" | "failed">; verifiedAt: number }`；`NativeHostId` 使用品牌类型，从 root 管理的主机身份派生；`NativeCheck` 枚举部署任务 3 的检查项。提供 `validateNativeEvidence(manifest: ReleaseManifest, evidence: NativeEvidence, hostId: NativeHostId): void`；要求每项检查通过，并把证据绑定至实际主机/工具链/策略。

- [ ] **1. 编写失败测试：** `container_evidence_cannot_open_native_enrollment`、`stale_or_wrong_policy_stays_closed` 和 `missing_check_stays_closed` 断言拒绝准入。`legacy_manifest_is_container_only` 保留 v1 版本固定值。`interrupted_upgrade_keeps_user_data` 保留会话/工作区；`restore_requires_identity_database` 拒绝不完整备份；`restore_rejects_archive_paths` 对目录穿越/符号链接条目保持外部文件不变；身份/状态迁移不兼容时拒绝仅代码回滚。

- [ ] **2. 执行** `pnpm --dir integrations/public-harness test -- release-check.spec.ts upgrade.spec.ts`；预期新清单/证据断言失败。

- [ ] **3. 实现** 版本化严格解析器和按后端区分的准入校验器，证据有效期可配置。主机/策略/工具链/版本变化后批准失效。对身份 SQLite、开通/额度状态和私有用户数据做一致备份，可信密钥与用户归档分开。离线后端迁移要求备份、完整停止、恢复/演练及明确运维选择；不自动在线迁移。发布前先验证金丝雀的登录/模型/PTY/会话/插件流程。

- [ ] **4. 验证** 定向测试、构建/typecheck 及恢复样例；预期通过。记录迁移兼容性与删除恢复，更新升级指南并提交 `feat: gate native releases on backend-specific evidence`。

### 任务 3：专用 Linux 演练与公开准入

**文件：** 创建 `tests/native-linux.e2e.ts`、`tests/native-linux-fixture.ts`、`vitest.native.config.ts`、`deploy/native/scripts/rehearse.ts`；修改集成脚本、无容器 README 双语文件及 release-check 测试。

**接口：** 提供 `runNativeRehearsal(configFile: string): Promise<NativeEvidence>` 和显式 `test:native` 脚本。使用专用破坏性测试账号及自有防火墙表/路径/端口；记录清理失败并隔离保留。普通本机测试跳过真实主机套件；发布校验拒绝跳过的检查。绝不在开发 Mac 或任意共享 Linux 主机执行此套件。

- [ ] **1. 编写失败测试**，确认准入拒绝模拟/跳过证据，再编写生成以下 `NativeCheck` 值的真实主机用例。每项检查可观察操作实际允许或拒绝，不只检查配置文本。

| 检查 | 必须观察到的结果 |
| --- | --- |
| `tools` | 两位用户注册/登录并运行真实模型、shell、PTY、Git、依赖安装、语言服务器、浏览器、子代理及扩展；额度计入正确用户。 |
| `files` | 拒绝其他用户主目录/密钥、符号链接/路径替换及 UDS 管理访问。 |
| `processes` | 拒绝跨用户 proc/信号、setuid/capability 提权、cgroup 逃逸及插件移除策略；完整停止所有子进程。 |
| `network` | 拒绝其他用户回环端口、主机/私网/元数据、未经允许的 IPv6、已有禁止连接及外部任意监听器；配置的公网 DNS/出站和自己的端点正常。 |
| `resources` | 真实 CPU、内存、PID、字节及 inode 耗尽被限制，不影响另一用户实例。 |
| `recovery` | 重启、并发唤醒、部分开通、伪造就绪、未知 systemd 状态及清理失败保留数据，不开放不安全路由/分配。 |
| `failures` | AppArmor 禁用/complain/配置缺失，控制器、配额、身份/计费数据库或额度服务故障使准入关闭；已有认证连接按规定撤销。 |
| `upgrade-restore` | 备份/恢复、金丝雀升级及支持的回滚保留身份、会话、Git 和凭据；拒绝不兼容迁移或不完整备份。 |

- [ ] **2. 先执行** 本机 release-check 测试；预期缺失/跳过检查无法获得批准。有专用 Ubuntu 主机后运行新增 `test:native` 命令；预期尚未完成的无容器行为失败。如果没有主机，报告本任务待执行，保持公开准入关闭。

- [ ] **3. 实现** 显式启用的测试环境/证据写入器，在不削弱必需保护的前提下修复实测提供者/策略问题。证据绑定实际主机身份、架构/内核、策略/工具链/版本摘要和时间。允许公开准入前，对实际策略与测试结果进行公开服务安全审查。

- [ ] **4. 验证** 所有真实主机检查通过、恢复成功，并拒绝一份故意无效的证据样例；在运维记录中写明实际命令/结果。执行相关文档/构建检查及全分支审查，再提交 `test: verify native public Harness enforcement on Linux`。只为获批主机/版本开放注册；没有证据时仍属于部署限制。
