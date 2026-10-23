# 第 0 阶段结果 — 公司插件市场

[English](phase0-results.md) | 中文

[2026-10-23-plugin-market](2026-10-23-plugin-market.zh.md) 验证刺探记录。环境：Grok Bot 沙箱（uid 1000，无 root systemd 套接字单元、无生产 nft、无 pasta/runsc）。时间均为 Asia/Taipei。工具链：Node 22.23.3，`/home/box/.local/pnpm11/bin/pnpm` → **11.7.0**（仓库锁文件另钉 11.28.5）。

## P0.1 第二份 `--patch` 与 Settings 覆盖

**状态：** 完成（静态 + 代码路径替代；未要求完整 `dsh` profile 启动）

**发现：**
- `apps/cli/src/dump-config.ts` / `profile-boot.ts` 层序：bundle → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（argv 序）。**`--patch` 胜出。**
- Settings（`plugin-market` 的 `settings.update(..., { indexes })`）写入 profile 用户层，每次启动都会被市场 overlay 盖住。
- plugin-manager 的 registry 若在 profile patch 中，同样败给 `--patch`。

**通过标准：** 已满足（胜出方已记录）。完整 insert 启动留给 1B fixture。

## P0.2 pnpm 11 对回环注册表

**状态：** 完成（`127.0.0.1` 静态 fixture 注册表）

**发现：**
- 最小 Node 注册表提供 `@corp-dsh/tiny@1.0.0`，配合项目 `.npmrc` scope 映射可用。
- **锁文件会写入带端口的绝对 tarball URL：**
  `resolution: {integrity: sha512-…, tarball: http://127.0.0.1:4873/...}`
  并非「无 tarball / 端口无关」理想形态。内容寻址 store 在端口变更后仅当 blob **已在 store** 时能装上；**冷 store** 仍按锁文件旧端口拉取，会 `ECONNREFUSED`，即使 `.npmrc` 已改新端口。
- 仅设 `NPM_CONFIG_GLOBALCONFIG` 不会带上 scope 映射（仍打 npmjs）。scope 应写在项目/实例 npmrc；`--config.globalconfig=` 适合放认证，但本刺探未在服务端看到 `Authorization`（日志为 `noauth`）——镜像强制 bearer 时需复测。
- 对 1A/1B：坚持「每账户固定端口」（设计已有），或在端口重映射时改写锁文件；勿假设冷 store 下锁文件可跨端口。

**通过标准：** 满足并记下例外（私有注册表含 tarball URL）。

## P0.3 `bundleDependencies` 与 `--allow-build`

**状态：** 完成

**发现（pnpm 11.7.0）：**
- 默认安装：`[ERR_PNPM_IGNORED_BUILDS]`，依赖生命周期脚本**不跑**。
- `--config.dangerouslyAllowAllBuilds=true`：会跑**父包** `postinstall`；**嵌套** `bundleDependencies` 包脚本在 pnpm 下**不跑**（仅当文件解压）。
- 同一 tarball 用 `npm install` 会跑父包与嵌套 bundled 的 `postinstall`。
- 本环境仅 `--allow-build=<name>` 未能批准构建（产品侧应用 allowBuilds 精确旋钮留 1A）；此处 `dangerouslyAllowAllBuilds` 是可用的钝控。
- **设计输入：** pnpm bundle 模式不会执行嵌套 bundled 脚本；fallback 仍须用 allowBuilds 门控顶层脚本。若目标是带依赖且不跑其脚本，优先 bundle。

**通过标准：** 已满足。

## P0.4 Reconcile 临时单元标志

**状态：** 部分 — pnpm 标志**完成**；systemd slice / `IPAddressAllow` **blocked**

**发现：**
- 敌意 `.pnpmfile.cjs`（抛错）在无标志时安装失败；`--ignore-pnpmfile --config.userconfig=/dev/null` 下成功。
- 无 root / 无系统 systemd → 实例 slice 内 `systemd-run` + `IPAddressAllow=localhost` **blocked**。替代即上述 argv 证明；生产机仍须特权复验。

**通过标准：** 替代满足；特权部分 blocked。

## P0.5 容器 pasta 匹配与一次性 reconcile

**状态：** 部分 — 静态**完成**；真 pasta/runsc **blocked**

**发现：**
- 生产 README 与 `dsh-public.nft` 已用 `meta skuid`；原生 `network.ts` 使用 `ct mark set meta skuid`。配额经 pasta 主机回环可达是既有假设——市场可复用 skuid。
- provisioner 固定 `pasta:--map-host-loopback,<addr>,--no-splice`。
- `assertSafeRunArgv` 白名单：卷、精确 `--userns`、network 串、publish 范围、`--read-only`、`--cap-drop all`。**`assertSafeReconcileArgv` 草稿：** 同样禁止列表；更窄的卷（workspace + 市场快照）；无 publish；network 仍带 `--no-splice` 的 pasta；一次性命令白名单（仅 `pnpm` / `node` 入口）——1E 展开。

**通过标准：** 静态满足；真 pasta blocked。

## P0.6 git blob tarball 对比 `npm pack`

**状态：** 完成

**发现：**
- `npm pack` 遵守 `files` / `.npmignore`（省略密钥与 ignore 文件）。
- `git archive HEAD` 含整树（密钥与 ignore 仍在）。
- **镜像必须补齐：** blob/git 导出 ≠ npm pack；从 git 构建时要实现 pack 语义，或在干净 worktree 中调用 `npm pack`。

**通过标准：** 已满足（差距已记）。

## P0.7 空闲信号与 `installBundle({ enabled: false })`

**状态：** 完成（代码路径；未跑完整 HMR harness）

**发现：**
- `installBundle`：`enabled: false` 时不 `selectBundle`；reload 只发布已选行。
- `setBundleEnabled(name, true)` 会选中并 reload。
- 空闲信号短名单：agent `status: 'idle'`。sync 应门控在 agent idle（及设计约 5 分钟窗口），而非 LLM 流的 `idleWatchdog`。

**通过标准：** 进程内行为满足。

## P0.8 套接字单元 cgroup 与 `dsh_market` 加载器

**状态：** **blocked**（需 root + systemd）

**发现：**
- 有 cgroup v2，但不能装系统 socket 单元。
- 未实测 `init.scope` vs `system.slice/dsh-plugins.socket`。
- **未证伪设计** — 留待特权主机。1B 加载器模板保留两候选，主机结果出来前不把路径写死。

**通过标准：** blocked，仅有替代说明。

## P0.9 非特权服务上的 `inet_diag` peer 校验

**状态：** 部分 — `/proc/net/tcp` **完成**；精确 `inet_diag` 四元组**需正确打包**（非设计证伪）

**发现：**
- 非特权可成功 `socket(AF_NETLINK, SOCK_RAW, NETLINK_SOCK_DIAG)`。
- 初版四元组请求返回 `NLMSG_ERROR` errno **-2 (ENOENT)** — `inet_diag_sockid` 打包/字节序仍有误；**不能**据此断定 inet_diag 不可用。
- `/proc/net/tcp` 回退：回环上**可用**；200 次 accept 均值约 **855 µs/lookup**（fixture `docs/superpowers/plans/fixtures/p0-peer-check/proc-fallback.mjs`）。
- pasta 路径：**blocked**。配额已依赖 skuid；peer 校验仍为纵深防御。
- **禁止静默降级：** 1B 应落地经测试的 inet_diag，并保留 `/proc/net/tcp` 为文档化回退。不改设计定论。

**通过标准：** 回退已验证；inet_diag 可打开；精确查找留 1B。非停线证伪。

---

## 里程碑规划摘要

| 项 | 结果 | 阻塞 1A？ |
|------|--------|------------|
| P0.1 | `--patch` 胜出 | 否 |
| P0.2 | 锁文件可能嵌入 tarball+端口 | 影响镜像/锁策略 |
| P0.3 | 默认忽略构建；嵌套 bundled 脚本不跑 | 影响 bundle/fallback |
| P0.4 | pnpm 忽略标志 OK；systemd blocked | 1A 不阻塞 |
| P0.5 | skuid/pasta 可复用；真机 blocked | 1A 不阻塞 |
| P0.6 | git 须套用 npm pack 语义 | 影响镜像 |
| P0.7 | `enabled:false` + agent idle OK | 否 |
| P0.8 | cgroup **blocked** | 仅阻塞 1B 加载器定稿 |
| P0.9 | `/proc` OK；inet_diag 打包待补 | 不阻塞 1A |

**下一步：** 审查后开始里程碑 1A（`integrations/public-harness/packages/plugins/`）。特权 P0.8（及 pasta 下 P0.5/P0.9）在类生产机完成后再锁定 1B 防火墙模板。
