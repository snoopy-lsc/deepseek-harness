# 公司插件市场设计

[English](2026-10-22-plugin-market-design.md) | 中文

## Summary

本文是供评审的设计说明，不含实现代码。它为[原生公开 Harness 部署](2026-10-11-public-harness-native-design.zh.md)及其容器（production）运行时增加公司插件市场。它扩展上游已有的插件市场，而不是替换它：[索引格式 1](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)、[Discover 说明](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md)中描述的 Host `pluginMarket` 服务和 Web **Discover** 标签页，以及[插件安装 registry 说明](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md)中的 registry 计划。不修改任何上游包。

新的非特权主机服务 `dsh-plugins` 维护经过审核的插件目录。独立的 socket 激活拉取服务只能通过新建的白名单出网代理访问网络，它把每个获批版本连同审核过的依赖闭包打成一个固定的产物，镜像到按内容寻址的公司存储中。每个用户在一个由 systemd 为 `dsh-plugins` 持有的端口段中拥有一个固定的回环端口。两种运行时的防火墙都只允许该用户的账户访问这个端口，并且只有 `dsh-plugins` 能在其上接收连接。监听端口提供个性化的 `index.json`（按可见范围计算，做法与[知识库设计](2026-10-17-llm-wiki-knowledge-base-design.zh.md)计算 KB 视图相同），以及一个只包含获批产物的只读 npm registry。实例防火墙对内网保持关闭。

插件通过两条路径进入目录：用户提交、由另一位管理员审批并选择可见范围（复用 KB 共享审批流程）；或管理员在"系统管理"中直接上传上架。每一步都写入审计事件，并且都可以回滚。用户通过所有现有路径自行安装和更新插件。管理员可按部门或全公司设置默认安装。默认插件的新获批版本由实例内的小型同步插件推送到运行中的实例，启动前对账作为兜底。按已定需求，签名校验放在二期。

## Contents

- [目标与非目标](#goals-and-non-goals)
- [需求对照](#requirements-mapping)
- [现有系统事实](#current-system-facts)
- [架构概览](#architecture-overview)
- [包类型与索引扩展](#package-kinds-and-index-extensions)
- [数据模型](#data-model)
- [存储、出网与镜像](#store-and-mirror)
- [为实例提供服务](#serving-instances)
- [上架流程与状态机](#listing-flows)
- [安装与策略](#installation-and-policy)
- [默认安装、同步与对账](#default-installs)
- [更新与回滚](#updates-and-rollback)
- [API 列表](#api-list)
- [权限与审计](#permissions-and-audit)
- [插件限额](#plugin-limits)
- [系统管理界面](#system-admin-ui)
- [部署改动](#deployment-changes)
- [以后增加公共市场](#public-market-later)
- [风险与未验证项](#risks-and-unverified-items)
- [测试计划](#test-plan)
- [分阶段实施计划](#phased-implementation-plan)
- [开放问题与推荐默认值](#open-questions)
- [来源](#sources)

<a id="goals-and-non-goals"></a>
## 目标与非目标

### 目标

- 部署内的公司市场，显示在现有 Discover 标签页中，每个用户的索引由主机按部门和全公司范围计算。
- 只允许固定且经过审核的版本：npm 版本固定精确版本号和完整性哈希，git 来源固定精确提交，依赖闭包固定为审核时的 lockfile，每个新版本都要重新审核。
- 市场安装时实例从不访问内网或上游 registry，只从它自己的回环监听端口获取。
- 两条上架路径，都有审计、都可回滚。
- 按部门或全公司的默认安装，用户可以卸载；默认插件的新获批版本自动推送。
- 所有现有安装路径继续可用：`dsh plugin add`、插件页面、`plugin_manager` 工具和手动 URL。
- 对每用户插件数和提交存储设限，复用 `dsh_kb_limit` 的三级限额规则。
- 为以后增加公共市场留出空间，不需要改数据模型。

### 非目标

- 一期不做签名校验；它在二期。
- 不做用户无法卸载的强制安装；以后再做。
- 不自动更新用户手动安装的插件。
- 不修改上游包：索引格式、`pluginMarket`、Discover 界面和插件管理器都不动。
- 主机上不做构建步骤：git 来源必须包含构建产物。
- 不重新设计插件页面或系统管理；现有按钮、图标和组件形态保持不变。

<a id="requirements-mapping"></a>
## 需求对照

| # | 用户决定 | 对应章节 | 状态 |
|---|---|---|---|
| 1 | 部署内的公司市场；服务器生成每用户 `index.json`；宿主机代理供给容器；内网防火墙保持关闭；以后可加公共市场 | [为实例提供服务](#serving-instances)、[公共市场](#public-market-later) | 满足 |
| 2 | 两条上架路径，都有审计、都可回滚；复用 KB 共享审批 | [上架流程](#listing-flows)、[审计](#permissions-and-audit) | 满足；默认禁止自审（开放问题 5） |
| 3 | npm 精确版本加完整性、git 精确提交、默认禁用安装脚本、内部镜像、签名放二期、考虑纯技能包类型 | [存储](#store-and-mirror)、[包类型](#package-kinds-and-index-extensions)、[计划](#phased-implementation-plan) | 满足，但有一个限制：如果第 0 阶段迫使使用兜底模式（或某版本带安装脚本），传递依赖只限于审核过的 tarball 而不固定组合，且 Discover 安装没有 lockfile 检查。纯技能包在二期 |
| 4 | 用户自行安装；部门或全公司默认安装且用户可卸载；仅市场开关；保留所有安装路径 | [安装](#installation-and-policy)、[默认安装](#default-installs) | 满足；没有 `egress_lock` 时"仅市场"只是策略（开放问题 1） |
| 5 | 手动更新；默认插件审批后自动推送；每个版本重新审批；可回滚到上一快照 | [默认安装](#default-installs)、[更新](#updates-and-rollback) | 满足；实例空闲时数分钟内实时推送，下次启动兜底（开放问题 3） |

<a id="current-system-facts"></a>
## 现有系统事实

以下事实读自仓库，并决定了本设计。

- **索引格式 1**（`packages/util/plugin-market-index/src/types.ts`、`index.ts`）：插件有 `name`、展示字段、`metadata` 和 `versions[]`；没有 `dist-tags` 成员。版本有 `version`、以 Unix **秒**计且小于 10^11 的 `publishTimestamp`、`source` 和 `engines.dsh`。npm 来源是 `{ type: 'npm', registry? }`；git 来源是 `{ type: 'git', url, commit, path? }`。`parseMarketIndex` 会忽略**并丢弃**格式未定义的成员，因此额外字段到不了 `pluginMarket` 的使用方。`marketInstallTarget` 构造 `<name>@<version>` 或 `git+<url>.git#<commit>`。
- **Host 读取器**（`packages/boot/plugin-market/src/index.ts`）：`indexes` 是用户可在设置页修改的易变配置字段；`fetchTimeoutMs` 15 秒，`maxBytes` 128 MiB，`cacheTtlMs` 10 分钟。它以 `redirect: 'error'` 获取，只带 `accept` 头。`plugin_market` 工具（`tools.ts`）会列出已配置的索引 URL，并把每个版本的 target 和 registry 返回给模型。
- **可选组合包**（`packages/experimental/plugin-market-bundle/cordis.patch.yml`）：插入 `plugin-market` 和 `ui-plugin-market` 行；随附的 profile 默认关闭它。
- **插件管理器**（`packages/boot/plugin-manager/src/index.ts`、`operations.ts`、`build-approval.ts`）：`installBundle(spec, { registry })` 运行 pnpm，失败时恢复 `package.json` 和 `pnpm-lock.yaml`，并用 `pnpm install --frozen-lockfile` 修复；启用 HMR 时升级是先卸载再安装。除非 tarball URL 属于具名 registry，pnpm 会按默认 registry 校验 lockfile 中的 tarball URL。构建脚本只有被批准写入租户可写的 `pnpm-workspace.yaml` 中的 `allowBuilds` 后才会运行。
- **CLI**（`apps/cli/src/args.ts`）：`dsh plugin <args>` 把参数原样转发给 profile 目录中的 pnpm；`--patch` 可以给多次。
- **生成器**（`apps/plugin-market-generator/src/fetchers.ts`）：按 registry 完整性校验 npm tarball，在禁用 hook 的私有裸仓库中读取 git 对象，从不运行包代码。
- **KB 模式**（`integrations/public-harness/packages/kb/src/share.ts`、`views.ts`、`limits.ts`、`store.ts`）：每个 KB 一个待审请求，有效期 30 天；范围为全公司、组或用户；`effectiveLimits` 先取用户行，再取用户有效组（含上级部门）中最宽松的值，最后取全局值，并且绑定在 KB 的 `LIMIT_NAMES` 上。
- **审计与重新认证**（`integrations/public-harness/packages/identity/src/kb-gateway.ts`）：`KB_ADMIN_ENDPOINTS`、`KB_REAUTH` 和 `KB_EVENTS` 集合；取走 outbox 时会丢弃不在该集合中的事件。
- **KB root helper**（`integrations/public-harness/deploy/native/systemd/dsh-kb-root@.service`、`packages/kb/src/runner.ts`）：不读任何租户文件，也不写任何东西；用户 helper 以 `PrivateNetwork=yes` 和 `RestrictAddressFamilies=AF_UNIX` 运行。`dsh-kb.service` 本身没有网络。
- **原生启动**（`integrations/public-harness/packages/runtime-systemd/src/units.ts`、`config.ts`、`deploy/native/config/native.json.example`）：每个实例都以 `--patch <paths.launchPatch>` 运行，这是 release 目录中一个所有用户共用的 root 文件；每实例的信息以环境变量（如 `PUBLIC_HARNESS_QUOTA_PORT`）传给单元。
- **原生启动顺序**（`runtime-systemd/src/runtime.ts`）：先启动 slice，再 `network.install`，然后启动实例单元。`initializeWorkspace` 以账户身份在临时单元中运行 git，使用实例的 slice、AppArmor profile、`PrivateNetwork=yes` 以及内存和任务数限制。
- **原生网络**（`runtime-systemd/src/network.ts`）：output 链给回环连接打上发送方 UID；账户的 input 规则在回环上只放行它自己的配额端口；不在 `users_out` 中的账户落到默认放行。
- **容器启动**（`integrations/public-harness/packages/provisioner/src/runtime.ts`、`limits.ts`）：`webPatch` 为每个用户写一个 patch，用 `insert` 行加载 release 自带的组合包；实例通过 `pasta:--map-host-loopback` 在 `config.quota.hostAddress` 访问宿主机。`assertSafeRunArgv` 只放行固定的卷集合。
- **容器网络**（`deploy/production/nftables/dsh-public.nft`、`deploy/production/README.md`）：pasta 以账户 UID 出站，因此 `meta skuid` 能选中单个实例；目前静态表对整个 UID 段放行整个 `QUOTA_PORTS` 端口段，这是一项已记录的决定：防火墙中不放按用户的规则。
- **服务沙箱**：`deploy/native/systemd/dsh-quota.service` 是绑定回环监听的服务的样板（`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`）。仓库中没有任何宿主机出网代理。
- **管理界面**（`integrations/public-harness/packages/ui/src/client/nav.tsx`、`admin-kit.tsx`、`admin-kb-limits.tsx`、`theme.ts`）："系统管理"在单一侧边栏中为 `admin` 角色注册；`theme.ts` 包含企业磨砂玻璃层。

<a id="architecture-overview"></a>
## 架构概览

```text
 identity (System Admin, /account/api/me) --Unix socket, actor headers--> dsh-plugins (user dsh-plugins)
                                                                            |  SQLite catalogue, store (sha512)
 dsh-plugins-fetch@ (socket-activated, IPAddressAllow=localhost)            |  ports.market held by dsh-plugins.socket
   --CONNECT--> dsh-plugins-egress (allowlist, private-range check) --> npm registries, intranet git (https)
                                                                            v
 instance (account uid) -- pluginMarket.indexes ----> http://<host>:<marketPort>/index.json
                        -- pnpm (@corp-dsh scope) --> http://<host>:<marketPort>/npm/   (bearer token from npmrc)
                        -- plugin-sync -------------> http://<host>:<marketPort>/sync
 provisioner (root): per-instance patch and npmrc, firewall element, pre-start reconcile unit as the account
```

- `dsh-plugins` 持有目录并为实例提供服务。除回环外它没有出站网络。
- 拉取在 `dsh-plugins-fetch@.service` 实例中运行，每个请求按固定动词以 socket 激活启动，只能访问新建的 `dsh-plugins-egress` 代理，由代理执行主机白名单。
- provisioner 在两种运行时中本来就是 root，由它写每实例的 patch 和 npmrc、添加防火墙元素，并以账户身份运行启动前对账。不新增 root helper。
- 实例内的 Discover、`plugin_market` 工具和 `plugin_manager` 无需改动；插入的 `public-harness-plugin-sync` 插件负责推送默认更新。
- `<host>` 在原生运行时是 `127.0.0.1`，在容器运行时是 `config.quota.hostAddress`。

<a id="package-kinds-and-index-extensions"></a>
## 包类型与索引扩展

### 类型

- **bundle**：`package.json` 声明了 `dsh.bundle` 的 npm 包，是上游索引目前唯一列出的类型。
- **skill**：纯技能包，即一组 `SKILL.md` 目录，没有代码。它从不写入 `index.json`。主机像构建 KB 视图那样把获批的技能包链接到每用户的只读目录，每实例 patch 像 `kbSkillRows` 那样把它加入 `skill-filesystem` 的 `customSkillDirs`。二期。

### 在格式 1 内新增的索引成员

```json
{
  "format": 1,
  "title": { "en": "Company market" },
  "plugins": [{
    "name": "@corp-dsh/dsh-example",
    "versions": [{
      "version": "1.4.2",
      "publishTimestamp": 1792000000,
      "source": { "type": "npm", "registry": "http://127.0.0.1:20210/npm/" },
      "engines": { "dsh": ">=0.40.0" },
      "x-dsh-integrity": "sha512-BASE64",
      "x-dsh-company": { "origin": { "type": "git", "url": "https://git.corp.example/team/dsh-example", "commit": "GIT_COMMIT_40_HEX" }, "approvedAt": 1792000000, "default": true }
    }]
  }]
}
```

- `parseMarketIndex` 会丢弃 `x-dsh-integrity` 和 `x-dsh-company`，因此 Discover 和 `plugin_market` 工具看不到它们。它们只供我方读取：同步插件以及读取原始文档的工具。用户看到的公司信息来自 **个人中心 > 我的插件**，经 `/account/api/me/plugins` 提供，而不是上游插件页面。
- 在上游定义完整性成员之前，`x-dsh-integrity` 使用带命名空间的名字；以后再向上游提议。
- 每个版本都以用户监听端口上的 npm 来源提供，包括从 git 审核的版本，因为实例无法访问内网 git 服务器。提交保存在 `x-dsh-company.origin` 中。
- 时间戳以 Unix 秒计。图标内联为不超过 32 KiB 的 `data:` URL；URL 图标从不透传。
- registry URL 不含任何秘密。对同一用户而言，它在实例重启和 `dsh-plugins` 重启后保持不变，因此可以安全地出现在设置页、模型上下文和日志中。

<a id="data-model"></a>
## 数据模型

所有表都在 `dsh-plugins` 的 SQLite 数据库中。用户和组通过 KB 服务使用的同一主体同步，从 identity 的 `dsh_user_group` 读取，有效组包含上级部门。

```sql
CREATE TABLE plugin_package (
  id TEXT PRIMARY KEY,                       -- plg_ + 16 base32 chars
  name TEXT NOT NULL UNIQUE,                 -- npm name; git and upload sources must use a company scope
  kind TEXT NOT NULL CHECK (kind IN ('bundle', 'skill')),
  origin TEXT NOT NULL CHECK (origin IN ('submitted', 'admin', 'public')),
  owner_user_id TEXT,                        -- submitter; NULL for admin uploads and released names
  claimed_at INTEGER,                        -- first approval; NULL while the name can still be released
  display TEXT NOT NULL,                     -- JSON: title, description, author, homepage, repository, metadata
  icon_sha512 TEXT,
  created_at INTEGER NOT NULL,
  delisted_at INTEGER, delist_reason TEXT) STRICT;

CREATE TABLE plugin_version (
  id TEXT PRIMARY KEY,                       -- plv_ + 16 base32 chars
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  version TEXT NOT NULL,                     -- exact SemVer
  source TEXT NOT NULL,                      -- JSON: {type:'npm',registry,integrity} | {type:'git',url,commit,path} | {type:'upload'}
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'revoked')),
  mirror_state TEXT NOT NULL CHECK (mirror_state IN ('queued', 'verifying', 'ready', 'failed')),
  mirror_error TEXT,
  artifact_sha512 TEXT,                      -- pinned artifact served to instances
  upstream_integrity TEXT,                   -- the source registry's own integrity, for provenance
  size_bytes INTEGER,
  engines_dsh TEXT,
  install_scripts TEXT NOT NULL DEFAULT '[]',   -- JSON: closure packages with scripts or binding.gyp
  allowed_builds TEXT NOT NULL DEFAULT '[]',    -- JSON: packages an admin allowed to build
  requested_by TEXT NOT NULL, request_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT,
  created_at INTEGER NOT NULL) STRICT;
-- A version number is taken once it is pending, approved, or revoked; rejected, withdrawn, and expired rows free it.
CREATE UNIQUE INDEX plugin_version_live ON plugin_version (package_id, version) WHERE state IN ('pending', 'approved', 'revoked');
-- At most one pending version per package.
CREATE UNIQUE INDEX plugin_version_pending ON plugin_version (package_id) WHERE state = 'pending';

CREATE TABLE plugin_artifact (               -- name@version -> bytes, never two answers
  name TEXT NOT NULL, version TEXT NOT NULL, sha512 TEXT NOT NULL,
  PRIMARY KEY (name, version)) STRICT;

CREATE TABLE plugin_closure (                -- reviewed lockfile, bundled into the artifact
  version_id TEXT NOT NULL REFERENCES plugin_version(id),
  name TEXT NOT NULL, version TEXT NOT NULL, integrity TEXT NOT NULL,
  install_script TEXT,                       -- NULL, or which of preinstall/install/postinstall/prepare/binding.gyp
  PRIMARY KEY (version_id, name, version)) STRICT;

CREATE TABLE plugin_blob (
  sha512 TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at INTEGER NOT NULL,
  verified_at INTEGER, quarantined INTEGER NOT NULL DEFAULT 0) STRICT;

CREATE TABLE plugin_listing (
  package_id TEXT PRIMARY KEY REFERENCES plugin_package(id),
  current_version_id TEXT NOT NULL REFERENCES plugin_version(id),
  previous_version_id TEXT REFERENCES plugin_version(id),
  generation INTEGER NOT NULL, listed_by TEXT NOT NULL, listed_at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_listing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL, version_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('list', 'update', 'rollback', 'delist', 'relist', 'scope', 'revoke')),
  detail TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_scope (
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,                      -- '*' for company, group id otherwise
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE plugin_default (
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,
  set_by TEXT NOT NULL, set_at INTEGER NOT NULL,
  reset_at INTEGER,                          -- opt-outs older than this are cleared
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE plugin_default_state (
  user_id TEXT NOT NULL, package_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed', 'opted-out', 'user-managed', 'pending', 'failed')),
  installed_version TEXT, target_version TEXT, last_error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, package_id)) STRICT;

CREATE TABLE plugin_profile_snapshot (       -- hashes only; files live in the user's own home
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL, lock_sha256 TEXT, reason TEXT NOT NULL,
  restore_requested_at INTEGER) STRICT;

CREATE TABLE plugin_policy (
  name TEXT NOT NULL CHECK (name IN ('market_only', 'install_scripts', 'egress_lock')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group')), scope_id TEXT NOT NULL,
  value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (name, scope_type, scope_id)) STRICT;

CREATE TABLE dsh_plugin_limit (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group', 'user')), scope_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('max_installed', 'max_submissions', 'max_submission_bytes')),
  value INTEGER CHECK (value IS NULL OR value > 0),
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, name),
  CHECK ((scope_type = 'global') = (scope_id = '*'))) STRICT;

CREATE TABLE plugin_endpoint (               -- one port per user, one user per port
  user_id TEXT PRIMARY KEY, port INTEGER NOT NULL UNIQUE,
  instance_id TEXT,                          -- NULL while no instance runs
  account_uid INTEGER, token_sha256 TEXT,    -- npm bearer token of the running instance
  opened_at INTEGER, last_report TEXT) STRICT;

CREATE TABLE plugin_audit_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL,
  user_id TEXT, actor TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
```

- `plugin_version` 就是审核请求。两个部分唯一索引保证每个包最多一个待审版本，并允许被驳回、撤回或过期的版本号以新行重新提交。
- `plugin_artifact` 保证全局不变量 `name@version -> 唯一 sha512`。为已存在的组合再提交另一个产物会以 409 `version-exists` 拒绝。
- `claimed_at` 在首次批准时设置。在此之前，首个版本被驳回、撤回或过期会释放包名（见[谁可以提交](#listing-flows)）。
- `dsh_plugin_limit` 逐列复制 `dsh_kb_limit`；共用之前先把 `effectiveLimits` 泛化到任意限额名。
- `origin = 'public'` 预留给以后的公共市场。

<a id="store-and-mirror"></a>
## 存储、出网与镜像

### 目录布局

```text
/var/lib/dsh-plugins/                 dsh-plugins:dsh-plugins 0750
  plugins.sqlite
  store/sha512/<aa>/<rest>.tgz        pinned artifacts, 0440, never rewritten
  staging/<request>/                  results streamed back by the fetch service, removed after review
  uploads/<request>.tgz               admin and user uploads before checks
  skills/<package>/<version>/         unpacked skill packages (phase 2)
  views/<account>/skills/             per-user skill views (phase 2), bound read-only
/run/dsh-plugins/control.sock         identity and provisioner, group dsh-plugins-clients
/run/dsh-plugins/fetch.sock           dsh-plugins-fetch.socket, root:dsh-plugins 0660
/run/dsh-public/instance-market/<account>.yml    per-instance patch, root:<gid> 0640 (native)
/run/dsh-public/instance-market/<account>.npmrc  per-instance npmrc, root:<gid> 0640 (native)
```

### 拉取服务

`dsh-plugins` 没有任何 capability，无法以其他用户身份启动单元；KB 需要 root helper 也是同一个原因。因此拉取改用 socket 激活，既不需要 root 也不需要 polkit：

- `dsh-plugins-fetch.socket`：`ListenStream=/run/dsh-plugins/fetch.sock`、`Accept=yes`、`SocketUser=root`、`SocketGroup=dsh-plugins`、`SocketMode=0660`。
- `dsh-plugins-fetch@.service`：`User=dsh-plugins-fetch`、`StandardInput=socket`、`IPAddressDeny=any`、`IPAddressAllow=localhost`、`Environment=HTTPS_PROXY=http://127.0.0.1:<egressPort>`，不设其他环境变量，`PrivateTmp=yes`、`ProtectSystem=strict`、`ProtectHome=yes`，除私有 tmp 外没有可写路径，capability 为空，并设 `MemoryMax`、`TasksMax` 和 `RuntimeMaxSec=900`。仅靠 `IPAddressAllow=localhost` 仍能访问其他回环服务，因此再加一条 nft output 规则，只允许 `dsh-plugins-fetch` UID 连接 `127.0.0.1:<egressPort>`；quota、identity 及其他所有本地端口一律拒绝。
- 每个连接一个请求，帧格式与 KB root helper 相同：一个 JSON 头 `{verb, args, input}`，后跟 `input` 字节；一个回复 `{ok, bytes}`，后跟结果归档和一份 JSON 报告。由 `dsh-plugins` 把结果写入 `staging/`，再写入存储；拉取服务在私有 tmp 之外什么也不写。
- 固定的动词，每个都有参数白名单：
  - `npm-version {registry, name, version}`：registry 必须在 `egress.allow` 中，name 必须是合法 npm 包名，version 必须是精确 SemVer。
  - `git-commit {url, commit, path}`：允许的 git 主机和路径前缀上的 https URL，40 位十六进制提交，不含 `..` 的相对路径。
  - `upload-check {}`：上传的 tarball 作为 `input` 传入。
  - `closure {name, version, registry}` 和 `artifact {versionId}`：解析依赖闭包，并用 `input` 中传入的字节构建固定产物。
- 凭据：用户提交不使用任何凭据。管理员 git 上传用的只读部署令牌只作为 `input` 传给需要它的那一个请求，从不放进环境变量或 argv。

### 出网：新建的宿主机代理组件

目前仓库中没有宿主机出网代理，因此本设计新建一个 `dsh-plugins-egress`：

- 一个小型 HTTP CONNECT 代理，属于 `packages/plugins`，以独立用户运行，监听 `127.0.0.1:<egressPort>`。防火墙规则只允许 `dsh-plugins-fetch` UID 连接它。
- 它只对 `plugins.json` 的 `egress.allow` 中的主机名接受 `CONNECT host:443`：已配置的 npm registry 和 git 主机。git 主机还可以收窄到路径前缀，由拉取服务检查。
- 除非地址落在某个 `egress.intranet` CIDR 中，否则它拒绝以 IP 字面量为目标的请求。
- 它自己解析域名并检查**每一条** A 和 AAAA 记录。只要有一条落在禁止的地址段，就拒绝该请求：IPv4 的回环、私网、链路本地、CGNAT、组播和元数据地址；IPv6 的 `::1`、`::ffff:0:0/96`、`64:ff9b::/96`、`fc00::/7`、`fe80::/10`、`2002::/16`、`2001::/32` 和组播。例外是列在 `egress.intranet` 中的主机，它必须解析到所配置的 CIDR 之内。
- 然后它连接到自己校验过的那个确切地址，不再重新解析，因此 DNS 重绑定无法替换目标。
- 它从不跟随重定向（CONNECT 本身没有重定向），因此重定向到未列出的主机会在下一次 CONNECT 时失败。它记录每条隧道的主机、地址、端口、请求 id 和字节数。
- `dsh-plugins` 本身只用回环：它在实例监听端口上接受连接，并通过拉取服务的 socket 与其交互。

### 镜像一个版本

1. **解析来源。** npm：从来源 registry 读取 packument，取该精确版本的 `dist.tarball` 和 `dist.integrity`；tarball 主机必须是该 registry 的主机，没有完整性值的版本被拒绝。git：只允许 https；按生成器规则（深度 1、关闭 hook 和文件系统监视器、不拉子模块）并加 `-c http.followRedirects=false` 获取固定提交；用包目录中的 blob 构建 tarball。用户提交不带凭据拉取，因此只能读到宿主机可匿名读取的仓库。上传：安全解包 `.tgz`，拒绝绝对路径、`..`、符号链接和硬链接、设备文件、超过 10,000 个条目或解压后超过 200 MiB。
2. **检查包。** tarball 中的 `package.json` 必须与包名和版本一致。git 和上传来源必须使用配置的公司 scope（如 `@corp-dsh/`），且包名不得存在于任何已配置的上游 registry。bundle 必须声明带 patch 的 `dsh.bundle`；技能包只能包含 `SKILL.md` 目录和资源文件。
3. **解析依赖闭包。** 先静态扫描包自身的依赖声明，在发出任何请求之前拒绝一切非 SemVer 范围的声明（git、URL、`file:`、`link:`、`workspace:`、`npm:` 别名）。然后于空目录为这一个依赖运行 `pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --config.registry=<来源 registry>`，把 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 作为已提供的 peer 排除。解析 lockfile：每一项都必须是从已配置 registry 解析出的、带完整性的 SemVer 版本，否则以 409 `closure-source` 拒绝。通过代理下载每个 tarball 并校验完整性。
4. **检测安装脚本。** 闭包中的包只要 manifest 含 `preinstall`、`install`、`postinstall` 或 `prepare`，设置了 `gypfile`，或在顶层带有 `binding.gyp`（pnpm 会隐式运行 `node-gyp rebuild`），就视为带安装脚本。每一项都记入 `plugin_closure.install_script`。
5. **选择模式并构建产物。**
   - **打包模式** 把插件 tarball 与审核过的闭包一起重新打包，闭包按 lockfile 布局放在 `bundleDependencies` 下，这样安装时完全不需要解析依赖范围。只有当闭包不含安装脚本，或第 0 阶段证明 pnpm 11 会对被打包的包应用 `allowBuilds` 时，才使用打包模式。打包模式绝不能用来绕过安装脚本的默认禁止。
   - **兜底模式** 提供原始 tarball 和按用户过滤的 packument，用于带有打包模式无法管控的安装脚本的版本；如果第 0 阶段否定了打包模式，则所有版本都用兜底模式。它的保证更弱：只会安装审核过的 tarball，但 pnpm 可能选出审核过的版本的另一种组合。同步和对账会对照 `plugin_closure` 检查安装后的 lockfile；**Discover 和手动安装没有 lockfile 检查**。
   - 产物上限 200 MiB。其 sha512 成为 `artifact_sha512`；上游完整性值保留作来源证明。
6. **存储并冻结。** 把产物按摘要放入 `store/sha512/` 并写入 `plugin_artifact`；`mirror_state` 变为 `ready`，或带 `mirror_error` 的 `failed`。版本一旦为 `ready`，就不再重新镜像或重新打包；需要不同的产物时必须重新提交。

### 完整性保证

- **审核绑定**：审核页显示 `artifact_sha512`、模式和产物的文件列表。批准请求必须携带 `expected_artifact_sha512`，服务器只在它与已存值相等时批准（否则返回 409 `artifact-mismatch`）。
- **拉取**：每个 tarball 都与来源 registry 的完整性值一致，或与构建它的 git 提交一致。
- **存储**：blob 以摘要命名，从不改写。
- **提供**：每个 blob 在启动后首次读取时以及每日巡检时重新计算哈希。不一致则隔离该 blob，返回 503，并写入 `plugin-store-corrupt`。
- **客户端**：pnpm 用 packument 中的完整性值校验产物，而 packument 来自同一台服务器；之后 lockfile 会固定该值供后续安装使用。同步和对账还会把安装后 lockfile 中的完整性值与目录中的 `artifact_sha512` 比较，不一致则回滚。在上游支持完整性成员之前，Discover 安装没有独立的客户端校验；这列为未验证项，也是向上游的提议。

<a id="serving-instances"></a>
## 为实例提供服务

### 监听与端口

- `plugin_endpoint` 让端口与用户一一对应：`ports.market` 中的一个端口最多属于一个用户，一个用户最多有一个端口。该段必须位于 1024-32767，不得与 `ports.web`、`ports.quota` 或 `ports.sidecar` 重叠，且最多 4,096 个端口。用户在多次启动之间保留端口，因此设置页和模型上下文中的 URL 不变。与按运行实例分配的 quota 端口不同，市场端口在账户存在期间一直由该账户占用，因此 4,096 的上限就是能使用市场的账户数上限。配置校验还会检查 `ports.web`、`ports.quota`、`ports.sidecar` 和 `ports.market` 全部位于 32768 以下且互不重叠。只有端口所在的行被删除后，端口才会重新分配。账户被删除时删除其行；provisioner 启动时发现某行的账户已不存在，也会删除该行。
- **整个端口段由 systemd 持有。** 安装程序生成 `dsh-plugins.socket`，`ports.market` 中每个端口一行 `ListenStream=127.0.0.1:<port>`，并设 `Service=dsh-plugins.service`。socket 单元先于任何租户单元或容器启动，因此其他进程无法绑定市场端口。`dsh-plugins` 重启或停止期间，这些监听保持打开。`dsh-plugins` 通过 `LISTEN_FDS` 接收描述符，把每个描述符对应到端口，对没有行的端口返回统一的 404。
- provisioner 启动实例时通过控制 socket 调用 `open(userId, instanceId, uid)`。`dsh-plugins` 分配或确认该用户的端口，生成新的 npm bearer 令牌并保存其 SHA-256，返回端口和令牌。实例停止时 `close(instanceId)` 清除令牌。重启后，`dsh-plugins` 对仍带 `instance_id` 的行继续接受已保存的令牌哈希。

### 谁能连接

市场流量必须先通过两条丢弃规则，再命中一条放行规则。在 nftables 中，`accept` 只结束当前这条 base chain，包之后仍要经过后面的每一条 base chain；而任何地方的 `drop` 都是最终结果。因此两条丢弃规则放在独立的表中，放行规则则放在原有规则原本会丢弃这些流量的位置。

- **独立的表，单独加载。** 两条丢弃规则位于独立的表 `inet dsh_market`，其 base chain 优先级为 `filter - 2`。
  - 它不属于每个实例的 `network.install` 事务，也不属于 `dsh-public.nft`。`dsh-plugins.socket` 通过 `ExecStartPost=-<loader>` 加载它，因此每次 socket 单元启动都会重新加载。`-` 前缀使加载失败既不会让 socket 单元失败，也不会阻止任何实例启动。
  - 加载程序在表和 `market_owner` set 不存在时创建它们。它只清空并重填链，从不清空 set，因此元素在重新加载后仍然保留。
  - `renderInputDispatch` 在每次安装和移除实例时清空并重建 `dsh_native input`，但从不触碰这张表。
- **接收方 socket。** `iif "lo" tcp dport $MARKET_PORTS jump market_listener`。子链 `market_listener` 先是 `socket cgroupv2 level <n> "<监听 cgroup>" return`，然后是 `drop`。
  - 监听 socket 属于哪个 cgroup，在第 0 阶段第 8 项给出结论之前只是一个假设。最初的候选是 `init.scope`（level 1），理由是 socket 由 PID 1 创建。这很可能不成立：内核支持 BPF 防火墙时，systemd 会在 socket 单元自己的 cgroup 内用辅助进程创建 INET 监听，因此它们大概率位于 `system.slice/dsh-plugins.socket`。备选规则是 `socket cgroupv2 level 2 "system.slice/dsh-plugins.socket"`，加载程序按第 0 阶段实测的 cgroup 渲染。
  - 无论哪种情况，accept 出来的连接都继承监听 socket 的 cgroup，因此这条规则不取决于 `dsh-plugins.service` 是否在运行或是否重启过。
  - 规则从不引用 `dsh-plugins.service`。nft 在加载规则时解析 `socket cgroupv2` 路径（`network.ts`）。服务 cgroup 不存在会导致加载失败，服务重启后其 cgroup id 也会改变。
  - socket 单元处于 active 状态期间其 cgroup 一直存在，而加载程序在它的 `ExecStartPost` 中运行，因此路径能够解析。如果 socket 单元停止，端口本来就不再被持有；过期的 cgroup id 会让规则丢弃所有市场流量，即失败时关闭。
- **发送方拥有该端口。** `set market_owner` 恰好保存 `plugin_endpoint` 中的 `uid . port` 组合：原生为 `type mark . inet_service`，容器为 `type uid . inet_service`。两边的规则都用 `!=` 查集合，因此不在集合中的组合一律丢弃，包括任何未映射的端口。不使用 map 查找，因为 map 中不存在的端口不会命中规则，会变成放行。
  - 原生，在 `dsh_market` 的 input 链中：`iif "lo" tcp dport $MARKET_PORTS ct mark . tcp dport != @market_owner drop`。这条规则成立，是因为 output 链对每个 UID 的每条回环连接都打上了 `ct mark set meta skuid`。
  - 容器，在 `dsh_market` 的 output 链中：`oif "lo" tcp dport $MARKET_PORTS meta skuid . tcp dport != @market_owner drop`。由于它是独立的 base chain，这条丢弃在 `dsh_instances` 放行实例范围外的 UID 之前就生效。
  - 因此未映射的端口、root，以及 `dsh-router`、`dsh-identity` 等宿主机服务账户都会被拒绝。provisioner 和探测的健康检查走控制 socket，从不使用市场端口。
- **给属主的放行。** 通过两条丢弃规则的流量仍会被原有规则丢弃，因此每种运行时各加一条放行：
  - 原生：`renderUserNetwork` 在 `in_<uid>` 最后的 `ct mark <uid> iif "lo" counter drop` 之前加入 `ct mark <uid> iif "lo" tcp dport $MARKET_PORTS accept`。
  - 容器：`dsh-public.nft` 在 `oif "lo" drop` 之前加入 `oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept`。
  - 两条都不引用 cgroup，因此都不会加载失败。
- **合起来。** 市场端口段由这条放行加上 `dsh_market` 中的两条丢弃共同把关：放行让任何实例账户都能到达该端口段，两条丢弃再把它收窄到端口的属主和 systemd 监听。
- **`dsh-plugins` 中的对端校验，第二道防线。** 放行规则覆盖整个端口段，因此如果 `dsh_market` 缺失，只靠 nft 会让一个实例账户访问到另一个账户的端口。所以 `dsh-plugins` 自己校验每条连接，不依赖任何表、provisioner 或状态同步：
  - 每次 accept 时，它通过 `NETLINK_SOCK_DIAG` 以四元组精确的 `inet_diag` 查询向内核询问对端 socket 的 UID：即客户端 socket `127.0.0.1:<对端端口> -> 127.0.0.1:<市场端口>`，或对应的 `hostAddress` 形式。
  - 它把该 UID 与 `plugin_endpoint` 中这个端口的属主比对；不一致、端口未映射或查询失败时，在读取任何字节之前立即关闭连接。
  - 在容器中，对端是 pasta 的 socket，属于账户 UID，与 nft 的 `meta skuid` 规则依据相同。
  - 不能用 `SO_PEERCRED`，因为它只对 `AF_UNIX` 有效，TCP 上拿不到。扫描 `/proc/net/tcp` 只作退路，因为每次 accept 都要读整张表，在 4,096 个账户时代价偏高。
  - `dsh-plugins.service` 在 `RestrictAddressFamilies` 中加入 `AF_NETLINK`。非特权、带沙箱的服务能否这样取得 UID，由第 0 阶段第 9 项确认。
- **自愈与集合完全一致。** root 身份的 provisioner 在每次实例启动前以及每分钟运行探测：
  - 如果 `dsh_market` 表或某条链缺失，provisioner 自己重新运行加载程序，并按 `plugin_endpoint` 重新填满 `market_owner`。
  - 它比对该 set 与端点行是否完全相等。多出来的元素立即删除并发出安全告警，因为过期元素会让旧 UID 访问已换了属主的端口。缺失的元素则补上；元素缺失只会把那位属主挡在外面，因此从不当作全局故障，也不会让所有人的市场关闭。
  - provisioner 还会在实例启动前添加 set 元素，并随端点行一起删除它。
  - 重启 `nftables.service` 会执行 `flush ruleset`，`dsh_market` 也会被一并清掉。探测会在一分钟内恢复它，在此期间对端校验仍把其他账户挡在外面。运维不应单独重载规则集；运维手册写明这一点。
- 这改变了"容器防火墙不放按用户规则"的既有决定，但只针对市场端口段。
- 隔离依靠 nft 规则和对端校验，二者任一单独都能把其他账户挡在端口之外。npm bearer 令牌是纵深防御。

### 路由

- `GET /index.json`：个性化索引，上架代次、用户所在组或用户的默认安装变化时重建，按摘要缓存。
- `GET /npm/<name>`：packument，接受 `@scope%2Fname`、`@scope%2fname` 和 `@scope/name` 三种写法。每个 packument 只列出该用户可见版本的产物，使用标准 tarball 路径。
- `GET /npm/<name>/-/<basename>-<version>.tgz`：产物，采用 npm 标准路径，因此 pnpm 不会把 tarball URL 写进 lockfile。
- `GET /sync` 和 `POST /sync/report`：同步计划和实例的报告（见[默认安装](#default-installs)）。
- npm 路由要求 `authorization: Bearer <token>`，以常数时间比较。所有拒绝都是同样的 404、同样的响应体，并做与成功时相同的工作，因此既不暴露令牌错误，也不暴露不可见的上架项。响应从不重定向。访问日志只记录令牌哈希的前 8 个十六进制字符。

### 实例如何获得 URL 和令牌

- **原生**：单元增加第二个 patch `--patch /run/dsh-public/instance-market/<account>.yml`，由 root 拥有、只有该账户的组可读，在单元启动前由 provisioner 原子写入。单元还获得 `NPM_CONFIG_GLOBALCONFIG=/run/dsh-public/instance-market/<account>.npmrc`。共用的 `paths.launchPatch` 保持不变。`config.ts` 校验新增的 `paths.instanceMarketDir` 是 root 拥有、且位于租户可写路径之外的目录。
- **容器**：`webPatch` 增加同样的行。npmrc 以只读卷 `<marketDir>/<account>:/run/dsh-market:ro` 挂载，该卷加入 `assertSafeRunArgv` 的白名单，并设 `NPM_CONFIG_GLOBALCONFIG=/run/dsh-market/npmrc`。
- npmrc 包含 `@corp-dsh:registry=http://<host>:<port>/npm/` 和 `//<host>:<port>/npm/:_authToken=<token>`。在 `market_only` 下它还设置 `registry=http://<host>:<port>/npm/`，使插件管理器的修复或普通的 `pnpm install` 也从镜像解析公共包名的产物。`NPM_CONFIG_GLOBALCONFIG` 作用于实例中的每一次 npm 和 pnpm 运行，因此用户自己 workspace 中的安装也会指向镜像，而镜像里没有公共包；开放问题 1 写明了这一点。公司 scope 使用专用名称（如 `@corp-dsh/`），使映射不会劫持公司内部开发已在使用的 scope（开放问题 6）。
- 令牌暴露面：令牌不出现在任何 URL、patch、lockfile、`plugin_market` 输出或访问日志中。以该账户身份运行的任何进程（包括模型执行的 shell 命令）都能读取 npmrc；这属于账户自己的信任域，而且该令牌只能访问该账户自己的端口。
- patch 行由 `contracts/src/web-rows.ts` 中新增的 `pluginMarketRows` 生成：
  - 像实验性组合包的 `cordis.patch.yml` 那样插入 `plugin-market` 和 `ui-plugin-market`；
  - 把 `plugin-market` 的 `indexes` 设为 `[http://<host>:<port>/index.json]`；
  - 从 release 资产插入 `public-harness-plugin-sync`，并配置其同步 URL；
  - 用户处于 `market_only` 下时，把插件管理器的 `registry` 设为镜像、`fallbackRegistries` 设为 `[]`。
- `indexes` 和 registry 字段：CLI 在 profile 层之后按参数顺序应用 `--patch` 文件（`apps/cli/src/args.ts`）。因此市场 patch 可能在每次启动时覆盖用户在设置页对这些字段的修改。第 0 阶段检查哪一层生效，以及上游是否另行记录用户的修改。在此之前，本文不承诺用户能保留不同的 `indexes` 值，`market_only` 的强度也只取决于这一顺序（见[安装与策略](#installation-and-policy)）。

<a id="listing-flows"></a>
## 上架流程与状态机

### 谁可以提交

- 任何用户都可以为一个新的公司 scope 包名提交首个版本。该版本待审期间包名被占用，获批后归其所有（设置 `claimed_at`）。
- 如果在该包任何版本获批之前，首个版本被驳回、撤回或过期，包名即被释放：清空 `owner_user_id`，之后任何人再次提交该包名，提交者即成为所有者。
- 已归属的包的后续版本只能由其所有者或管理员提交；其他人得到 403 `not-owner`。
- 管理员不能批准自己提交的版本（403 `self-approval`）；他们应改走路径 B，并以上传的形式被审计。

### 状态转移

| 原状态 | 操作 | 新状态 | 执行者 | 拒绝码 |
|---|---|---|---|---|
| 无 | 提交 | pending，镜像 queued | 所有者；未归属的包名则任何人 | 403 `not-owner`、409 `pending-exists`、409 `version-exists`、409 `limit-reached`、409 `name-taken` |
| pending | 镜像完成 | pending，镜像 ready 或 failed | 系统 | 无 |
| pending | 带范围和 `expected_artifact_sha512` 批准 | approved | 管理员，且不是提交者 | 409 `mirror-not-ready`、409 `artifact-mismatch`、409 `install-scripts`、403 `self-approval` |
| pending | 驳回 | rejected | 管理员 | 409 `not-pending` |
| pending | 撤回 | withdrawn | 提交者 | 409 `not-pending` |
| pending | 超过 30 天 | expired | 系统 | 无 |
| 无 | 带范围上传 | approved | 管理员 | 409 `version-exists`、409 `install-scripts`、409 `closure-source` |
| approved | 撤销 | revoked | 管理员 | 409 `not-approved` |
| rejected、withdrawn、expired | 提交相同版本号 | 新的 pending 行 | 所有者；包名释放后则任何人 | 同提交 |

### 上架指针规则

- 批准或上传一个高于当前版本的版本时，它成为当前版本，原当前版本移到 `previous_version_id`。低于或等于当前版本的版本只进入历史，不会因批准而成为当前版本。
- **回滚** 让 `previous_version_id` 成为当前版本。新的上一版本是低于新当前版本的最高已批准且未撤销的版本，没有则为 `NULL`。没有上一版本时以 409 `no-previous` 拒绝。
- **撤销** 非当前版本时，把它从 packument 和索引中移除。撤销当前版本时按上述规则回滚；没有上一版本时，该包以原因 `revoked` 下架。
- **下架** 保留范围行。索引不再列出该包，默认安装不再安装它，镜像继续向原范围内的用户提供其产物，使已有 profile 仍可重新安装。**重新上架** 清除 `delisted_at`。
- **范围变更** 重写 `plugin_scope`。失去可见性的用户保留已安装的插件，但镜像不再向他们提供其产物，因此以后从市场重新安装会以未找到失败。

### 路径 A：用户提交、管理员审批

1. 用户在 **个人中心 > 我的插件** 中提交 npm 包名和精确版本、带 40 位提交的 https git URL 或 tarball，并附说明。
2. 拉取服务镜像它；请求显示 `mirror_state`。镜像失败的请求可以撤回后重新提交。
3. 由另一位管理员在 **系统管理 > 插件市场 > 审批队列** 中审核：manifest，产物的 `artifact_sha512`、模式和文件列表，带安装脚本标记的依赖闭包，大小，以及与当前版本相比的文件名差异。重新认证后带范围和允许构建列表批准，或填写原因驳回。页面把它显示过的摘要作为 `expected_artifact_sha512` 发送，因此批准恰好覆盖审核过的那个产物。
4. 提交者可以撤回待审版本，也可以申请下架，由管理员处理。

### 路径 B：管理员直接上架

- 在 **系统管理 > 插件市场 > 上传** 中，管理员提供 npm 包名和版本、git URL 和提交，或 tarball，以及范围。运行相同的镜像和检查。成功后版本为 `approved`，`requested_by = reviewed_by = <admin>`，经重新认证后立即上架，事件为 `admin-plugin-upload`。

<a id="installation-and-policy"></a>
## 安装与策略

### 用户安装

- Discover 用条目的 registry（即该用户的镜像）安装 `<name>@<version>`。插件管理器只单独询问该 registry，因此公司包永远不会回退到公共 registry。
- `plugin_market` 工具返回相同的 target 和 registry，其中不含秘密；`plugin_manager` `install_bundle` 保留其审批要求。
- npmrc 把公司 scope 映射到镜像，因此 `dsh plugin add @corp-dsh/x@1.2.3` 也会在那里解析。除非适用 `market_only`，其他 spec 的行为与现在相同。

### "仅允许从市场安装"

- `market_only` 在 **系统管理 > 插件市场 > 策略** 中按全公司或部门设置；只要用户的任一有效组或全局行开启了它，该用户就受其约束。
- 开启后，每实例 patch 把插件管理器的 `registry` 设为镜像，`fallbackRegistries` 设为 `[]`，npmrc 也把 `registry=` 设为镜像。由于该 npmrc 对整个实例生效，用户自己项目的安装此后也会从镜像解析。此后 registry spec 只会对获批产物解析；其他一律在现有对话框中以未找到失败。
- 用户在设置页的修改能否覆盖这些行，取决于 CLI 应用 patch 的顺序，由第 0 阶段验证（见[为实例提供服务](#serving-instances)）。
- 这是策略，不是边界。git 和 tarball URL 仍可经公网 `443` 出去，而且用户控制自己的实例和 npmrc。可选的 `egress_lock` 才使它成为边界：
  - 原生：`network.ts` 不再为该账户渲染公网 `80` 和 `443` 的放行规则；
  - 容器：`dsh-public.nft` 增加 `set egress_locked { type uid; }`，并在公网放行之前加入 `meta skuid @egress_locked tcp dport { 80, 443 } drop`，由 provisioner 维护；
  - 模型调用不受影响，因为它们走配额回环监听；浏览、git、pip 和公共 npm 将无法使用。
- `egress_lock` 是开放问题 1，需要用户决定。

### 安装脚本

- 默认 `install_scripts = deny`。依赖闭包中只要有任何安装脚本（包括 `prepare` 和 `binding.gyp`），只有管理员在重新认证后于批准请求中逐个允许这些包，该版本才能获批；否则批准得到 409 `install-scripts`。
- 带有已允许安装脚本的版本以兜底模式提供，除非第 0 阶段证明 pnpm 11 会对被打包的包应用 `allowBuilds`（见[镜像一个版本](#store-and-mirror)）。
- 同步和对账依靠 pnpm 11 默认不运行未被允许的依赖构建，并把每个允许的包以 `--allow-build=<pkg>` 传入。它们从不设置 `ignore-scripts`。在交互式安装中，插件管理器自身的构建审批仍会询问用户，但获批闭包中所有带脚本的包都已事先被允许。
- profile 的 `pnpm-workspace.yaml`（包括 `allowBuilds`）可由账户写入，因此用户可以在自己的 profile 中允许更多构建。这仍在账户自身的权限之内。

<a id="default-installs"></a>
## 默认安装、同步与对账

### 默认安装

- 管理员把已上架的包标记为全公司或若干部门的默认安装。用户的默认集合是其可见的全部默认安装。
- `plugin_default_state` 按用户和包记录：
  - `installed`：由同步或对账安装；保持在上架版本。
  - `pending`：有更新的上架版本等待应用。
  - `failed`：上次应用失败且已回滚；按退避重试。
  - `opted-out`：由市场安装、之后被用户卸载；除非管理员重置该默认安装（`reset_at`）或用户在"我的插件"中重新启用，否则不再安装。
  - `user-managed`：用户手动安装了其他版本；不去动它。

### 实时推送：同步插件

- `public-harness-plugin-sync` 是 `integrations/public-harness/packages/plugin-sync` 中新增的小插件，由每实例 patch 插入每个公司实例。
- 它在启动时以及之后每 5 分钟（带随机抖动）轮询 `GET /sync`。返回 `{ name, version, fromVersion, sha512, action }` 列表，动作为 `install`、`update` 或 `downgrade`，并附允许构建列表。计划只是请求，不是命令；由下面的本地检查决定是否执行。
- **本地操作日志。** 插件在账户 home 中维护 `~/.dsh-market/sync-log.jsonl`。每个操作开始前写一条 `intent` 记录，并在 `~/.dsh-market/snapshots/<op>/` 下保存 `package.json` 和 `pnpm-lock.yaml` 的快照；结束后写 `done`、`removed`、`failed` 或 `recovered` 记录。判断用户卸载了什么，只以这份日志为准。不用 `plugin-manager/changed` 来判断：CLI 的变更和由 HMR watcher 应用的手工编辑都不会发出事件，而且事件不带包名。同步插件只用该事件来提前重新检查。
- **用户卸载规则。** 如果日志中有同步插件对某个包的 `done` 安装记录，该包现在不在 `package.json` 中，且那次安装之后日志中没有同步插件的 `removed` 记录，就认定该包是被用户卸载的。同步插件随即写一条 `user-removed` 记录。这条规则同样覆盖通过 Discover、`dsh plugin remove` 和手工编辑所做的卸载，对账也采用同一条规则。
- **基于重新读取的前置条件。** 每个操作之前，插件立即获取 profile 锁，即插件管理器使用的同一个 `package.json.lock` `withFileLock`。在锁内它重新读取 `package.json` 和 lockfile，检查条件，写入 `intent` 记录，然后释放锁：
  - `update` 和 `downgrade` 只在该包仍以恰好 `fromVersion` 安装时执行。
  - `install` 只在该包不存在、且自上次重置或重新启用以来不是 `user-removed` 时执行。
  - 同步插件的任何卸载都要求该包存在。否则 `removeBundle` 本身就以 `not-removable` 拒绝，同步插件随即放弃该项。
  - 否则跳过该项，并以 `skipped` 报告原因。
- **应用：先装成禁用，检查后再启用。** 只在实例空闲时：
  1. `update` 和 `downgrade` 先调用 `removeBundle(name)`；返回 `not-removable` 说明用户已卸载，同步插件停止。启用 HMR 时，插件管理器拒绝在已安装的包上再次安装（`already-installed`），所以 `install` 遇到这个返回也停止。
  2. `installBundle(name@version, { registry, enabled: false, approvedBuilds })` 安装该组合包但不选中它，因此它的插件都不会启动。
  3. 同步插件再次获取锁并重新读取：该包存在且版本为 `version`，lockfile 的完整性值等于 `sha512`，且 `intent` 之后没有记录到用户卸载。
  4. 全部检查通过时，`setBundleEnabled(name, true)` 启动它；如果包在此期间消失，这个调用本身就会失败。任一检查失败时，同步插件对这个从未启用的组合包调用 `removeBundle(name)`。升级中完整性校验失败后，它重新安装 `fromVersion`；因用户卸载而失败时，它让该包保持不存在。
- **为什么这对一期已经足够。** 插件管理器的锁不可重入，`change()` 又是私有方法，因此同步插件无法在 `installBundle` 的整个过程中持锁。启用 HMR 时，不带 `enabled: false` 的 `installBundle` 会在它自己的锁内选中该组合包并重新加载，于是在同步插件检查任何东西之前，插件就已激活，并可能为某个 agent 轮次注册工具。采用禁用安装后，窗口内最多只有管理员为该版本允许的安装脚本以账户身份运行过；插件本身只在检查通过后才启动。一期把这种事后检查作为已列出的风险接受，不修改上游，也不在整个操作期间持锁。
- **没有 HMR 时。** 变更本来就要到下次启动才生效，因此检查发生在任何插件代码运行之前。但 `removeBundle` 拒绝删除在本进程中已经启动的组合包（`stop-profile`），所以检查失败时交给下一次对账，由它在实例启动前按快照恢复。
- **可选的上游提案。** 为 `installBundle` 增加前置条件选项，可以在锁内关闭这个窗口。它作为可选提案保留在第 0 阶段第 7 项；本设计不依赖它。
- **恢复。** 如果 `removeBundle` 成功而 `installBundle` 失败，同步插件立即从镜像重新安装 `fromVersion`。如果这也失败，就从快照恢复这两个文件，并把 `intent` 记录以 `failed` 保持未结，下一次对账会在实例启动前完成恢复。
- **报告。** `POST /sync/report` 发送结果、已安装组合包列表，以及自上次报告以来的操作日志条目。服务端只根据 `user-removed` 记录推导 `opted-out`。因同步操作失败或未结而缺失的包保持 `failed`。服务端还据此推导 `user-managed`，以及用于 `max_installed` 的安装计数。
- 同步插件运行在租户自己的实例内，因此其报告只用于该用户自身的状态和软限额，从不用于安全决策。
- 管理员可按包看到已应用、待应用、已跳过和失败的用户数。

### 兜底：启动前对账

如果审批时实例处于停止状态，或同步未能及时应用更新，provisioner 会在下次启动前对账。

- **顺序（原生）**：启动 slice，`network.install`，运行对账单元，再启动实例单元。此时账户的防火墙规则已经就位。
- **单元（原生）**：仿照 `initializeWorkspace`：
  - `systemd-run --wait --collect --pipe --slice=<实例 slice> --uid --gid`；
  - `AppArmorProfile=<account>`、`NoNewPrivileges=yes`、空的 `CapabilityBoundingSet`、`ProtectSystem=strict`、`ProtectHome=yes`；
  - `ReadWritePaths` 只含 profile 目录、cache 和 tmp；
  - `InaccessiblePaths` 包含 state 和 socket 目录树；
  - `IPAddressDeny=any` 加 `IPAddressAllow=localhost`，因此只能访问回环，而防火墙在回环上只放行它自己的市场端口；
  - 实例的 `MemoryMax` 和 `TasksMax`，以及 `RuntimeMaxSec=300`。
- **单元（容器）**：在添加 `market_owner` 元素之后，运行一个一次性 `runsc` 容器，使用实例的镜像、卷、用户命名空间和 `--network` 参数，由仿照 `assertSafeRunArgv` 的 `assertSafeReconcileArgv` 检查。
- **环境变量白名单**：恰好是与实例单元一致的 `HOME`、`DSH_HOME`、`XDG_CACHE_HOME`、`TMPDIR`，工具链的 `PATH`，以及 `NPM_CONFIG_GLOBALCONFIG`。不从 root 继承任何东西：没有 `npm_config_*`、没有代理变量、没有模型密钥。`DSH_MODEL_API_KEY` 不存在，与目前的实例单元一致。
- **输入**：provisioner 通过控制 socket 从 `dsh-plugins` 的 `reconcile-plan(userId)` 获取计划，这是计划的唯一来源。每一项必须是带 sha512 的 `name@精确semver`，registry 必须是该用户自己在 `ports.market` 中的端口，地址为 `127.0.0.1` 或 `hostAddress`；否则中止对账。对账入口采用与同步相同的前置条件、用户卸载规则和操作日志，并先用快照完成任何未结的 `failed` 同步记录。
- **pnpm**：release 中附带的对账入口像 `dsh plugin` 那样运行 profile 的 pnpm，并加 `--ignore-pnpmfile`、`--config.registry=<mirror>`、`--config.userconfig=/dev/null`，以及每个允许构建一个 `--allow-build=<pkg>`。它依靠 pnpm 11 默认不运行未被允许的依赖构建，从不设置 `ignore-scripts`，因为那会把允许的构建也一并阻止。升级或降级只是一次 `pnpm add name@version`，因为此时没有运行中的插件管理器持有该包。
- **租户文件**：root 身份的 provisioner 不打开任何租户路径。以账户身份运行的对账入口用 `O_NOFOLLOW` 读取 `package.json` 和 `pnpm-lock.yaml`，只接受不超过 4 MiB 的普通文件，并把快照写入账户自己的 `~/.dsh-market/snapshots/<id>/`。只有哈希写入 `plugin_profile_snapshot`。租户可控的配置（项目 `.npmrc`、`pnpm-workspace.yaml`，包括其中的 `allowBuilds`）最多只能改变该账户自己的 profile，因为进程只有该账户的权限，网络也只有回环。
- **失败处理**：每个包 120 秒，总计 300 秒。任何失败或超时时，入口从快照恢复这两个文件并运行 `pnpm install --frozen-lockfile --offline`，与 `operations.ts` 修复失败安装的做法相同。如果离线安装因存储中缺少某个包而失败，就只针对该用户的镜像在线运行同样的安装。如果这也失败，就保留已恢复的文件和部分安装的状态，记录 outcome 为 `error` 的 `plugin-reconcile`，并把状态标为 `failed`。实例照常启动。

<a id="updates-and-rollback"></a>
## 更新与回滚

- **手动更新。** 用户自己安装的插件由用户更新：Discover 显示 `update-available`，用户先卸载再安装新版本。
- **默认插件更新。** 默认插件的新获批版本在实例空闲时由同步在数分钟内推送，否则在下次启动时由对账应用。默认插件处于 `pending` 时，"我的插件"显示"有更新等待，重启后生效"。
- **重新审批。** 每个版本都是新的 `plugin_version` 行；没有任何版本因继承而获批。
- **市场回滚。** 管理员回滚把上架项退回一个版本；随后同步和对账为状态为 `installed` 的用户降级。手动安装的用户会看到上架版本的变化。
- **已撤销版本。** 手动安装了已撤销版本的用户会在"我的插件"中看到标记，并被提示卸载或更换；同步会在其报告中标出。
- **Profile 回滚。** 每次对账和每次同步应用都会在用户主目录中保存快照，保留最近五个。恢复请求（由用户本人或管理员代该用户发起）进入队列，在下次启动时于对账单元中执行，从不在运行中的实例里执行。快照 id 必须属于该用户，文件哈希必须与记录一致。

<a id="api-list"></a>
## API 列表

管理路由位于 `/api/admin` 下，个人路由位于 `/account/api/me` 下，都由 identity 提供，并带 actor 头转发给 `dsh-plugins`，与 `kb-gateway.ts` 为 KB 服务所做的完全相同。

| 方法与路径 | 调用者 | 重新认证 | 用途 |
|---|---|---|---|
| `GET /plugins` | 管理员 | 否 | 包、上架状态、范围、默认安装、应用人数 |
| `GET /plugins/requests` | 管理员 | 否 | 带镜像状态的审批队列 |
| `GET /plugins/requests/detail` | 管理员 | 否 | manifest、文件列表、依赖闭包、安装脚本标记、差异 |
| `GET /plugins/requests/file` | 管理员 | 否 | 产物中的单个文件，按内容读取审计 |
| `POST /plugins/requests/approve` | 管理员 | 是 | 带范围、允许构建列表和 `expected_artifact_sha512` 批准 |
| `POST /plugins/requests/reject` | 管理员 | 否 | 带原因驳回 |
| `POST /plugins/upload` | 管理员 | 是 | 从 npm、git 或 tarball 直接上架 |
| `POST /plugins/scope` | 管理员 | 是 | 替换上架项的范围 |
| `POST /plugins/rollback` | 管理员 | 是 | 上架项退回一个版本 |
| `POST /plugins/delist` | 管理员 | 是 | 下架一个包 |
| `POST /plugins/relist` | 管理员 | 是 | 重新上架一个包 |
| `POST /plugins/revoke` | 管理员 | 是 | 撤销一个版本 |
| `POST /plugins/defaults` | 管理员 | 是 | 为全公司或部门设置或清除默认安装 |
| `POST /plugins/defaults/reset` | 管理员 | 是 | 清除某个默认安装的 opt-out |
| `GET /plugins/policy` | 管理员 | 否 | 读取策略 |
| `PUT /plugins/policy` | 管理员 | 是 | 修改 `market_only`、`install_scripts`、`egress_lock` |
| `GET /plugins/limits` | 管理员 | 否 | 限额行 |
| `GET /plugins/limits/effective` | 管理员 | 否 | 某用户的生效限额 |
| `PUT /plugins/limits` | 管理员 | 是 | 设置限额行 |
| `DELETE /plugins/limits` | 管理员 | 是 | 删除限额行 |
| `POST /plugins/restore` | 管理员 | 是 | 为某用户排队恢复快照 |
| `GET /plugins`（个人） | 用户 | 否 | 我的提交、我的默认安装及其状态、撤销标记 |
| `POST /plugins/submit`（个人） | 用户 | 否 | 提交一个版本 |
| `POST /plugins/withdraw`（个人） | 用户 | 否 | 撤回待审版本 |
| `POST /plugins/delist-request`（个人） | 用户 | 否 | 申请管理员下架我的包 |
| `POST /plugins/defaults/reenable`（个人） | 用户 | 否 | 重新启用我卸载过的默认插件 |
| `GET /plugins/snapshots`（个人） | 用户 | 否 | 我的 profile 快照 |
| `POST /plugins/restore`（个人） | 用户 | 否 | 排队恢复我的快照 |

provisioner 使用的控制 socket 动词：`open`、`close`、`instance-config`（patch 行、策略、npmrc 内容）和 `reconcile-plan`。错误沿用 KB 约定：400 输入无效，403 不允许（`not-owner`、`self-approval`），404 不存在，409 状态冲突（`pending-exists`、`not-pending`、`not-approved`、`mirror-not-ready`、`artifact-mismatch`、`install-scripts`、`closure-source`、`limit-reached`、`version-exists`、`name-taken`、`no-previous`），413 过大。

<a id="permissions-and-audit"></a>
## 权限与审计

- 只有 `admin` 角色能访问管理路由。identity 在新增的 `plugins-gateway.ts` 中执行 `PLUGIN_ADMIN_ENDPOINTS`、重新认证集合 `PLUGIN_REAUTH` 和事件白名单 `PLUGIN_EVENTS`，仿照 `KB_ADMIN_ENDPOINTS`、`KB_REAUTH` 和 `KB_EVENTS`。不在 `PLUGIN_EVENTS` 中的事件会在取走时被丢弃，因此下表每个事件都列入其中。
- 个人路由只作用于调用者自己的提交、默认安装和快照。
- `dsh-plugins` 把事件写入 `plugin_audit_outbox`，像 `kb_audit_outbox` 一样被取走。`detail` 从不包含产物内容或令牌。
- 带允许构建列表的批准请求写入 `admin-plugin-approve`，列表非空时另写 `admin-plugin-build-allow`，以便单独筛选构建权限。

| 事件 | 执行者 | 详情 |
|---|---|---|
| `plugin-submit` | 用户 | 包、版本、来源类型 |
| `plugin-withdraw` | 用户 | 包、版本 |
| `plugin-expire` | 系统 | 包、版本 |
| `plugin-mirror-failed` | 系统 | 包、版本、原因 |
| `plugin-delist-request` | 用户 | 包 |
| `plugin-default-reenable` | 用户 | 包 |
| `plugin-restore` | 用户 | 快照 id |
| `plugin-sync` | 系统 | 用户、已应用、失败 |
| `plugin-reconcile` | 系统 | 用户、新增、卸载、opted-out、结果 |
| `plugin-store-corrupt` | 系统 | blob 摘要 |
| `admin-plugin-approve` | 管理员 | 包、版本、范围、产物摘要 |
| `admin-plugin-reject` | 管理员 | 包、版本、原因 |
| `admin-plugin-upload` | 管理员 | 包、版本、来源类型、范围 |
| `admin-plugin-scope-change` | 管理员 | 包、原范围、新范围 |
| `admin-plugin-rollback` | 管理员 | 包、原版本、目标版本 |
| `admin-plugin-delist` | 管理员 | 包、原因 |
| `admin-plugin-relist` | 管理员 | 包 |
| `admin-plugin-revoke` | 管理员 | 包、版本、原因 |
| `admin-plugin-default-set` | 管理员 | 包、范围 |
| `admin-plugin-default-clear` | 管理员 | 包、范围 |
| `admin-plugin-default-reset` | 管理员 | 包、范围 |
| `admin-plugin-build-allow` | 管理员 | 包、版本、允许的包 |
| `admin-plugin-policy-change` | 管理员 | 策略、范围、原值、新值 |
| `admin-plugin-limit-change` | 管理员 | 范围、名称、原值、新值 |
| `admin-plugin-limit-delete` | 管理员 | 范围、名称 |
| `admin-plugin-restore` | 管理员 | 用户、快照 id |
| `admin-plugin-content-read` | 管理员 | 包、版本、文件 |

<a id="plugin-limits"></a>
## 插件限额

- `dsh_plugin_limit` 包含 `max_installed`（用户 profile 中的市场包数）、`max_submissions`（用户待审和已上架的包数）和 `max_submission_bytes`（用户提交新增的存储字节）。
- 解析复用泛化到任意限额名之后的 `effectiveLimits`：用户行优先；否则取用户有效组中最宽松的值，有效组与 KB 一样包含上级部门；否则取全局行；`NULL` 表示不限。
- 调低限额从不删除、下架或卸载任何东西。只以 409 `limit-reached` 拒绝增长。
  - 超过 `max_submissions` 或 `max_submission_bytes` 的提交被拒绝。
  - `max_installed` 只在能计数的地方执行：上次同步或对账报告达到上限后，packument 路由拒绝该用户尚未安装的上架包，索引也会标出这些条目。这是尽力而为，因为 tarball 和 git 安装以及过期的报告都能绕过它。
- 默认安装计入 `max_installed`；同步和对账即使超限也会安装它们，因为这是管理员的选择，并记录下来。
- 单个版本的产物上限 200 MiB，低于默认的每用户总额 1 GiB。
- 实例磁盘用量仍受现有 XFS 配额约束。

<a id="system-admin-ui"></a>
## 系统管理界面

- **侧边栏。** "系统管理"在单一侧边栏的子菜单中增加 **插件市场** 一项，与知识库各项并列。不新增侧边栏。
- **页面。** 审批队列、已上架插件（范围、当前和上一版本、回滚、下架、重新上架、应用人数）、上传、默认安装（含重置）、策略（`market_only`、安装脚本、`egress_lock`）、限额（复用 `admin-kb-limits.tsx` 页面），以及按插件事件过滤的审计。
- **个人中心。** 个人中心增加 **我的插件**：提交及其镜像和审核状态、撤回、申请下架、我的默认安装及其状态和"重新启用"、撤销标记、"重启后生效"提示，以及 profile 快照。
- **上游页面不动。** 上游插件页面和 Discover 标签页原样使用；公司索引作为一个索引源出现在其中。公司特有的信息只放在"我的插件"中，因此同步上游时不会冲突。
- **风格。** 新页面只组合 `admin-kit.tsx` 和上游客户端中现有的组件：同样的按钮、图标和组件形态，用现有调色板和 `theme.ts` 中的磨砂玻璃层重新着色，风格克制、企业化。不加新颜色、新图标集或新形态。

<a id="deployment-changes"></a>
## 部署改动

### 共用代码

- `integrations/public-harness/packages/plugins/`：服务、存储、镜像流水线、拉取服务入口、`dsh-plugins-egress`、索引构建和对账入口。
- `integrations/public-harness/packages/plugin-sync/`：实例内同步插件。
- `packages/production/src/plugins-service.ts`、`plugins-fetch.ts` 和 `plugins-egress.ts`：入口，与 `kb-service.ts` 和 `quota-service.ts` 并列。
- `packages/contracts/src/web-rows.ts`：`pluginMarketRows`。
- `packages/identity/src/plugins-gateway.ts`：路由、重新认证、`PLUGIN_EVENTS`、取走 outbox。
- `packages/kb/src/limits.ts`：把 `effectiveLimits` 泛化到任意限额名。

### 原生部署（`integrations/public-harness/deploy/native/`）

- `systemd/dsh-plugins.socket`：由安装程序根据 `ports.market` 生成，每个端口一行 `ListenStream=127.0.0.1:<port>`，`Service=dsh-plugins.service`，用 `ExecStartPost=-<loader>` 加载 `dsh_market` 表，排在 provisioner 和所有实例单元之前。
- `systemd/dsh-plugins.service`：用户 `dsh-plugins`，`Sockets=dsh-plugins.socket`，为最多 4,096 个继承来的监听设 `LimitNOFILE=16384`，`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`（`AF_NETLINK` 用于 `inet_diag` 对端校验），`IPAddressDeny=any`，`IPAddressAllow=localhost`，`ReadWritePaths=/var/lib/dsh-plugins /run/dsh-plugins`，采用 `dsh-quota.service` 的加固参数，`CapabilityBoundingSet=`。它与 `PrivateNetwork=yes`、只用 `AF_UNIX` 的 `dsh-kb.service` 不同，因为它要接受回环连接。
- `systemd/dsh-plugins-fetch.socket` 和 `systemd/dsh-plugins-fetch@.service`，见[拉取服务](#store-and-mirror)。
- `systemd/dsh-plugins-egress.service`：用户 `dsh-plugins-egress`，允许出站网络，无状态，`ProtectSystem=strict`，无 capability。
- `systemd/sysusers.conf`：用户 `dsh-plugins`、`dsh-plugins-fetch`、`dsh-plugins-egress`，以及组 `dsh-plugins-clients`。`dsh-plugins` 组拥有 `/var/lib/dsh-plugins`（0750）和拉取 socket，其唯一成员是 `dsh-plugins`；`dsh-plugins-fetch` 和 `dsh-identity` 都不在该组中。`dsh-plugins-clients` 的唯一成员是 `dsh-identity`；provisioner 以 root 运行。`systemd/tmpfiles.conf`：`/var/lib/dsh-plugins`、`/run/dsh-plugins`、`/run/dsh-public/instance-market`（root 0711）。
- `config/plugins.json.example`：数据库和存储路径、`ports.market`、`egressPort`、`egress.allow`、`egress.intranet`、公司 scope、大小上限、请求有效期。`config/native.json.example` 增加 `paths.instanceMarketDir`；`config/provisioner.json.example` 增加 `ports.market`。
- `runtime-systemd`：
  - `units.ts` 增加第二个 `--patch` 和 `NPM_CONFIG_GLOBALCONFIG`；
  - 新增的 `market-firewall.ts` 为 socket 单元的加载程序渲染 `dsh_market` 表（优先级为 `filter - 2` 的 input 链、`market_listener` 子链和 `market_owner` set）；它不在 `network.install` 之内；
  - `network.ts` 在 `in_<uid>` 最后的丢弃之前加入 `ct mark <uid> iif "lo" tcp dport $MARKET_PORTS accept`，并在 `egress_lock` 下去掉公网放行；
  - `probe.ts` 检查 `dsh_market` 表和两条链，缺失时重新运行加载程序，并使 `market_owner` 与 `plugin_endpoint` 完全一致：删除多余元素并告警，补上缺失元素；
  - `runtime.ts` 在 `network.install` 和单元启动之间加入对账步骤，写入每实例文件，并添加和删除 set 元素。
- 防火墙规则只允许 `dsh-plugins-fetch` UID 访问 `egressPort`，并且该 UID 不能访问其他任何地址。

### Production 容器部署（`integrations/public-harness/deploy/production/`）

- `systemd/`：`dsh-plugins.socket`、`dsh-plugins.service`、`dsh-plugins-fetch.socket`、`dsh-plugins-fetch@.service` 和 `dsh-plugins-egress.service`，沙箱与上面相同；`sysusers.conf` 和 `tmpfiles.conf` 增加同样的账户和目录。
- `config/plugins.example.json`；`config/provisioner.example.json` 增加 `ports.market` 和 `paths.marketDir`。
- `nftables/dsh-public.nft`：`define MARKET_PORTS`、位于 `oif "lo" drop` 之前的 `oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept`、`egress_locked` set 及其规则，以及把 `dsh-plugins-fetch` 限定为只能访问 `egressPort` 的规则。
- `nftables/dsh-market.nft`：`dsh_market` 表，含 `market_listener` input 子链、`market_owner` set，以及优先级为 `filter - 2` 的 output 链中的属主丢弃规则；由 socket 单元的 `ExecStartPost=-` 加载，从不随 `dsh-public.nft` 一起加载。
- `provisioner/src/runtime.ts`：`webPatch` 用 `hostAddress` 加入 `pluginMarketRows`；`assertSafeRunArgv` 放行只读市场卷；provisioner 添加和删除 set 元素，并运行一次性对账容器。`provisioner/src/config.ts` 校验 `ports.market`。
- `README.md` 记录改变后的决定：市场端口段存在按用户的防火墙元素。

### 启动行为

- 市场故障从不阻止实例启动：没有 `dsh-plugins` 时，实例在没有市场行的情况下启动，并记录故障。socket 单元仍持有端口段。
- `plugins.json` 存在之前该功能保持关闭。

<a id="public-market-later"></a>
## 以后增加公共市场

- 管理员订阅外部索引 URL；由拉取服务通过 `dsh-plugins-egress` 读取，从不在实例中读取。
- 公共条目只是候选：管理员导入某个版本，走同样的镜像和审核，`origin = 'public'`，使用其公开包名并遵守 `name@version` 不变量。
- 个性化索引仍是一个文档；每个实例增加第二个索引 URL、单独列出获批的公共包，是一个可选方案。
- 签名（二期）适用于两者：上游包用 npm provenance 或 Sigstore，每份个性化索引和产物用公司签名。

<a id="risks-and-unverified-items"></a>
## 风险与未验证项

### 风险

- **二期之前索引未签名。** 信任来自通道：回环、由 systemd 持有的监听、两种运行时中的接收方 socket 规则和端口所有者规则，以及 npm 令牌。主机被攻破则全部失效。
- **没有 `egress_lock` 时 `market_only` 是软约束**，其强度还取决于第 0 阶段要验证的 patch 顺序。它的全局 npmrc 还会让用户自己项目的安装也指向镜像。
- **兜底模式更弱。** 以兜底模式提供的版本，其传递依赖只限于审核过的 tarball，但不固定组合；Discover 和手动安装没有 lockfile 检查。
- **依赖闭包漂移。** 依赖闭包在审核时冻结；依赖以后的安全修复需要新版本和新审核。
- **重新打包的产物。** 公开 npm 包名的公司产物与公开 tarball 的完整性值不同。在 `market_only` 下 npmrc 把 `registry=` 指向镜像，因此修复也在镜像中解析。没有它时，以后若从公共 registry 重新安装这个无 scope 的包名，会在 lockfile 完整性校验时失败。失败是安全的，同步或对账会从镜像重新安装；用户自己手动修复需要加 `--registry=<mirror>`，"我的插件"会给出提示。
- **同步竞争窗口。** 同步插件无法在 `installBundle` 的整个过程中持有插件管理器的锁，因此一期依靠事后检查：组合包先装成禁用，第二次检查通过后才启用。窗口内最多只有管理员为该版本允许的安装脚本运行过。没有 HMR 时，已启动的组合包无法删除，要等对账处理。
- **账户数上限。** 每个市场端口一行 `ListenStream`，每个账户一个端口，因此最多 4,096 个账户能使用市场（开放问题 9）。`dsh-plugins` 以 `LimitNOFILE=16384` 运行；第 0 阶段检查启动时间。
- **白名单维护。** registry 把 tarball 迁到新的 CDN 主机后，在更新 `egress.allow` 之前拉取会失败。
- **实例内同步受租户控制。** 用户可以禁用或修改它；这只影响其自己的默认安装和软限额。
- **单独加载的市场表。** `dsh_market` 可能丢失，例如 `nftables.service` 重启时执行 `flush ruleset`。在探测于一分钟内重新加载并填满它之前，只靠覆盖整个端口段的放行规则，任何实例账户都能访问任何市场端口；这段时间由 `dsh-plugins` 中的 `inet_diag` 对端校验把它们挡在外面，其后还有 bearer 令牌。过期的 set 元素会在下一次探测时删除并告警。
- **防火墙决定改变。** 容器防火墙增加按用户的元素，provisioner 必须保持同步；过期元素在实例停止和 provisioner 启动时清除。

### 未验证项

- **每实例 patch 与 insert。** 第二个原生 `--patch` 文件中的 `insert` 行能否在 profile 自身组合包设置之外正确挂载 `plugin-market`、`ui-plugin-market` 和 `public-harness-plugin-sync`，以及用户在设置页修改 `indexes` 或 registry 时哪个值生效。
- **pnpm 11 的行为。** 标准 tarball 路径加 scope 映射的 registry 能否在端口变化后仍让 `pnpm-lock.yaml` 中没有 tarball URL；`NPM_CONFIG_GLOBALCONFIG` 能否提供认证令牌；peer 自动安装是否会向镜像请求 `@deepseek-ai/dsh*`；npmrc 中有无 `registry=` 时，修复如何解析重新打包的公共包名。
- **固定产物。** pnpm 11 能否正确安装带 `bundleDependencies` 的产物，以及 `allowBuilds` 是否管控被打包依赖的脚本。证明之前，带安装脚本的版本使用兜底模式。
- **构建默认值。** pnpm 11 在同步和对账中是否不运行 `--allow-build` 和 `allowBuilds` 之外的任何依赖构建。
- **监听的 cgroup。** 监听 socket 位于 `system.slice/dsh-plugins.socket`（支持 BPF 防火墙时很可能如此）还是 `init.scope`；accept 出来的连接是否继承它；socket 单元重启后 `dsh_market` 规则是否需要重新加载。
- **禁用安装。** 启用 HMR 时，带 `enabled: false` 的 `installBundle` 是否不启动该组合包的任何插件，之后 `setBundleEnabled` 是否能启动它们。
- **空闲检测。** 哪个现有信号能告诉同步插件当前没有 agent 轮次在运行。
- **安装前置条件。** 上游是否接受为 `installBundle` 增加可选的前置条件选项；本设计不需要它。
- **容器对账。** 使用实例卷和网络的一次性 `runsc` 容器。
- **git tarball。** 由 git blob 构建的 tarball 能否与 `npm pack` 产物安装方式相同，包括 `files` 和 `.npmignore` 的文件选择。
- **Discover 的客户端完整性校验。** 在上游定义完整性成员之前无法实现。

<a id="test-plan"></a>
## 测试计划

任何测试都不使用真实模型密钥或模型调用。所有监听只绑定 `127.0.0.1` 或 Unix socket。

- **单元测试。**
  - 状态转移表：每一行和每个拒绝码，包括驳回、撤回和过期后的重新提交，未归属包名的释放，以及两个部分唯一索引。
  - 批准绑定：`expected_artifact_sha512` 与已存摘要不同的批准请求得到 409 `artifact-mismatch`；`ready` 的版本不会再次镜像。
  - 上架指针：高于、等于和低于当前版本的批准；回滚；有无上一版本时撤销当前版本；下架和范围变更后的供给规则。
  - 可见性：全公司、部门、上级部门、多个部门、已禁用用户。
  - 限额：用户行优先、最宽松的部门、全局回退、调低保留数据、增长得到 409。
  - 索引构建：通过 `parseMarketIndex` 的格式 1 有效性、以秒计的 `publishTimestamp`、内联图标、稳定摘要。
  - packument 路由：三种 scope 包名写法、标准 tarball 路径、只含可见版本。
  - 令牌：常数时间比较；错误令牌与不可见上架项的响应完全相同。
  - 端口：每个用户一个端口，每个端口一个用户；只有行被删除后端口才会重新分配；已删除账户的行在 provisioner 启动时被清除。
  - 上传解包：绝对路径、`..`、符号链接和硬链接、设备文件、条目数和大小上限。
  - 安装脚本检测：`preinstall`、`install`、`postinstall`、`prepare`、`gypfile` 和 `binding.gyp` 逐项覆盖；除非第 0 阶段的开关允许，带脚本的闭包从不以打包模式构建。
  - 拉取服务帧格式：未知动词、多余参数和超出白名单的参数都在使用网络之前被拒绝。
  - 同步前置条件：包已不存在或处于其他版本时跳过 `update`；用户卸载后跳过 `install`；同步插件安装过、现在不存在且没有同步 `removed` 记录的包算作用户卸载；`opted-out` 只来自这类记录。
- **集成测试。**
  - Identity 网关：白名单、所列路由的重新认证、`PLUGIN_EVENTS` 被取走、自审被拒绝。
  - 出网与 SSRF：闭包含 git、tarball URL、`file:`、`link:` 或别名依赖时在运行 pnpm 之前被拒绝；`dist.tarball` 指向其他主机时被拒绝；重定向到未列出的主机失败；白名单域名的任一 A 或 AAAA 记录落在禁止地址段时被拒绝，包括 `::ffff:127.0.0.1`、`64:ff9b::` 和 `2002::` 形式；以 IP 字面量为目标被拒绝；域名在检查与连接之间重新解析到其他地址时，仍然只连到已检查的地址；只有拉取 UID 能访问代理。
  - 冲突：为已存在的 `name@version` 再提交另一个产物；公司 scope 包名在上游已存在。
  - 存储被篡改：被修改的 blob 被隔离并返回 503。
  - `pluginMarket` 从监听端口读取个性化索引，包括 `maxBytes` 和不重定向。
- **端到端**（原生栈，扩展 kb-stack e2e 测试框架；运行时在范围内时也覆盖容器栈）：
  - 属主可达：两种运行时中属主账户都能连上自己的市场端口，并取得自己的索引和 packument；这是放行规则的正向用例。
  - 跨租户：两种运行时中其他账户都无法连接某用户的端口；错误令牌得到 404。
  - 表丢失：执行 `nft flush ruleset` 后实例继续运行，其他账户到某用户端口的连接在读取任何字节之前被对端校验关闭；一分钟内探测重新加载 `dsh_market` 并填满 set，属主重新能连上自己的端口。
  - 集合漂移：多出的过期元素在下一次探测时被删除并告警；缺失的元素被补回，且不影响其他用户。
  - 对端校验：对端 UID 与端口属主不同或查询失败的连接，不读取就被关闭；属主的连接正常提供服务。
  - 端口劫持：`dsh-plugins` 停止时，其他账户无法绑定市场端口；socket 单元也停止时，绑定了用户 B 端口的账户收不到来自 B 的任何连接。测试覆盖实例列表的每种顺序。
  - 宿主机账户：root、`dsh-router`、`dsh-identity` 以及未映射的端口都被端口所有者规则拒绝。
  - 部门用户能看到部门上架项；其他人看不到，其产物对他们返回 404。
  - 在测试网络关闭公网出站的情况下，Discover 安装市场插件；lockfile 中没有 tarball URL，并且在实例重启、端口变化和 `dsh-plugins` 重启之后仍可安装。
  - 默认推送：实例运行时批准一个新的默认版本；同步在空闲时应用；完整性不一致时回滚。
  - 同步竞争：用户在重新读取和启用之间卸载该包，这个从未启用的组合包被删除，其插件一个也没有启动；完整性不一致时插件从未启动；`removeBundle` 成功而 `installBundle` 失败时，旧版本被恢复，或由下一次对账恢复；没有 HMR 时，检查失败由对账恢复。
  - 对账：在防火墙规则就位后于实例 slice 中运行，环境变量严格符合白名单，忽略预置的 `.pnpmfile.cjs` 和恶意 `.npmrc`，超时后回滚，离线修复缺包时改为在线从镜像安装，实例仍能启动。
  - 快照：被替换成符号链接的 `package.json` 被拒绝；恢复只在下次启动时执行，且只针对所有者自己的快照。
  - 卸载：用户通过 Discover、`dsh plugin remove` 或手工编辑 `package.json` 卸载默认插件；每种情况下，在重置或重新启用之前，同步和对账都不会重新安装。
  - 撤销：完整流程，包括手动安装的已撤销版本在"我的插件"中的标记。
  - 构建脚本：允许的构建在同步和对账中运行；未允许的不运行。
  - `market_only` 使市场外的 registry spec 以未找到失败；`egress_lock` 阻断公网 `443` 但不影响模型调用。
- **防火墙渲染。** `network.ts` 和 `dsh-public.nft` 的规则测试：市场链先于按实例分发执行，容器规则位于范围外放行之前；安装和移除实例后市场规则仍然存在；`dsh-plugins` 停止时 `network.install` 仍能成功，且从不加载 `dsh_market`；属主放行规则位于 `in_<uid>` 最后的丢弃之前和 `oif "lo" drop` 之前；加载程序在重新加载时保留 set 元素；未映射的端口被 `!=` 集合查找丢弃；拉取 UID 只能访问 `egressPort`；set 元素的添加和删除；探测能发现缺失的市场规则或 set 元素。配置校验拒绝重叠、超出范围或过大的 `ports.market`。
- **回归。** 上游 plugin-market 和 plugin-manager 测试原样运行。

<a id="phased-implementation-plan"></a>
## 分阶段实施计划

按用户的决定，第 1 阶段即一期，第 2 阶段即二期。第 0 阶段最先进行，其结果可能调整第 1 阶段的细节。

### 第 0 阶段：验证性探索

1. 第二个原生 `--patch`，用 `insert` 行加载 `plugin-market`、`ui-plugin-market` 和一个同步插件桩。鉴于 CLI 在 profile 之后应用 patch，确认用户在设置页修改 `indexes` 或 registry 时哪一层生效。
2. 用 pnpm 11 对接最小的回环 registry：在标准路径和 scope 映射下端口变化前后的 lockfile 内容；通过 `NPM_CONFIG_GLOBALCONFIG` 的认证；对已提供 peer 的请求；npmrc 中有无 `registry=` 时修复重新打包的公共包名。
3. 用 pnpm 11 安装 `bundleDependencies` 产物，以及 `allowBuilds` 是否管控带脚本的被打包依赖。确认 pnpm 不运行 `--allow-build` 之外的构建。
4. 在实例 slice 中以 `IPAddressAllow=localhost` 运行的对账临时单元；确认 `--ignore-pnpmfile` 和 `--config.userconfig` 生效。
5. 容器：经 pasta 的 `meta skuid . tcp dport` 匹配，以及一次性对账容器。
6. 用 git blob 构建 tarball，与 `npm pack` 产物比较。
7. 为同步插件找到空闲信号；确认启用 HMR 时 `installBundle(..., { enabled: false })` 不启动任何插件。可选：向上游提议为 `installBundle` 增加前置条件选项。
8. 覆盖完整端口段的 `dsh-plugins.socket`：在 `LimitNOFILE=16384` 下的启动时间；监听 socket 属于哪个 cgroup，`init.scope` 和 `system.slice/dsh-plugins.socket` 两种都测；accept 出来的连接是否继承它；`dsh-plugins` 停止时 `dsh_market` 加载程序能否在 `ExecStartPost` 中正常工作；以及 socket 单元重启后规则是否需要重新加载。
9. 在带沙箱的非特权 `dsh-plugins.service` 中做 `inet_diag` 对端校验：四元组精确的 `NETLINK_SOCK_DIAG` 查询能否在 `127.0.0.1` 上以及经 pasta 时返回对端 UID，以及每次 accept 的开销。

### 第 1 阶段（一期）

里程碑 1A，存储与镜像：

1. `packages/plugins`，含 schema、部分索引和迁移。
2. `dsh-plugins-egress`、带固定动词的 socket 激活拉取服务，以及 SSRF 检查。
3. npm 和上传的镜像：闭包解析、安装脚本检测、打包模式和兜底模式、`name@version` 不变量、完整性巡检。
4. 管理员直接上传，全公司范围，需要重新认证，带审计。

里程碑 1B，服务：

1. `dsh-plugins.socket`、一一对应的端口、路由、令牌。
2. 原生：第二个 patch、npmrc、单独加载的 `dsh_market` 表、`in_<uid>` 中的属主放行、`inet_diag` 对端校验、带集合完全比对的探测自愈、配置校验。
3. `pluginMarketRows`，以及 provisioner 的 `open` 和 `close` 调用。

里程碑 1C，审核流程：

1. 提交、所有权、包名释放、拒绝自审、撤回、过期、申请下架。
2. 经出网代理的 git 来源。
3. 审批队列、详情、文件查看、带范围、允许构建列表和 `expected_artifact_sha512` 批准、驳回。
4. 部门范围、范围变更、下架、重新上架、撤销，以及按指针规则回滚。
5. 带 `PLUGIN_EVENTS` 的 `plugins-gateway.ts`；系统管理页面和"我的插件"。

里程碑 1D，默认安装与更新：

1. 默认安装、重置和重新启用。
2. 同步插件：前置条件、先禁用安装再启用、用户卸载规则、操作日志、恢复、完整性检查和报告。
3. 启动前对账：快照、回滚、在线兜底和排队恢复。

里程碑 1E，策略、限额与容器：

1. 泛化的 `effectiveLimits` 和 `dsh_plugin_limit`。
2. 按全公司或部门的 `market_only`；安装脚本策略。
3. 容器运行时：`market_owner` set、接收方 socket 规则、`webPatch` 行、市场卷、一次性对账。如果开放问题 4 决定一期只支持原生，这一项移到二期。

### 第 2 阶段（二期）

1. 签名校验：拉取时校验 npm provenance 或 Sigstore，并对个性化索引和产物签名。
2. 以只读主机视图交付的纯技能包。
3. 如果开放问题 1 选择采用，则实现 `egress_lock`。

### 以后

1. 公共市场订阅。
2. 强制安装。
3. 四眼审批规则。

<a id="open-questions"></a>
## 开放问题与推荐默认值

问题 1 到 9 需要用户决定；其余问题已有默认值，可随评审一并确认。

1. **"仅允许从市场安装"的力度。** 推荐默认：只做策略；`egress_lock` 作为按部门的显式选择，因为它会断掉浏览、git、pip 和公共 npm。不开它时，用户可以在自己的 npmrc 中把 registry 改回去，git 和 tarball 安装照常可用。需要接受两个影响：`market_only` 下全局 npmrc 会让实例中所有 npm 安装都走镜像，包括用户自己的项目；而且由于 CLI 在 profile 之后应用 patch，用户在设置页修改的 `indexes` 和 registry 可能在每次启动时被覆盖（第 0 阶段确认）。
2. **签名校验何时上线。** 推荐默认：按已定需求放在二期。文档已放在那里，请确认。
3. **默认插件的"自动推送"指什么。** 推荐默认：实例空闲时由同步插件在约 5 分钟内实时推送；下次启动作为兜底，并显示"重启后生效"提示，管理员可看到待生效人数。
4. **一期支持哪些运行时。** 推荐默认：两种都支持，容器放在里程碑 1E。如果用户倾向，一期只支持原生，容器移到二期。
5. **管理员能否批准自己通过路径 A 提交的插件。** 推荐默认：不能；他们改走路径 B，并以上传的形式被审计。
6. **git 和上传来源是否必须使用公司 scope，以及 scope 名称。** 推荐默认：是，使用公司内部开发包都不用的专用 scope（如 `@corp-dsh/`），且包名不得在上游存在。
7. **推翻 production README 的既有决定。** 容器防火墙原本不放按用户的规则；现在市场端口段增加按用户的 set 元素和接收方 socket 规则，并且 root、`dsh-router`、`dsh-identity` 等宿主机账户被挡在市场端口之外。推荐默认：接受，仅限市场端口段。
8. **一期接受的剩余风险。** 推荐默认：三项都接受：
   - 带安装脚本的版本（或第 0 阶段否定打包模式后的所有版本）使用兜底模式：传递依赖只限于审核过的 tarball 而不固定组合，Discover 和手动安装没有 lockfile 检查；
   - 默认推送的竞争窗口：采用先禁用安装、检查后再启用之后，窗口内最多只有管理员允许的安装脚本运行过；
   - 二期之前索引未签名。
9. **规模。** 每个账户在存在期间占用一个市场端口；上限 4,096，即最多 4,096 个账户能使用市场。推荐默认：4,096；否则请给出预期账户数。
10. **安装脚本。** 推荐默认：除非管理员逐个允许这些包，否则拒绝，检测范围包括 `prepare` 和 `binding.gyp`。
11. **卸载默认插件是否永久生效。** 推荐默认：是，直到管理员重置该默认安装，或用户在"我的插件"中重新启用。
12. **限额值。** 推荐默认：全局 `max_installed` 50、`max_submissions` 20、`max_submission_bytes` 1 GiB；单个版本的产物不超过 200 MiB；单个上传 tarball 不超过 50 MiB。
13. **需要构建步骤的 git 来源。** 推荐默认：不支持；须提交构建产物或发布到 npm。
14. **提交者能否下架自己的插件。** 推荐默认：不能；可以申请下架。
15. **镜像保留。** 推荐默认：保留上架历史引用的每个产物；已撤销版本立即停止提供，90 天后由管理员显式操作清除。
16. **git 来源的凭据。** 推荐默认：用户提交不带凭据拉取；只读部署令牌只用于管理员上传。
17. **纯技能包。** 推荐默认：支持，放在二期。
18. **单用户范围。** 推荐默认：不提供；只有部门和全公司。

<a id="sources"></a>
## 来源

- [插件市场索引格式](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)
- [插件市场 Discover](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md)
- [插件安装 registry](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md)
- [LLM Wiki 知识库设计](2026-10-17-llm-wiki-knowledge-base-design.zh.md)
- [公开 Harness 原生设计](2026-10-11-public-harness-native-design.zh.md)
