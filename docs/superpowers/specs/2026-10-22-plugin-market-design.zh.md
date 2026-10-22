# 公司插件市场设计

[English](2026-10-22-plugin-market-design.md) | 中文

## Summary

本文是供评审的设计说明，不含实现代码。它为[原生公开 Harness 部署](2026-10-11-public-harness-native-design.zh.md)增加公司插件市场。它扩展上游已有的插件市场，而不是替换它：[索引格式 1](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)、[Discover 说明](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md)中描述的 Host `pluginMarket` 服务和 Web **Discover** 标签页，以及[插件安装 registry 说明](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md)中的 registry 计划。

新的主机服务 `dsh-plugins` 维护经过审核的插件目录，把每个获批版本及其依赖闭包镜像到按内容寻址的公司存储中，并为每个运行中的实例打开一个回环监听端口。该端口向实例提供个性化的 `index.json`（按可见范围计算，做法与[知识库设计](2026-10-17-llm-wiki-knowledge-base-design.zh.md)计算 KB 视图相同），以及一个只包含获批 tarball 的只读 npm registry。实例防火墙对内网保持关闭：实例唯一新增能访问的只有它自己的监听端口。插件通过两条路径进入目录：用户提交、管理员审批并选择可见范围（复用 KB 共享审批流程）；或管理员在"系统管理"中直接上传上架。每一步都写入 `admin-plugin-*` 或 `plugin-*` 审计事件，并且都可以回滚。用户通过所有现有路径自行安装和更新插件。管理员可按部门或全公司设置默认安装；默认安装在实例启动前于主机侧对账，新获批的版本在下次启动时送达。

## Contents

- [目标与非目标](#goals-and-non-goals)
- [现有系统事实](#current-system-facts)
- [架构概览](#architecture-overview)
- [包类型与索引扩展](#package-kinds-and-index-extensions)
- [数据模型](#data-model)
- [存储与镜像](#store-and-mirror)
- [通过主机代理为实例提供服务](#serving-instances)
- [上架流程与状态机](#listing-flows)
- [安装与策略](#installation-and-policy)
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
- 只允许固定且经过审核的版本：npm 版本固定精确版本号和完整性哈希，git 来源固定精确提交，每个新版本都要重新审核。
- 市场安装时实例从不访问内网或上游 registry，只从它自己回环端口上的公司镜像获取。
- 两条上架路径，都有审计、都可回滚：用户提交加管理员审批，以及管理员直接上传。
- 按部门或全公司的默认安装，用户可以卸载；这些默认插件的新获批版本自动送达。
- 所有现有安装路径继续可用：`dsh plugin add`、插件页面、`plugin_manager` 工具和手动 URL。
- 对每用户插件数和提交存储设限，复用 `dsh_kb_limit` 的三级限额规则。
- 为以后增加公共市场留出空间，不需要改数据模型。

### 非目标

- 前几个阶段不做签名校验；它在第 6 阶段。
- 不做用户无法卸载的强制安装；以后再做。
- 不自动更新用户手动安装的插件；用户手动更新。
- 不修改上游索引格式版本、`pluginMarket` 服务或 Discover 界面，只使用旧读取器会忽略的索引成员。
- 主机上不做构建步骤：git 来源必须包含构建产物。
- 不重新设计插件页面或系统管理；现有按钮、图标和组件形态保持不变。

<a id="current-system-facts"></a>
## 现有系统事实

以下事实读自仓库，并决定了本设计。

- **索引格式 1**（`packages/util/plugin-market-index/src/types.ts`、`index.ts`）：插件有 `name`、展示字段、`dist-tags` 和 `versions[]`；版本有 `version`、`publishTimestamp`、`source` 和 `engines.dsh`。npm 来源是 `{ type: 'npm', registry? }`，没有完整性成员；git 来源是 `{ type: 'git', url, commit, path? }`，commit 为 40 位十六进制。读取器在每一层都忽略未知成员，但拒绝未知的 `source.type`。`marketInstallTarget` 是安装参数的唯一构造者：npm 为 `<name>@<version>`，git 为 `git+<url>.git#<commit>`；客户端从不安装 `name@latest`。
- **Host 读取器**（`packages/boot/plugin-market/src/index.ts`）：`indexes` 是易变配置字段，由设置页写入而不重新挂载；`fetchTimeoutMs` 默认 15 秒，`maxBytes` 默认 128 MiB，`cacheTtlMs` 默认 10 分钟。它以 `redirect: 'error'` 获取，只带 `accept` 头，因此无法发送凭据。`normalizeIndexUrl`（`index-url.ts`）拒绝带凭据或片段的 URL。`search.ts` 每页最多返回 100 项。
- **可选组合包**（`packages/experimental/plugin-market-bundle/cordis.patch.yml`）：插入 `plugin-market` 行（没有 profile 时禁用）和 `ui-plugin-market` 浏览器行。随附的 profile 默认关闭它。
- **Discover 标签页**（`packages/client/ui-plugin-market/src/client/DiscoverSection.tsx`、`market-store.ts`）：通过宿主的 `install(spec, registry?)` 安装，条目的 registry 只用于那一次安装。`plugin_market` 工具（`packages/boot/plugin-market/src/tools.ts`）为 `plugin_manager` `install_bundle` 返回 target 和 registry，后者仍需审批。
- **插件管理器**（`packages/boot/plugin-manager/src/index.ts`、`registry.ts`、`build-approval.ts`）：`installBundle(spec, options)` 运行 pnpm，失败时恢复 `package.json` 和 `pnpm-lock.yaml`；启用 HMR 时拒绝已安装的包，因此升级是先卸载再安装。配置集合之外被请求的 registry 只单独询问，不会回退到公共 registry。构建脚本只有被批准写入 `allowBuilds` 后才会运行。
- **生成器**（`apps/plugin-market-generator/src/sources.ts`、`fetchers.ts`、`generate.ts`）：读取 npm 包名和 git URL，按 registry 的完整性校验 npm tarball，在禁用 hook 的私有裸仓库中读取 git 对象，从不运行包代码。它的获取规则是镜像的样板。
- **KB 共享流程**（`integrations/public-harness/packages/kb/src/share.ts`）：每个 KB 只有一个待审请求，请求有效期 30 天（`REQUEST_TTL_MS`），审批时带解析后的范围（`parseScope`），另有驳回、撤销和回滚；快照不可变。
- **KB 视图**（`integrations/public-harness/packages/kb/src/views.ts`）：`visibleEntries` 选出范围为 `company`、用户所在组之一或该用户本人的发布，跳过已禁用的主体；`reconcileViews` 重新应用它们。
- **三级限额**（`integrations/public-harness/packages/kb/src/store.ts`、`limits.ts`、`limits-admin.ts`）：`dsh_kb_limit` 的行范围为 `global`、`group` 或 `user`；`effectiveLimits` 先取用户行，其次取用户所在各组中最宽松的值，最后取全局值。调低限额从不删除数据；超出限额的增长以 409 拒绝。
- **审计与重新认证**（`integrations/public-harness/packages/identity/src/kb-gateway.ts`、`admin.ts`）：`KB_ADMIN_ENDPOINTS` 是管理路由白名单，`KB_REAUTH` 列出需要新鲜 SSO 会话或密码的路由，`KB_EVENTS` 列出接受的事件。KB 服务把事件写入 `kb_audit_outbox`，由 identity 取走。
- **Root helper**（`integrations/public-harness/packages/kb/src/root-helper.ts`、`deploy/native/systemd/dsh-kb-root.socket`、`dsh-kb-root@.service`）：socket 激活的 root helper，动词集合固定（`ROOT_VERBS`），根据用户 id 重新推导账户和路径。
- **实例网络**（`integrations/public-harness/packages/runtime-systemd/src/network.ts`、`deploy/production/nftables/dsh-public.nft`）：实例账户在回环上只能新建到它自己配额端口的连接；私有地址段被丢弃；公网 `80` 和 `443` 保持开放。容器运行时通过 pasta 的主机回环映射放行 `QUOTA_PORTS` 端口段。
- **启动补丁**（`integrations/public-harness/packages/contracts/src/web-rows.ts`、`packages/provisioner/src/runtime.ts`）：补丁行为内置条目设置配置或禁用它们；`kbSkillRows` 为 `skill-filesystem` 增加一个只读的 `customSkillDirs` 条目。
- **管理界面**（`integrations/public-harness/packages/ui/src/client/nav.tsx`、`admin.tsx`、`admin-kit.tsx`、`admin-kb-limits.tsx`、`theme.ts`）："系统管理"（`team.admin`）在单一侧边栏中为 `admin` 角色注册；`theme.ts` 已包含企业磨砂玻璃层。

<a id="architecture-overview"></a>
## 架构概览

```text
                         identity (System Admin, /account/api/me)
                                   |  Unix socket, actor headers
                                   v
  upstream npm / intranet git  <- dsh-plugins (host, user dsh-plugins) -> SQLite catalogue
  (host egress only)              |  fetch, verify, store             -> /var/lib/dsh-plugins/store (sha512)
                                   |  per-instance listener 127.0.0.1:<marketPort>
                                   v
  instance (tenant uid) -- pluginMarket.indexes --> /m/<cap>/index.json
                        -- pnpm --registry -------> /m/<cap>/npm/...
  dsh-plugins-root@ (root helper): reconcile defaults as the tenant before the instance starts
```

- `dsh-plugins` 是与 `dsh-kb` 同类的主机服务：它在私有 Unix socket 上为 identity 和 provisioner 提供服务，信任 identity 设置的 actor 头。
- 只有 `dsh-plugins` 通过主机的进程代理访问上游 registry 和内网 git 服务器。实例保持现有防火墙。
- 每个运行中的实例，provisioner 都请 `dsh-plugins` 在新的 `ports.market` 端口段中打开一个监听端口，就像它现在为配额监听所做的那样。原生运行时只允许该账户访问该端口；容器运行时放行整个端口段，由不可猜测的路径能力串区分用户。
- 实例的 `pluginMarket.indexes` 由启动补丁设置为该监听端口的索引 URL。Discover、`plugin_market` 工具和 `plugin_manager` 因此无需改动即可工作。
- root helper 在实例启动前以租户身份对账默认安装，使用现有的 `dsh plugin` 命令，它在 profile 中运行 pnpm（`dsh plugin add`，卸载步骤用 `dsh plugin remove`）。

<a id="package-kinds-and-index-extensions"></a>
## 包类型与索引扩展

### 类型

- **bundle**：`package.json` 声明了 `dsh.bundle` 的 npm 包，是上游索引目前唯一列出的类型。
- **skill**：纯技能包，即一组 `SKILL.md` 目录，没有要加载的代码。它不是 Cordis 组合包，pnpm 也无法激活它，因此从不写入 `index.json`。主机把获批的技能包链接到每用户的只读目录中（做法与构建 KB 视图相同），启动补丁像 `kbSkillRows` 那样把该目录加入 `skill-filesystem` 的 `customSkillDirs`。它在第 5 阶段到来。

### 在格式 1 内新增的索引成员

旧读取器忽略未知成员，因此个性化索引在不改变 `format` 的前提下增加以下成员：

```json
{
  "format": 1,
  "title": { "en": "Company market" },
  "plugins": [{
    "name": "@corp/dsh-example",
    "versions": [{
      "version": "1.4.2",
      "publishTimestamp": 1792000000000,
      "source": {
        "type": "npm",
        "registry": "http://127.0.0.1:20210/m/CAPABILITY/npm/",
        "integrity": "sha512-BASE64"
      },
      "engines": { "dsh": ">=0.40.0" },
      "x-dsh-company": { "origin": { "type": "git", "url": "https://git.corp.example/team/dsh-example", "commit": "GIT_COMMIT_40_HEX" }, "approvedAt": 1792000000000, "default": true }
    }]
  }]
}
```

- `source.integrity` 是镜像 tarball 的 SRI sha512，与镜像 packument 报告、pnpm 校验的值相同。以后会向上游提议把它作为可选成员。
- `x-dsh-company` 携带原始来源、审批时间，以及该插件对此用户是否为默认安装。Discover 会忽略它；公司插件面板读取它。
- 每个版本都以指向镜像的 npm 来源提供，包括从 git 审核的版本，因为实例无法访问内网 git 服务器。固定的提交保存在 `x-dsh-company.origin` 中。
- 图标内联为不超过 32 KiB 的 `data:` URL；URL 图标从不透传，因此实例不会访问第三方主机。

<a id="data-model"></a>
## 数据模型

所有表都在 `dsh-plugins` 的 SQLite 数据库中。用户和组通过 KB 服务使用的同一主体同步，从 identity 的 `dsh_user_group` 读取。

```sql
CREATE TABLE plugin_package (
  id TEXT PRIMARY KEY,                       -- plg_ + 16 base32 chars
  name TEXT NOT NULL UNIQUE,                 -- npm package name
  kind TEXT NOT NULL CHECK (kind IN ('bundle', 'skill')),
  origin TEXT NOT NULL CHECK (origin IN ('submitted', 'admin', 'public')),
  owner_user_id TEXT,                        -- submitter; NULL for admin uploads
  display TEXT NOT NULL,                     -- JSON: title, description, author, homepage, repository, metadata
  icon_sha512 TEXT,                          -- inlined icon blob
  created_at INTEGER NOT NULL,
  delisted_at INTEGER) STRICT;

CREATE TABLE plugin_version (
  id TEXT PRIMARY KEY,                       -- plv_ + 16 base32 chars
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  version TEXT NOT NULL,                     -- exact SemVer
  source TEXT NOT NULL,                      -- JSON: {type:'npm',registry,integrity} | {type:'git',url,commit,path} | {type:'upload'}
  tarball_sha512 TEXT,                       -- set once mirrored
  size_bytes INTEGER,                        -- tarball plus closure bytes not shared with other versions
  engines_dsh TEXT,
  install_scripts TEXT NOT NULL DEFAULT '[]',   -- JSON: closure packages that declare install scripts
  allowed_builds TEXT NOT NULL DEFAULT '[]',    -- JSON: packages an admin allowed to build
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'revoked')),
  requested_by TEXT NOT NULL, request_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (package_id, version)) STRICT;

CREATE TABLE plugin_closure (                -- every tarball one version installs
  version_id TEXT NOT NULL REFERENCES plugin_version(id),
  name TEXT NOT NULL, version TEXT NOT NULL, sha512 TEXT NOT NULL,
  has_install_script INTEGER NOT NULL,
  PRIMARY KEY (version_id, name, version)) STRICT;

CREATE TABLE plugin_blob (                   -- content-addressed store index
  sha512 TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_listing (                -- what is listed now
  package_id TEXT PRIMARY KEY REFERENCES plugin_package(id),
  current_version_id TEXT NOT NULL REFERENCES plugin_version(id),
  previous_version_id TEXT REFERENCES plugin_version(id),
  generation INTEGER NOT NULL, listed_by TEXT NOT NULL, listed_at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_listing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL, version_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('list', 'update', 'rollback', 'delist', 'relist', 'scope')),
  detail TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_scope (                  -- who sees a listing
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,                      -- '*' for company, group id otherwise
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE plugin_default (                -- default installs
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,
  set_by TEXT NOT NULL, set_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE plugin_default_state (          -- what reconcile did per user
  user_id TEXT NOT NULL, package_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed', 'opted-out', 'user-managed')),
  installed_version TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, package_id)) STRICT;

CREATE TABLE plugin_profile_snapshot (       -- profile files before each reconcile
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL, lock_sha256 TEXT, reason TEXT NOT NULL) STRICT;

CREATE TABLE plugin_policy (
  name TEXT PRIMARY KEY CHECK (name IN ('market_only', 'install_scripts', 'egress_lock')),
  value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

CREATE TABLE dsh_plugin_limit (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group', 'user')), scope_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('max_installed', 'max_submissions', 'max_submission_bytes')),
  value INTEGER CHECK (value IS NULL OR value > 0),
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, name),
  CHECK ((scope_type = 'global') = (scope_id = '*'))) STRICT;

CREATE TABLE plugin_endpoint (               -- open per-instance listeners
  instance_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, port INTEGER NOT NULL UNIQUE,
  capability_sha256 TEXT NOT NULL, opened_at INTEGER NOT NULL) STRICT;

CREATE TABLE plugin_audit_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL,
  user_id TEXT, actor TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
```

- `plugin_version` 就是审核请求：每个版本一行，因此新版本总要重新审核。每个包最多一行 `pending`，与 KB 流程中每个 KB 只有一个待审请求相同。
- `plugin_listing` 保存当前和上一个获批版本，一步回滚只需修改指针；`plugin_listing_history` 保存完整轨迹。
- `dsh_plugin_limit` 逐列复制 `dsh_kb_limit`，因此 `effectiveLimits` 和限额管理模块可以共用。
- `origin = 'public'` 预留给以后的公共市场。

<a id="store-and-mirror"></a>
## 存储与镜像

### 目录布局

```text
/var/lib/dsh-plugins/                 dsh-plugins:dsh-plugins 0750
  plugins.sqlite
  store/sha512/<aa>/<rest>.tgz        content-addressed tarballs, 0440, never rewritten
  staging/<request>/                  fetch and verify area, removed after review
  uploads/<request>.tgz               admin uploads before verification
  skills/<package>/<version>/         unpacked skill packages (phase 5)
  views/<account>/skills/             per-user skill views (phase 5), bound read-only
  snapshots/<account>/<id>/           package.json and pnpm-lock.yaml copies, 0400
```

### 镜像一个版本

1. **解析。** npm 来源：通过主机代理从来源 registry 读取 packument，取该精确版本的 `dist.tarball` 和 `dist.integrity`；没有完整性值的版本被拒绝。git 来源：按 `apps/plugin-market-generator/src/fetchers.ts` 中生成器的规则（深度 1、关闭 hook 和文件系统监视器、不拉子模块、只用 https 和 ssh）把固定提交获取到私有裸仓库，再用包目录中的 blob 构建 tarball。上传：读取上传的 `.tgz`。
2. **检查包。** tarball 中的 `package.json` 必须与包名和版本一致；bundle 必须声明带 patch 的 `dsh.bundle`，技能包只能包含 `SKILL.md` 目录和资源文件。`engines.dsh` 遵循生成器的规则。
3. **解析依赖闭包。** 以 `dsh-plugins` 身份在临时目录中为这一个依赖运行 `pnpm install --lockfile-only --ignore-scripts`，对接来源 registry，DSH 运行时包（`@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*`）作为已提供的 peer 排除。每个解析出的 tarball 都下载并按完整性校验，记入 `plugin_closure`；`has_install_script` 取自 packument 的 `hasInstallScript` 或 tarball 中的 `preinstall`、`install` 和 `postinstall` 脚本。
4. **存储。** tarball 按摘要放入 `store/sha512/`；已存在的摘要直接共享。`size_bytes` 只计算该版本新增的字节。
5. **提交审核。** 审核人看到 manifest、文件列表、带安装脚本标记的依赖闭包、大小，以及与当前上架版本相比的文件名差异。

### 镜像提供什么

- 每个包名一个 packument，只包含某个获批闭包中出现的版本，每个版本的 `dist.tarball` 指回同一监听端口，`dist.integrity` 取自存储。
- 按摘要提供 tarball 字节。
- 别无其他：没有搜索端点，提供服务时不代理到上游，除上架版本外没有 `latest`。

<a id="serving-instances"></a>
## 通过主机代理为实例提供服务

- provisioner 启动实例时，在打开配额监听之后，通过控制 socket 调用 `dsh-plugins` 的 `open(userId, instanceId)`。`dsh-plugins` 在 `ports.market` 中绑定 `127.0.0.1:<port>`，生成 32 字节能力串，把它的 SHA-256 存入 `plugin_endpoint`，返回端口和能力串。实例停止时调用 `close(instanceId)`；`dsh-plugins` 重启会关闭所有监听，由 provisioner 重新打开。
- 原生运行时在 `network.ts` 中紧挨配额规则为每个账户增加一条规则：`ct mark <uid> iif "lo" tcp dport <marketPort> accept`。其他账户都无法连接该端口。
- 容器运行时在 `dsh-public.nft` 中像放行 `QUOTA_PORTS` 那样放行 `MARKET_PORTS`；在那里由能力串把关。
- 启动补丁在 `web-rows.ts` 中增加 `pluginMarketRows(url)`：把 `plugin-market` 的 `indexes` 设为 `[url]`，并在 `market_only` 开启时把插件管理器的 `registry` 设为镜像 URL、`fallbackRegistries: []`。
- 路由全部为 `GET`，都在 `/m/<capability>/` 下：
  - `index.json`：个性化索引，上架代次、用户所在组或用户的默认安装变化时重建，按摘要缓存。
  - `npm/<name>` 和 `npm/<scope>%2f<name>`：packument。
  - `npm/-/<sha512-hex>.tgz`：tarball。
  - `defaults.json`：用户的默认包及版本，供对账读取。
- 错误的能力串、未知路由或不在用户视图内的版本都返回 404，响应体不透露是哪一种。响应从不重定向，因为 `pluginMarket` 拒绝重定向。
- 只有当 tarball 属于该用户可见版本的依赖闭包时才提供给该用户，因此共享依赖不会暴露用户范围之外的上架项。

<a id="listing-flows"></a>
## 上架流程与状态机

### 路径 A：用户提交、管理员审批

```text
submit -> pending --approve(scope)--> approved --(newer approved)--> approved, previous
              |  \--reject--> rejected
              |  \--withdraw--> withdrawn
              \--30 days--> expired
approved --revoke--> revoked (delisted when it was current)
```

1. 用户在 **个人中心 > 我的插件** 中提交 npm 包名和精确版本、带 40 位提交的 git URL 或上传 tarball，并附说明。`dsh-plugins` 检查 `max_submissions` 和 `max_submission_bytes`，首次提交时创建包并记录 `owner_user_id`，然后创建 `pending` 版本。同一包的第二个待审版本以 409 `pending-exists` 拒绝。
2. 镜像作为任务运行；请求显示 `verifying`，然后是 `ready`，或带原因的 `failed`。失败的请求可以撤回后重新提交。
3. 管理员打开 **系统管理 > 插件市场 > 审批队列**，检查请求，重新认证后选择范围（全公司或部门）批准，或填写原因驳回。批准首个版本会创建上架项；批准后续版本会把当前版本移到 `previous_version_id`。
4. 提交者可以撤回待审版本。下架已上架的插件需要管理员。

### 路径 B：管理员直接上架

- 在 **系统管理 > 插件市场 > 上传** 中，管理员提供 npm 包名和版本、git URL 和提交，或 tarball，以及范围。运行相同的镜像和检查；成功后版本为 `approved`，`requested_by = reviewed_by = <admin>`，并立即上架。没有审核步骤，但需要重新认证，事件为 `admin-plugin-upload`。

### 回滚、下架和范围变更

- **回滚** 把 `current_version_id` 设为 `previous_version_id` 并记录 `rollback`；被回滚的版本仍为 `approved`，可以重新上架。再次回滚沿 `plugin_listing_history` 向前追溯。
- **下架** 设置 `delisted_at`；索引不再列出该包，镜像继续向已安装的用户提供 tarball，使他们的 profile 仍可安装，默认对账不再安装它。**重新上架** 清除该字段。
- **撤销** 把某个版本标为不可用，例如收到安全报告后：镜像停止提供该版本自身的 tarball，索引删除它，固定在该版本的默认安装回退到上一个获批版本。
- **范围变更** 重写该包的 `plugin_scope` 并记录 `scope`；失去可见性的用户保留已安装的插件。

<a id="installation-and-policy"></a>
## 安装与策略

### 用户安装

- Discover 从条目的 registry（即镜像）安装 `<name>@<version>`。由于该 registry 在配置集合之外，插件管理器只单独询问它，因此公司包永远不会回退到公共 registry。
- `plugin_market` 工具返回相同的 target 和 registry；`plugin_manager` `install_bundle` 保留其审批要求。
- `dsh plugin add` 和手动 spec 继续可用。`market_only` 关闭时它们的行为与现在相同。

### 默认安装

- 管理员把已上架的包标记为全公司或若干部门的默认安装。用户的 `defaults.json` 列出该用户可见的所有默认安装。
- 实例启动前，provisioner 调用 root helper 动词 `reconcile <userId>`。helper 把 `package.json` 和 `pnpm-lock.yaml` 复制到 `snapshots/`，然后以租户 uid、在租户的网络规则内，为每个缺失的默认插件运行 `dsh plugin add <name>@<version> --registry <mirror>`，对获批版本有变化的默认插件运行先卸载再安装。
- `plugin_default_state` 决定对账会动哪些包：
  - `installed`：由对账安装；对账让它保持在上架版本。
  - `opted-out`：对账曾安装过而用户卸载了；除非管理员为该包重置默认安装，否则不再安装。
  - `user-managed`：用户手动安装了其他版本；对账不去动它。
- 实例运行期间不做对账；运行中的实例在下次启动时获得变更，插件页面显示有默认更新待生效的提示。
- 强制安装不在范围内；以后的 `forced` 标志会让对账忽略 `opted-out`。

### "仅允许从市场安装"

- 策略 `market_only` 是 **系统管理 > 插件市场 > 策略** 中的开关，可作用于全公司或部门。
- 开启后，启动补丁把插件管理器的 `registry` 设为镜像，`fallbackRegistries` 设为 `[]`。此后任何 registry spec 只会对获批版本解析；其他一律返回 404，现有安装对话框显示未找到。插件页面、`dsh plugin add` 和 `plugin_manager` 保持原样。
- git 和 tarball URL 仍可经公网 `443` 出去，而且用户在自己的实例内拥有完全控制。因此单靠这个开关只是策略，不是边界。可选策略 `egress_lock` 为处于 `market_only` 下的账户关闭公网 `80` 和 `443`；它会破坏其他所有出站用途，因此列为开放问题，推荐默认关闭。

### 安装脚本

- 安装脚本默认禁用：若某版本的依赖闭包中有包带安装脚本，只有管理员在重新认证后逐个明确允许这些包（`admin-plugin-build-allow`），该版本才能被批准；否则批准以 409 `install-scripts` 拒绝。
- 插件管理器现有的构建审批仍会在实例内询问用户。允许列表发布在 `x-dsh-company` 中，公司面板可以据此显示"管理员已允许"；Discover 忽略它。

<a id="updates-and-rollback"></a>
## 更新与回滚

- **手动更新。** 用户自己安装的插件由用户更新：上架版本较新时 Discover 显示 `update-available`，用户先卸载再安装新版本，这与上游目前把升级留给这一对操作的做法一致。
- **默认插件更新。** 默认插件的新获批版本，在下次实例启动时由对账为所有状态为 `installed` 的用户安装。
- **重新审批。** 每个版本都是新的 `plugin_version` 行，必须经过审核或直接上传；没有任何版本因继承而获批。
- **市场回滚。** 管理员回滚把上架项退回一个版本。随后对账为默认状态为 `installed` 的用户降级；手动安装的用户看到上架版本变化后自行决定。
- **Profile 回滚。** 每次对账都保存用户 `package.json` 和 `pnpm-lock.yaml` 的快照。用户本人或管理员可以通过 root helper 动词 `restore <userId> <snapshotId>` 恢复最近的快照：它以租户身份写回这两个文件，并在下次启动时运行 `pnpm install --offline`。保留最近五个快照。

<a id="api-list"></a>
## API 列表

管理路由位于 `/api/admin` 下，个人路由位于 `/account/api/me` 下，都由 identity 提供，并带 actor 头转发给 `dsh-plugins`，与 `kb-gateway.ts` 为 KB 服务所做的完全相同。

| 方法与路径 | 调用者 | 重新认证 | 用途 |
|---|---|---|---|
| `GET /plugins` | 管理员 | 否 | 包、上架状态、范围、默认安装 |
| `GET /plugins/requests` | 管理员 | 否 | 带镜像状态的审批队列 |
| `GET /plugins/requests/detail` | 管理员 | 否 | manifest、文件、依赖闭包、安装脚本标记、差异 |
| `POST /plugins/requests/approve` | 管理员 | 是 | 带范围和允许构建列表批准 |
| `POST /plugins/requests/reject` | 管理员 | 否 | 带原因驳回 |
| `POST /plugins/upload` | 管理员 | 是 | 从 npm、git 或 tarball 直接上架 |
| `POST /plugins/scope` | 管理员 | 是 | 替换上架项的范围 |
| `POST /plugins/rollback` | 管理员 | 是 | 上架项退回一个版本 |
| `POST /plugins/delist` | 管理员 | 是 | 下架或重新上架 |
| `POST /plugins/revoke` | 管理员 | 是 | 撤销一个版本 |
| `POST /plugins/defaults` | 管理员 | 是 | 为全公司或部门设置或清除默认安装 |
| `GET /plugins/policy` | 管理员 | 否 | 读取策略 |
| `PUT /plugins/policy` | 管理员 | 是 | 修改 `market_only`、`install_scripts`、`egress_lock` |
| `GET /plugins/limits` | 管理员 | 否 | 限额行 |
| `GET /plugins/limits/effective` | 管理员 | 否 | 某用户的生效限额 |
| `PUT /plugins/limits` | 管理员 | 是 | 设置限额行 |
| `DELETE /plugins/limits` | 管理员 | 是 | 删除限额行 |
| `POST /plugins/restore` | 管理员 | 是 | 恢复某用户的 profile 快照 |
| `GET /plugins`（个人） | 用户 | 否 | 我的提交及其状态 |
| `POST /plugins/submit`（个人） | 用户 | 否 | 提交一个版本 |
| `POST /plugins/withdraw`（个人） | 用户 | 否 | 撤回待审版本 |
| `GET /plugins/snapshots`（个人） | 用户 | 否 | 我的 profile 快照 |
| `POST /plugins/restore`（个人） | 用户 | 否 | 恢复我最近的快照 |

provisioner 使用的控制 socket 动词：`open`、`close`、`reconcile-plan`。root helper 动词：`reconcile`、`snapshot`、`restore`，都只接受用户 id，`restore` 另加快照 id。错误沿用 KB 约定：400 输入无效，403 不允许，404 不存在，409 状态冲突（`pending-exists`、`not-pending`、`install-scripts`、`limit-reached`、`version-exists`），413 过大。

<a id="permissions-and-audit"></a>
## 权限与审计

- 只有 `admin` 角色能访问管理路由；identity 执行白名单 `PLUGIN_ADMIN_ENDPOINTS` 和重新认证集合 `PLUGIN_REAUTH`，二者仿照 `KB_ADMIN_ENDPOINTS` 和 `KB_REAUTH`。
- 个人路由只作用于调用者自己的提交和快照。
- `dsh-plugins` 把事件写入 `plugin_audit_outbox`；identity 像取走 `kb_audit_outbox` 那样把它们取入审计日志。`detail` 从不包含 tarball 内容或能力串。

| 事件 | 执行者 | 详情 |
|---|---|---|
| `plugin-submit` | 用户 | 包、版本、来源类型 |
| `plugin-withdraw` | 用户 | 包、版本 |
| `plugin-restore` | 用户 | 快照 id |
| `plugin-reconcile` | 系统 | 用户、新增、卸载、opted-out |
| `admin-plugin-approve` | 管理员 | 包、版本、范围、允许构建列表 |
| `admin-plugin-reject` | 管理员 | 包、版本、原因 |
| `admin-plugin-upload` | 管理员 | 包、版本、来源类型、范围 |
| `admin-plugin-scope-change` | 管理员 | 包、原范围、新范围 |
| `admin-plugin-rollback` | 管理员 | 包、原版本、目标版本 |
| `admin-plugin-delist` | 管理员 | 包、下架或重新上架 |
| `admin-plugin-revoke` | 管理员 | 包、版本、原因 |
| `admin-plugin-default-set` | 管理员 | 包、范围 |
| `admin-plugin-default-clear` | 管理员 | 包、范围 |
| `admin-plugin-build-allow` | 管理员 | 包、版本、允许的包 |
| `admin-plugin-policy-change` | 管理员 | 策略、范围、原值、新值 |
| `admin-plugin-limit-change` | 管理员 | 范围、名称、原值、新值 |
| `admin-plugin-limit-delete` | 管理员 | 范围、名称 |
| `admin-plugin-restore` | 管理员 | 用户、快照 id |
| `admin-plugin-content-read` | 管理员 | 包、版本、文件 |

<a id="plugin-limits"></a>
## 插件限额

- `dsh_plugin_limit` 包含三项限额：`max_installed`（用户 profile 中的市场包数）、`max_submissions`（用户待审和已上架的包数）和 `max_submission_bytes`（用户提交新增的存储字节）。
- 解析复用 `effectiveLimits`：用户行优先；否则取用户所在部门中最宽松的值；否则取全局行；`NULL` 表示不限。
- 调低限额从不删除、下架或卸载任何东西。只拒绝增长：超限的提交得到 409 `limit-reached`；达到 `max_installed` 后，镜像的 tarball 路由对新的顶层市场包同样返回 409，计数取上次对账读取的 profile manifest 加上此后获取的包。
- 默认安装计入 `max_installed`；对账即使超限也会安装它们，因为这是管理员的选择，并记录下来。
- 实例磁盘用量仍受现有 XFS 配额约束；市场不在实例内增加第二个磁盘限额。
- 限额页面复用 `admin-kb-limits.tsx`，换用插件限额名称。

<a id="system-admin-ui"></a>
## 系统管理界面

- **侧边栏。** "系统管理"在单一侧边栏的子菜单中增加 **插件市场** 一项，与知识库各项并列。不新增侧边栏。
- **页面。** 审批队列、已上架插件（范围、当前和上一版本、回滚、下架）、上传、默认安装、策略（`market_only`、安装脚本、`egress_lock`）、限额，以及按 `admin-plugin-*` 过滤的审计。
- **个人中心。** 个人中心增加 **我的插件**：提交、请求状态、撤回和 profile 快照。
- **插件页面。** 上游插件页面和 Discover 标签页原样使用；公司索引作为启动补丁配置好的索引源出现。一个小的公司面板读取 `x-dsh-company`，显示"默认安装"和"允许构建"。
- **风格。** 保留 `admin-kit.tsx` 和上游客户端中现有的按钮、图标和组件形态。只用现有调色板和 `theme.ts` 中的磨砂玻璃层重新着色，风格克制、企业化：不加新颜色、不换图标集、不加新组件形态。

<a id="deployment-changes"></a>
## 部署改动

- **包。** `integrations/public-harness/packages/plugins/` 存放服务、镜像、视图和 root helper；`packages/production/src/plugins-service.ts` 和 `plugins-root-helper.ts` 作为入口，对应 `kb-service.ts` 和 `kb-root-helper.ts`。
- **systemd。** `dsh-plugins.service`（用户 `dsh-plugins`，状态在 `/var/lib/dsh-plugins`，控制 socket 为 `/run/dsh-plugins/control.sock`，除回环和主机代理外 `IPAddressDeny=any`）、`dsh-plugins-root.socket` 和 `dsh-plugins-root@.service`，仿照 `dsh-kb.service`、`dsh-kb-root.socket` 和 `dsh-kb-root@.service`。
- **账户与目录。** `sysusers.conf` 增加 `dsh-plugins`；`tmpfiles.conf` 增加 `/var/lib/dsh-plugins` 和 `/run/dsh-plugins`。
- **配置。** `deploy/production/config/plugins.example.json` 包含数据库路径、存储路径、`ports.market`、上游 registry、允许作为来源的 git 主机、大小上限和请求有效期。`provisioner.example.json` 增加 `ports.market`，它不得与 `ports.web`、`ports.quota` 或 sidecar 端口段重叠；`provisioner/src/config.ts` 和 `runtime-systemd/src/config.ts` 中的配置校验负责检查。
- **防火墙。** `dsh-public.nft` 在 `QUOTA_PORTS` 旁增加 `define MARKET_PORTS` 和一条回环规则；`network.ts` 增加每账户规则；`probe.ts` 中的探测检查它。实例的私有地址段丢弃和公网出站保持不变。
- **Provisioner。** `runtime.ts` 与配额监听一同打开和关闭市场监听，加入 `pluginMarketRows`，并在启动前调用 `reconcile`。市场故障从不阻止启动：实例在没有索引行的情况下启动，并记录故障。
- **Identity。** 在 `kb-gateway.ts` 旁增加 `plugins-gateway.ts`，转发路由、执行重新认证并取走 outbox。
- **升级路径。** `plugins.json` 存在前保持关闭；之后为公司 profile 启用实验性市场组合包（见未验证项）。

<a id="public-market-later"></a>
## 以后增加公共市场

- 管理员订阅外部索引 URL；`dsh-plugins` 在主机上通过代理获取，从不在实例中获取。
- 公共索引中的条目只是候选，不是上架项：管理员导入某个版本，走同样的镜像和审核，`origin = 'public'`。
- 个性化索引仍是一个文档。以后的选项是每个实例增加第二个索引 URL，单独列出获批的公共包，使 Discover 显示两个来源。
- 签名（第 6 阶段）适用于两者：上游包用 npm provenance 或 Sigstore，每份个性化索引用公司签名。

<a id="risks-and-unverified-items"></a>
## 风险与未验证项

### 风险

- **索引未签名。** 第 6 阶段之前，索引的可信来自通道：回环、每账户防火墙规则和能力串。主机被攻破则全部失效。
- **没有 `egress_lock` 时 `market_only` 是软约束**，因为实例内的 git 和 tarball URL 以及手动 pnpm 运行仍能访问互联网。
- **依赖闭包漂移。** 依赖闭包在审核时冻结；依赖以后的安全修复需要新版本和新审核。
- **共享 tarball。** 被不同范围的上架项共享的依赖，会提供给能看到其中任一项的用户；镜像只暴露该共享依赖的存在。
- **能力串暴露。** 能力串位于设置页显示的索引 URL 中。原生账户本来就无法使用其他账户的端口；容器运行时每次启动都会轮换它。
- **审核人自批。** 管理员可以批准自己的提交；这会被审计，四眼原则列为开放问题。

### 未验证项

- **启用实验性组合包。** `web-rows.ts` 的补丁行只能配置或禁用已有条目；启动补丁能否开启 `plugin-market-bundle`，还是需要 `insert` 行，尚未验证。
- **已提供的 peer。** pnpm 11 的 peer 自动安装在市场安装时是否会向镜像请求 `@deepseek-ai/dsh*`，以及镜像是否因此必须提供运行时自身的 packument，尚未验证。
- **以租户身份对账。** 在启动前于主机上以租户身份运行 `dsh plugin add` 适合原生运行时；容器运行时需要等效的一次性容器，尚未设计。
- **git tarball。** 由 git blob 构建的 tarball 必须与 `npm pack` 的产物安装方式相同；按 `package.json` 的 `files` 和 `.npmignore` 选择文件需要决定并测试。
- **`source.integrity`。** 该成员名可能与上游将来的定义冲突；应在第 2 阶段发布前与上游达成一致。
- **并发 profile 锁。** 对账与用户自己的安装不能重叠；对账只在实例停止时运行并获取插件管理器的 profile 锁，这需要测试。

<a id="test-plan"></a>
## 测试计划

任何测试都不使用真实模型密钥或模型调用。所有监听只绑定 `127.0.0.1` 或 Unix socket。

- **单元测试。**
  - 版本状态机：每个转换和每种拒绝（`pending-exists`、`not-pending`、`install-scripts`、`version-exists`）。
  - 可见性：全公司、部门、多个部门、已禁用用户、已下架或已撤销的版本。
  - 限额：用户行优先、最宽松的部门、全局回退、调低保留数据、增长得到 409。
  - 索引构建：通过 `parseMarketIndex` 的格式 1 有效性、`source.integrity`、内联图标、没有 URL 图标、稳定摘要。
  - 镜像：packument 只列出用户视图内闭包中的版本；按摘要取 tarball；未知摘要返回 404。
- **集成测试。**
  - Identity 网关：白名单、所列路由的重新认证、outbox 按正确事件被取走。
  - 用本地测试 registry 和本地 git 服务器跑镜像流水线：带完整性的 npm 版本、git 提交、上传、含安装脚本的闭包被拒绝、大小统计。
  - 上游 `pluginMarket` 从监听端口读取个性化索引，包括不重定向和 `maxBytes`。
- **端到端**（原生栈，扩展 kb-stack e2e 测试框架）：
  - 部门用户能看到部门上架项；部门外的用户看不到，其 tarball 返回 404。
  - 在测试网络关闭公网出站的情况下，Discover 安装市场插件。
  - 默认对账安装，用户卸载，下次启动不再安装。
  - 新获批的默认插件在下次启动时送达用户；回滚后恢复上一个版本。
  - `market_only` 使市场外的 registry spec 以未找到失败。
  - 其他账户无法连接该监听端口。
- **防火墙渲染。** `network.ts` 和 `dsh-public.nft` 的规则测试，探测能发现缺失的市场规则。
- **回归。** 上游 plugin-market 和 plugin-manager 测试原样运行。

<a id="phased-implementation-plan"></a>
## 分阶段实施计划

### 第 0 阶段：验证性探索

1. 在测试实例上通过启动补丁启用 `plugin-market-bundle`，记录机制。
2. 用 pnpm 11 从一个最小静态 registry 安装组合包，确认它请求哪些 packument，包括已提供的 peer。
3. 实例停止时，在主机上以租户账户对回环 registry 运行 `dsh plugin add` 和 `dsh plugin remove`。
4. 用 git blob 构建 tarball，与 `npm pack` 的产物比较安装结果。

### 第 1 阶段：存储、镜像和服务

1. 创建 `packages/plugins`，包含数据库 schema 和迁移。
2. 实现 npm 和上传的镜像流水线、内容寻址存储和依赖闭包解析。
3. 实现每实例监听、能力串、索引构建，以及 packument 和 tarball 路由。
4. 在 provisioner 和运行时配置中加入 `ports.market`，加入 nft 规则和探测。
5. 加入 `pluginMarketRows`，以及 provisioner 中的打开和关闭调用。
6. 加入 systemd 单元、sysusers、tmpfiles 和 `plugins.example.json`。
7. 管理员直接上传，仅全公司范围，需要重新认证，带审计。

### 第 2 阶段：审核流程和范围

1. 个人提交路由、待审规则、撤回和 30 天过期。
2. 按生成器获取规则支持 git 来源。
3. 审批队列、详情、带范围批准、驳回和安装脚本拒绝。
4. 部门范围、范围变更、下架、重新上架、撤销和带历史的回滚。
5. identity 中的 `plugins-gateway.ts`，含白名单、重新认证集合和 outbox 取走。
6. 用现有组件实现系统管理页面和个人中心 **我的插件**。

### 第 3 阶段：默认安装和更新

1. 按全公司和部门的默认安装，以及 `defaults.json`。
2. root helper 动词 `reconcile`、`snapshot` 和 `restore`。
3. 启动前对账、`plugin_default_state`、卸载识别和待更新提示。
4. 用户和管理员的 profile 快照恢复。

### 第 4 阶段：策略和限额

1. `dsh_plugin_limit`，共用限额模块和页面。
2. tarball 路由和对账中的 `max_installed`。
3. 通过启动补丁按全公司或部门实现 `market_only`。
4. 若开放问题决定采用，则实现 `egress_lock`。

### 第 5 阶段：纯技能包

1. 镜像中的技能包检查。
2. 像 KB 视图一样构建每用户技能视图，只读绑定，并加入 `customSkillDirs` 行。
3. 技能包的上架、默认安装和限额。

### 第 6 阶段：以后

1. 上游包的签名校验和签名的个性化索引。
2. 公共市场订阅。
3. 强制安装。

<a id="open-questions"></a>
## 开放问题与推荐默认值

1. **`market_only` 是否也关闭公网出站（`egress_lock`）？** 推荐默认：关闭。单靠 `market_only` 固定 registry；`egress_lock` 作为按部门的显式选择，因为它会破坏其他出站用途。此项涉及安全，需要用户决定。
2. **安装脚本。** 推荐默认：依赖闭包含安装脚本的版本一律拒绝，除非管理员重新认证后逐个允许这些包。
3. **默认插件更新何时送达？** 推荐默认：下次实例启动时，并显示提示；不强制重启。
4. **卸载默认插件是否永久生效？** 推荐默认：是，按包生效，直到管理员为该包重置默认安装；新版本不会重新安装它。
5. **默认限额值。** 推荐默认：全局 `max_installed` 50、`max_submissions` 20、`max_submission_bytes` 200 MiB。
6. **需要构建步骤的 git 来源。** 推荐默认：不支持；仓库必须提交构建产物或发布到 npm。
7. **管理员能否批准自己的提交？** 推荐默认：可以，带审计；以后提供四眼选项。
8. **提交者能否下架自己的插件？** 推荐默认：不能；提交者只能撤回待审版本。
9. **镜像保留。** 推荐默认：保留上架历史引用的每个 tarball；已撤销版本在 90 天后由管理员显式操作清除。
10. **上传大小上限。** 推荐默认：每个 tarball 50 MiB，每个依赖闭包 500 MiB。
11. **纯技能包。** 推荐默认：支持，在第 5 阶段，以只读主机视图交付而不是通过 pnpm。
12. **单用户范围。** 推荐默认：不提供；按已决定的那样，范围只有部门和全公司。

<a id="sources"></a>
## 来源

- [插件市场索引格式](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md)
- [插件市场 Discover](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md)
- [插件安装 registry](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md)
- [LLM Wiki 知识库设计](2026-10-17-llm-wiki-knowledge-base-design.zh.md)
- [公开 Harness 原生设计](2026-10-11-public-harness-native-design.zh.md)
