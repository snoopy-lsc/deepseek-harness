# 公司插件市场实现计划

[English](2026-10-23-plugin-market.md) | 中文

> **面向代理执行者：** 必用子技能 superpowers:executing-plans，按任务逐步落地。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 按[已定稿设计](../specs/2026-10-22-plugin-market-design.zh.md)交付公司插件市场：主机侧审过插件仓库、每用户回环监听、两条审计上架路径、默认安装推送与启动前 reconcile 兜底，一期同时覆盖原生与容器运行时。

**架构：** 非特权 `dsh-plugins` 持有 SQLite 目录与内容寻址仓，在每账户一个稳定回环端口上提供个性化 `index.json` 与只读 npm 注册表。套接字激活的 `dsh-plugins-fetch@` 仅经 `dsh-plugins-egress` 拉源。provisioner 写入第二份 `--patch` 与每实例 npmrc，加载独立 `dsh_market` nft 表，并跑启动前 reconcile。实例内 `public-harness-plugin-sync` 推送默认插件（先禁用安装、再核对、再启用）。上游 Discover、`pluginMarket`、`plugin_manager` 不改。

**技术栈：** TypeScript（Node 22 + pnpm 11）、Cordis、SQLite、systemd 套接字激活、nftables、Vitest。原样使用上游：`packages/util/plugin-market-index`、`packages/boot/plugin-market`、`packages/client/ui-plugin-market`、`packages/experimental/plugin-market-bundle`、`apps/plugin-market-generator`、`packages/boot/plugin-manager`。主机服务模式对齐 `dsh-quota` / `dsh-kb`（`integrations/public-harness/packages/{quota,kb,production,runtime-systemd}`）。

**规格：** [公司插件市场设计](../specs/2026-10-22-plugin-market-design.zh.md)（开放问题 1–9 已于 2026-10-23 确认）。

**分支 / worktree：** `codex/plugin-market-impl`，路径 `.worktrees/plugin-market-impl`。禁止推送 `master`、force-push、`--no-verify`、开 PR。

## 全局约束

- 仅用 Node 22（`/home/box/.local/node22/bin`）与 pnpm 11（`/home/box/.local/pnpm11/bin`）。禁用系统 Node 20。设置 `NODE_OPTIONS=--max-old-space-size=3072`。优先包级测试；不构建 5GB 生产镜像。
- 不读、不打印密钥（`/home/box/.config/gh/hosts.yml`、模型密钥、令牌）。测试用 mock。模型密钥仅经环境变量 `DSH_MODEL_API_KEY`，禁止落盘或打印。
- 仅绑定 `127.0.0.1` 或 Unix 套接字。测试与刺探不得开公网监听。
- 只推 `codex/plugin-market-impl`（设计需跟进时亦可推 `codex/plugin-market-design`）。禁止 force-push、`--no-verify`、开 PR、改写历史。
- UI 复用现有 `admin-kit` / 上游客户端形态；不改按钮图标、颜色或形状。
- 已知环境失败（勿当回归）：`http-proxy` `install.spec`(1)、`matcher-parity.spec`(6)、`gen-dependency-catalog.spec`(1)、`test:docs` 中 uv.lock commit-hash(1)。负载下偶发需单独重跑再定责：`ptc-runtime-python`、`llm-deepseek`、`scripts/persistence-schema`。
- 合入 master 前，代码审查须明确说「可以合并」。
- `integrations/public-harness/` 下路径相对该树，除非带前缀。设计与计划路径相对仓库根。
- 第 0 阶段是探索验证，不是产品代码。每项结果写入 `docs/superpowers/plans/phase0-results.md`（及 `.zh.md`）。需要 systemd / nft / pasta / root 而本机不具备的，标 **blocked** 并写最小替代验证；不得假装通过。若第 8/9 项证伪设计假设，停下汇报——不得擅自改设计定论。

## 审查重点

- 第 0 阶段：`indexes` / registry 哪层胜出；pnpm 锁文件与 `bundleDependencies`；监听 cgroup；非特权服务上的 `inet_diag`。
- 1A：egress SSRF 与白名单；`name@version` 不变量；批准绑定 `expected_artifact_sha512`；ready 产物不重写。
- 1B 起：端口归属 + peer 校验；sync 先禁用安装再启用；仅从 sync-log 判定已退出。

---

## 第 0 阶段：验证刺探

结果文件：`docs/superpowers/plans/phase0-results.md`（+ `.zh.md`）。下列每项为可勾选任务。

### 任务 P0.1：第二份 `--patch` 与 Settings 覆盖

**目的：** 确认第二份原生 `--patch`（`insert` 挂载 `plugin-market`、`ui-plugin-market`、stub sync）可用，以及用户在 Settings 改 `indexes` / registry 时哪层胜出（CLI 在 profile 之后应用 patch：`apps/cli/src/args.ts`）。

**步骤：**
- [ ] 阅读 `apps/cli/src/args.ts` 的 patch 顺序与 Cordis patch 合并行为；记录 `plugin-market.indexes` 与 plugin-manager `registry` 的胜出方。
- [ ] 写最小 fixture patch YAML（三行 `insert`）；经 `dsh` 或 CLI 参数助手应用到 `/tmp/dsh-p0-1/` 临时 profile。
- [ ] 改 profile 自带 `cordis.patch.yml`（或等价 Settings）为不同 `indexes`；再应用市场 patch；记录生效值。

**通过：** 写明 `indexes` 与 `registry` 胜出方；insert 无错加载。**blocked：** 无法完整拉起 profile 时，以 `args.ts` 静态分析 + 重放合并的单测为替代。

**记录：** `phase0-results.md` §P0.1。

### 任务 P0.2：pnpm 11 对回环注册表

**目的：** 锁文件在端口变化后仍用标准 tarball 路径；`NPM_CONFIG_GLOBALCONFIG` 供认证；`@deepseek-ai/dsh*` peer 行为；重打包公名在 npmrc 有/无 `registry=` 下的 repair。

**步骤：**
- [ ] 起一个回环 npm 注册表（verdaccio 或静态 fixture，`127.0.0.1`）提供一带 scope 与一公名包。
- [ ] 带 scope 映射与 `NPM_CONFIG_GLOBALCONFIG` 跑 `pnpm install`；检查 `pnpm-lock.yaml` 的 tarball URL。
- [ ] 改注册表端口后重装；确认仍可装。
- [ ] 向镜像发重打包公名；分别在有/无 `registry=` 的全局 npmrc 下做 repair。

**通过：** 锁文件无 tarball URL（或记下例外）；globalconfig 认证可用；两种 npmrc 的 repair 行为有记录。**blocked：** verdaccio 过重则用 `docs/superpowers/plans/fixtures/p0-registry/` 静态 fixture。

**记录：** `phase0-results.md` §P0.2。

### 任务 P0.3：`bundleDependencies` 与 `--allow-build`

**目的：** pnpm 11 能否装带 `bundleDependencies` 的产物；`allowBuilds` / `--allow-build` 是否约束带脚本的 bundled 包；默认不允许的构建不执行。

**步骤：**
- [ ] 在 `/tmp/dsh-p0-3/` 做两个 fixture tarball：一带 `bundleDependencies` 无脚本；一带有 `postinstall` 写标记文件的 bundled 依赖。
- [ ] 有/无 `--allow-build=<bundled>` 安装；观察标记与退出码。
- [ ] 确认默认（无 allow）不跑依赖构建。

**通过：** 明确 bundle 模式能否托管带脚本依赖；默认拒绝构建。结果供设计回退模式决策。

**记录：** `phase0-results.md` §P0.3。

### 任务 P0.4：Reconcile 临时单元标志

**目的：** 实例 slice 内临时单元与 `IPAddressAllow=localhost`；`--ignore-pnpmfile` 与 `--config.userconfig=/dev/null` 生效。

**步骤：**
- [ ] 静态审阅 `runtime-systemd` 中 `initializeWorkspace` / `systemd-run`。
- [ ] 有 root/systemd 时：`systemd-run --wait --collect` 带计划标志跑 `pnpm config get userconfig` 与会抛错的 `.pnpmfile.cjs`。
- [ ] 无 systemd 时：按计划 argv 在含敌意 `.pnpmfile.cjs` / `.npmrc` 的临时目录跑 pnpm，断言被忽略。

**通过：** 敌意 pnpmfile/userconfig 无法改安装。无 root 时全量 slice/`IPAddressAllow` 标 **blocked**。

**记录：** `phase0-results.md` §P0.4。

### 任务 P0.5：容器 pasta 匹配与一次性 reconcile

**目的：** pasta 下 `meta skuid . tcp dport`；一次性 reconcile `runsc` 容器形态。

**步骤：**
- [ ] 静态审阅 `deploy/production/nftables/dsh-public.nft` 与 provisioner 的 pasta 标志（含 `--no-splice`）。
- [ ] 有 pasta/runsc：最小监听+连接并看 nft 计数；否则 **blocked**。
- [ ] 由 `assertSafeRunArgv` 差分起草 `assertSafeReconcileArgv` 白名单。

**通过：** 写明 skuid 匹配是否已为配额所用（是则可复用）。reconcile argv 白名单有草稿。

**记录：** `phase0-results.md` §P0.5。

### 任务 P0.6：git blob tarball 对比 `npm pack`

**目的：** 由 git blob 打的包是否与 `npm pack`（`files` / `.npmignore`）装出相同文件。

**步骤：**
- [ ] 用小 fixture 仓库（或仓内样例）；同 commit 上 `npm pack` vs 树 blob 自打 tar。
- [ ] 分别装入空目录；对比文件列表。

**通过：** 差分空，或记下镜像必须补齐的差距。

**记录：** `phase0-results.md` §P0.6。

### 任务 P0.7：空闲信号与 `installBundle({ enabled: false })`

**目的：** 可用于 sync 的空闲信号；`enabled: false` 时 HMR 路径不启动插件。

**步骤：**
- [ ] 在 Cordis / agent 运行时中搜 idle / turn-running；短名单一个。
- [ ] 单测或 harness：`installBundle(spec, { enabled: false })` 在 HMR mock 下不断言启动；再 `setBundleEnabled(name, true)` 才启动。代码：`packages/boot/plugin-manager/src/index.ts`（`enabled !== false`、`setBundleEnabled`）。

**通过：** 选定空闲信号名；进程内确认禁用安装行为（无需完整 UI）。

**记录：** `phase0-results.md` §P0.7。

### 任务 P0.8：套接字单元 cgroup 与 `dsh_market` 加载器

**目的：** systemd INET 监听落在哪个 cgroup（`init.scope` vs `system.slice/dsh-plugins.socket`）；`ExecStartPost` 加载器；套接字重启后是否需重载。

**步骤：**
- [ ] 有 root+systemd：起带 `ListenStream=127.0.0.1:<free>` 的小 socket 单元；读 cgroup；用各候选路径加载玩具 nft 链。
- [ ] 重启 socket 单元；看 `socket cgroupv2` 是否仍匹配。
- [ ] 无 root：**blocked**；仅记录 BPF/netfilter 提示（非通过）。

**通过：** 选定 cgroup 路径写入加载器模板说明。**若假设错误：** 停报，勿先写 1B。

**记录：** `phase0-results.md` §P0.8。

### 任务 P0.9：非特权服务上的 `inet_diag` peer 校验

**目的：** 精确四元组 `NETLINK_SOCK_DIAG` 在 `127.0.0.1`（及可用时的 pasta）返回对端 UID；每 accept 成本；`/proc/net/tcp` 回退成本。两者皆不可用 → 一期前须用户决策。

**步骤：**
- [ ] 在 `docs/superpowers/plans/fixtures/p0-peer-check/` 写小 Node 脚本：回环监听、accept、经 netlink（或小原生辅助）查 peer UID；尽量在非特权约束下跑。
- [ ] 基准 1k 次 accept。
- [ ] 实现 `/proc/net/tcp` 回退并基准。
- [ ] pasta 路径：无 pasta 则 **blocked**；注明配额已依赖 skuid 身份。

**通过：** 写明可用方法与 µs/accept。**两者皆失败：** 停下；按设计风险变更上报（禁止静默降级）。

**记录：** `phase0-results.md` §P0.9。

---

## 里程碑 1A：仓库与镜像（TDD）

包落点：`integrations/public-harness/packages/plugins/`（新建）。入口：`integrations/public-harness/packages/production/src/plugins-service.ts`、`plugins-fetch.ts`、`plugins-egress.ts`。布局对齐 `packages/kb` + `packages/quota`。

### 任务 1A.1：Schema、部分索引、迁移

**文件：** 创建 `packages/plugins/{package.json,tsconfig.json,src/{schema.ts,db.ts,migrate.ts,ids.ts},tests/schema.spec.ts,README.md,README.zh.md}`。表按设计：`plugin_package`、`plugin_version`、`plugin_artifact`、`plugin_closure`、`plugin_endpoint`、`plugin_default*`、`plugin_policy`、`dsh_plugin_limit`、`plugin_audit_outbox`，以及 package 上的 `claimed_at`。

- [ ] **1. 写失败测试：** `name@version` 唯一；每包至多一个 pending（部分唯一）；拒绝/撤回/过期后可重提；首版从未批准时释放包名。
- [ ] **2. 跑** `pnpm --dir integrations/public-harness/packages/plugins test -- schema.spec.ts`；预期失败。
- [ ] **3. 实现** 迁移与助手。
- [ ] **4. 验证** 通过；提交 `feat(plugins): catalogue schema and migrations`。

### 任务 1A.2：Egress 代理与 SSRF 检查

**文件：** 创建 `packages/plugins/src/egress/{server.ts,policy.ts,ranges.ts}`、`tests/egress.spec.ts`；`production/src/plugins-egress.ts`；原生单元草稿 `deploy/native/systemd/dsh-plugins-egress.service`（安装放到 1B）。

**接口：** `startEgressProxy({ listen: '127.0.0.1', port, allow, intranet, fetchUidOnly: true })`。仅连已校验 A/AAAA；除非 intranet 拒绝 IP 字面量；IPv6 段按设计。

- [ ] **1. 写失败测试：** 禁 IPv4/IPv6、DNS 重绑定、IP 字面量、重定向到未列主机、非白名单主机。
- [ ] **2. 跑** 聚焦 egress 测试；预期失败。
- [ ] **3. 实现** CONNECT 代理。
- [ ] **4. 验证** 通过；提交 `feat(plugins): allowlisting egress CONNECT proxy`。

### 任务 1A.3：Fetch 服务动词

**文件：** 创建 `packages/plugins/src/fetch/{server.ts,verbs.ts,framing.ts}`、`tests/fetch-verbs.spec.ts`；`production/src/plugins-fetch.ts`；套接字单元说明留给 1B。

**接口：** 动词 `npm-version`、`git-commit`、`upload-check`、`closure`、`artifact`，参数白名单；KB-helper 成帧。

- [ ] **1. 写失败测试：** 未知动词、多余参数、路径 `..`、非 SemVer 在联网前拒绝。
- [ ] **2. 跑** 测试；预期失败。
- [ ] **3. 实现** 成帧 + 白名单（网络调用 mock）。
- [ ] **4. 验证** 通过；提交 `feat(plugins): socket-activated fetch verbs`。

### 任务 1A.4：镜像流水线（npm + 上传）

**文件：** 创建 `packages/plugins/src/mirror/{resolve.ts,closure.ts,scripts.ts,artifact.ts,store.ts}`、`tests/mirror.spec.ts`。

**接口：** `mirrorVersion(source) -> { artifactSha512, mode: 'bundle' | 'fallback', closure }`；非 SemVer 依赖在 pnpm 前拒绝；检测安装脚本；`ready` 冻结；批准时 `expected_artifact_sha512` 比较（批准 API 在 1C——比较助手放此处）。

- [ ] **1. 写失败测试：** integrity 不符；git/URL/`file:` 依赖 → `closure-source`；脚本检测矩阵；ready blob 永不重写；按 P0.3 选 bundle/fallback。
- [ ] **2. 跑** 测试；预期失败。
- [ ] **3. 用 fixture 实现；真实 pnpm 仅放串行集成测。
- [ ] **4. 验证** 通过；提交 `feat(plugins): mirror pipeline with pinned artifacts`。

### 任务 1A.5：管理员上传 + 审计 outbox（路径 B 核心）

**文件：** 创建 `packages/plugins/src/{upload.ts,audit.ts}`、`tests/upload.spec.ts`。公司 scope `@corp-dsh/` 强制。

- [ ] **1. 写失败测试：** 拒绝非 `@corp-dsh/` 的 git/上传；`version-exists`；写入 `admin-plugin-upload` outbox 行。
- [ ] **2. 跑** 测试；预期失败。
- [ ] **3. 实现** 调镜像的上传路径。
- [ ] **4. 验证** 通过；提交 `feat(plugins): admin upload with company scope and audit`。

**1A 出口：** schema + egress + fetch 动词 + 镜像 + 管理员上传测试全绿；尚不要求装 systemd。

---

## 里程碑 1B：对外服务（TDD）

包落点仍为 `integrations/public-harness/packages/plugins/`。systemd 单元在 `integrations/public-harness/deploy/native/systemd/`。防火墙 / probe 在 `packages/runtime-systemd/`。**不要**宣称 P0.8 systemd cgroup 结果（仍 blocked）；peer 校验用 P0.9 方法，带回 `/proc/net/tcp`。P0.1：`--patch` 覆盖 Settings。

### 任务 1B.1：端口、令牌、HTTP 路由

**文件：** 创建 `packages/plugins/src/{listen.ts,routes.ts,token.ts}`、`tests/serving.spec.ts`（可拆分）。

**接口：** `validateMarketPorts` / `openEndpoint` / `closeEndpoint`（端口↔用户 1:1，上限 `MAX_PLUGIN_ACCOUNTS` = 4096）；`mintMarketToken` + 对 `token_sha256` 的恒定时间 bearer 比较；`startMarketHttpServer({ host: '127.0.0.1', port, ... })` 提供 `GET /index.json`、`GET /npm/<name>`、`GET /npm/<name>/-/<basename>-<version>.tgz`（响应体可先 stub；真正索引构建在 1B.3）。仅回环。

- [ ] **1. 写失败测试：** 端口分配唯一性与 4096 上限；拒绝非 `127.0.0.1` 监听；bearer 拒绝/接受；路由基本 404/200 形态。
- [ ] **2. 跑** `pnpm --dir integrations/public-harness/packages/plugins test -- serving.spec.ts`；预期失败。
- [ ] **3. 实现** listen / routes / token。
- [ ] **4. 验证** 通过；提交 `feat(plugins): per-user market ports tokens and routes`。

### 任务 1B.2：对端 UID 校验

**文件：** 创建 `packages/plugins/src/peer-check.ts`、`tests/peer-check.spec.ts`。

**接口：** `lookupPeerUid(socket)` 走 `NETLINK_SOCK_DIAG` `inet_diag`，`/proc/net/tcp` 回退（P0.9）；accept 时在读字节前拒绝异 uid / 未映射端口 / 查找失败。不宣称 systemd cgroup 结果（P0.8 仍 blocked）。

- [ ] **1. 写失败测试：** 匹配 uid 接受；异 uid / 未映射 / 查找失败关闭；用 fixture 表覆盖回退路径。
- [ ] **2. 跑** 聚焦 peer-check 测试；预期失败。
- [ ] **3. 实现** peer-check 并接入 listen accept。
- [ ] **4. 验证** 通过；提交 `feat(plugins): inet_diag peer uid check on accept`。

### 任务 1B.3：索引构建

**文件：** 创建 `packages/plugins/src/index-builder.ts`、`tests/index-builder.spec.ts`。

**接口：** `buildPersonalizedIndex(db, userId, groups)` — 可见性 scope → 个性化 `index.json`（KB-view 风格）；按 digest 缓存；skill 不进索引（二期）。

- [ ] **1. 写失败测试：** company vs group scope；已下架省略；generation / groups 变化使 digest 失效。
- [ ] **2. 跑** 测试；预期失败。
- [ ] **3. 实现** 构建器；把 `GET /index.json` 接到它。
- [ ] **4. 验证** 通过；提交 `feat(plugins): personalized market index builder`。

### 任务 1B.4：市场防火墙渲染 + probe（单元测试）

**文件：** 创建 / 修改 `packages/runtime-systemd/src/{market-firewall.ts,probe.ts}`，并接入 `network.ts`。

**接口：** 渲染 `inet dsh_market` 表文本 + `in_<uid>` 中的 owner accept；表/链缺失时 probe 自愈；同一锁下 `market_owner` 与 endpoint 行集合精确相等。**不要求 root** — 用 fixture 断言渲染出的 nft/文本与 probe 逻辑。

- [ ] **1. 写失败测试：** 渲染的表/集合/链文本；缺表自愈；多余元素删除；缺失元素补上；锁串行化比较+变更。
- [ ] **2. 跑** 聚焦 runtime-systemd 市场测试；预期失败。
- [ ] **3. 实现** 渲染 + probe 助手（仅 fixture）。
- [ ] **4. 验证** 通过；提交 `feat(runtime-systemd): market firewall render and probe`。

### 任务 1B.5：单元、合约、provisioner 补丁

**文件：** 创建 `deploy/native/systemd/{dsh-plugins.socket,dsh-plugins.service,dsh-plugins-fetch.socket,dsh-plugins-fetch@.service,dsh-plugins-egress.service}`；在 `packages/contracts/src/web-rows.ts` 增加 `pluginMarketRows`；provisioner 写 `instance-market/<account>.{yml,npmrc}`；配置拒绝重叠 / `ports.market` > 4096。

- [ ] **1. 写失败测试：** 单元文件内容（`LimitNOFILE=16384`、`AF_NETLINK`、`ListenStream=127.0.0.1`）；`pluginMarketRows` 形态；配置重叠与 >4096 拒绝；npmrc / patch 写入。
- [ ] **2. 跑** 聚焦测试；预期失败。
- [ ] **3. 实现** 单元、合约、provisioner 写入/校验。
- [ ] **4. 验证** 通过；提交 `feat(plugins): systemd units contracts and market patches`。

**1B 出口：** serving + peer-check + index + 防火墙渲染/probe + 单元/合约测试全绿；不要求 root 装 systemd（P0.8 仍 blocked）。

## 里程碑 1C：评审流（TDD）

包仍在 `integrations/public-harness/packages/plugins/`。Identity 网关在 `packages/identity/`。管理 UI 在 `packages/ui/src/client/`（沿用 admin-kit）。状态迁移表见设计文档「上架流程」一节（约 410–440 行）。路径 B 上传已在 1A.5；本里程碑负责路径 A 提交/批准与上架操作。

### 任务 1C.1：提交 + 所有权 + 包名释放

**文件：** 创建 `packages/plugins/src/submit.ts`、`tests/submit.spec.ts`；从 `index.ts` 导出。

**接口：** `submitPluginVersion` / `withdrawSubmission` / `expireSubmission` — 未归属 `@corp-dsh/` 包名的首个版本写入 `owner_user_id`（占住；`claimed_at` 仍为 NULL，批准时再设）；每包至多一个 pending；对未归属首版本的撤回（提交者）/过期（系统）/驳回（1C.2 前可用状态辅助）调用 `releaseUnclaimedName`；后续版本对非所有者 403 `not-owner`（管理员可提交）；另有 409 `pending-exists`、`version-exists`、`limit-reached`、`name-taken`（被他人占住）。镜像保持 `queued`（fetch 稍后跑）。

- [ ] **1. 写失败测试：** 首版本占名；pending 唯一；撤回/过期/驳回后可重提并释放包名；拒绝外人民所有权；公司 scope。
- [ ] **2. 跑** `pnpm --dir integrations/public-harness/packages/plugins test -- submit.spec.ts`；预期失败。
- [ ] **3. 实现** `submit.ts`（含导出），复用 1A.1 schema 辅助。
- [ ] **4. 验证** 通过；提交 `feat(plugins): plugin submit ownership and name release`。

### 任务 1C.2：批准 / 驳回（路径 A）

**文件：** 创建 `packages/plugins/src/approve.ts`、`tests/approve.spec.ts`。

**接口：** `approveSubmission` / `rejectSubmission` — 批准需 `expected_artifact_sha512`（409 `artifact-mismatch` / `mirror-not-ready` / `install-scripts`）；403 `self-approval`；写 `reviewed_by` / `reviewed_at`；首次批准设 `claimed_at`；上架指针：高于当前 → 成为 current 且旧版进 `previous_version_id`，否则仅进历史。

- [ ] **1. 写失败测试：** sha512 绑定、自批拒绝、mirror-not-ready、install-scripts 白名单、listing current/previous、驳回后 `not-pending`。
- [ ] **2. 跑** 聚焦 approve 测试；预期失败。
- [ ] **3. 实现** 批准/驳回；复用 1A.4 的 `compareExpectedArtifactSha512`。
- [ ] **4. 验证** 通过；提交 `feat(plugins): path A approve reject and listing pointers`。

### 任务 1C.3：上架操作

**文件：** 创建 `packages/plugins/src/{listing.ts,visibility.ts}`、`tests/listing.spec.ts`。

**接口：** `changeScope` / `delistPackage` / `relistPackage` / `rollbackListing` / `revokeVersion` — 改写 scope；下架保留 scope 行且原范围仍可镜像；重新上架清 `delisted_at`；按指针规则回滚（409 `no-previous`）；吊销非当前从 packument/索引移除，吊销当前则回滚或以下架原因 `revoked` 下架。

- [ ] **1. 写失败测试：** scope 变更可见性；下架/重新上架；回滚指针；吊销当前 vs 非当前。
- [ ] **2. 跑** 聚焦 listing 测试；预期失败。
- [ ] **3. 实现** listing + visibility；必要时接入 index builder。
- [ ] **4. 验证** 通过；提交 `feat(plugins): listing scope delist rollback revoke`。

### 任务 1C.4：Identity 网关

**文件：** 创建 `packages/identity/src/plugins-gateway.ts`、`tests/plugins-gateway.spec.ts`（对照 `kb-gateway.ts`）。

**接口：** `PLUGIN_ADMIN_ENDPOINTS`、`PLUGIN_REAUTH`、`PLUGIN_EVENTS`（及所需 me 端点）；批准/上传/scope/回滚/下架/吊销需 reauth；转发到 plugins 控制 socket 并带 `x-dsh-user` / role；抽干 `plugin_audit_outbox`。

- [ ] **1. 写失败测试：** 端点表；reauth 集合；转发剥离密码；审计抽干过滤 `PLUGIN_EVENTS`。
- [ ] **2. 跑** 聚焦 identity 测试；预期失败。
- [ ] **3. 实现** 网关并挂到 admin/me 路由。
- [ ] **4. 验证** 通过；提交 `feat(identity): plugins admin gateway with reauth`。

### 任务 1C.5：管理端 + 我的插件 UI

**文件：** 创建/修改 `packages/ui/src/client/admin-plugins*.tsx` 与个人 **我的插件** 页；复用 `admin-kit` 的 `Card` / `Row` / `useReauth` / field 辅助。保持现有按钮、图标与组件形态。

**界面：** 系统管理 > 插件市场 — 评审队列、已上架、上传、默认、策略、限额（API 未齐时可 stub）。个人 > 我的插件 — 提交、撤回、申请下架。

- [ ] **1. 写失败测试 / 冒烟：** 路由用 admin-kit 原语渲染；批准/上传/scope/回滚/下架/吊销动作挂 reauth。
- [ ] **2. 跑** 聚焦 UI / identity 页面测试；预期失败。
- [ ] **3. 实现** 最小页面，对齐现有 identity 管理 UI 模式。
- [ ] **4. 验证** 通过；提交 `feat(ui): plugin market admin and my-plugins pages`。

**1C 出口：** 迁移表每行 + 拒绝码有测；部门可见性；批准/上传/scope/回滚/下架/吊销需 reauth；管理端与「我的插件」页就位。

## 里程碑 1D：默认与更新（大纲）

**创建 / 修改：**
- `packages/plugin-sync/` — `public-harness-plugin-sync`；sync-log；`enabled:false` 安装 → 再核对 → `setBundleEnabled`；用户移除规则。
- reconcile 入口 + provisioner 启动前单元（标志取自 P0.4）。
- 快照在 `~/.dsh-market/snapshots/`。

**验收：** CLI/手改卸载不重装；移除+安装失败可恢复；integrity 不符永不启用；空闲门控用 P0.7 信号。

## 里程碑 1E：策略、限额、容器（大纲）

**创建 / 修改：**
- 将 `packages/kb/src/limits.ts` 的 `effectiveLimits` 推广到限额名；`dsh_plugin_limit`。
- `market_only` / `install_scripts` 策略；`market_only` 时 npmrc `registry=`。
- `deploy/production/nftables/{dsh-public.nft,dsh-market.nft}`；provisioner `webPatch` + 市场卷；一次性 reconcile 容器（P0.5）。
- README 记录市场端口防火墙破例（已定稿 Q7）。

**验收：** `market_only` 下非市场 registry 规格失败关闭且不依赖 egress_lock；容器属主可达 + 跨租户拒绝；降限额不删数据。

## 二期（本计划不写编码任务）

签名；纯 skill 视图；可选 `egress_lock`。

---

## 执行顺序

1. 完成第 0 阶段 P0.1–P0.9，填 `phase0-results.md`。若 P0.8/P0.9 证伪假设则停下。
2. 按序做里程碑 1A。
3. 按序做里程碑 1B（大纲已于 2026-10-23 展开）。按序做里程碑 1C（大纲已于 2026-10-23 展开）。1C 审查后再把 1D–1E 大纲展开。
4. 每项绿提交后推 `codex/plugin-market-impl`。合 master 前等「可以合并」。
