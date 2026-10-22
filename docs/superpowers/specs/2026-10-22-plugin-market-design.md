# Company plugin market design

English | [中文](2026-10-22-plugin-market-design.zh.md)

## Summary

This is a design specification for review; it contains no implementation code. It adds a company plugin market to the [native public Harness deployment](2026-10-11-public-harness-native-design.md). It extends the plugin market that already exists upstream and does not replace it: the [index format 1](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md), the Host `pluginMarket` service and the Web **Discover** tab described in the [Discover note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md), and the registry plan of the [plugin install registries note](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md).

A new host service, `dsh-plugins`, keeps the catalogue of reviewed plugins, mirrors every approved version and its dependency closure into a content-addressed company store, and opens one loopback listener per running instance. That listener serves the instance a personalized `index.json`, built from the visibility scopes the way the [knowledge base design](2026-10-17-llm-wiki-knowledge-base-design.md) builds KB views, together with a read-only npm registry that holds only approved tarballs. The instance firewall stays closed to the intranet: an instance reaches nothing new except its own listener port. Plugins reach the catalogue in two ways: a user submits and an administrator approves and picks the visibility scope, reusing the KB share approval flow, or an administrator uploads and lists directly in System Admin. Every step writes an `admin-plugin-*` or `plugin-*` audit event and can be rolled back. Users install and update plugins themselves through every existing path. Administrators set default installs per department or for the whole company; defaults are reconciled on the host before an instance starts, and a newly approved version reaches them on the next start.

## Contents

- [Goals and non-goals](#goals-and-non-goals)
- [Current system facts](#current-system-facts)
- [Architecture overview](#architecture-overview)
- [Package kinds and index extensions](#package-kinds-and-index-extensions)
- [Data model](#data-model)
- [Store and mirror](#store-and-mirror)
- [Serving instances through the host proxy](#serving-instances)
- [Listing flows and state machine](#listing-flows)
- [Installation and policy](#installation-and-policy)
- [Updates and rollback](#updates-and-rollback)
- [API list](#api-list)
- [Permissions and audit](#permissions-and-audit)
- [Plugin limits](#plugin-limits)
- [System Admin UI](#system-admin-ui)
- [Deployment changes](#deployment-changes)
- [Adding a public market later](#public-market-later)
- [Risks and unverified items](#risks-and-unverified-items)
- [Test plan](#test-plan)
- [Phased implementation plan](#phased-implementation-plan)
- [Open questions and recommended defaults](#open-questions)
- [Sources](#sources)

<a id="goals-and-non-goals"></a>
## Goals and non-goals

### Goals

- A company market inside the deployment, shown in the existing Discover tab, with a per-user index computed on the host from department and company scopes.
- Only pinned, reviewed versions: an npm version is pinned by exact version and integrity hash, a git source by an exact commit, and every new version is reviewed again.
- Instances never reach the intranet or an upstream registry for market installs; they fetch only from a company mirror on their own loopback listener.
- Two listing paths, both audited and both reversible: user submission with administrator approval, and direct administrator upload.
- Default installs per department or company that a user can remove, and automatic delivery of newly approved versions of those defaults.
- Every existing install path keeps working: `dsh plugin add`, the Plugins page, the `plugin_manager` tool, and manual URLs.
- Limits on plugins per user and on submission storage, reusing the three-tier limit rules of `dsh_kb_limit`.
- Room to add a public market later without changing the data model.

### Non-goals

- No signature verification in the first phases; it is phase 6.
- No forced installs that a user cannot remove; they come later.
- No automatic update of plugins a user installed by hand; users update them manually.
- No change to the upstream index format version, the `pluginMarket` service, or the Discover UI beyond what an index member that old readers ignore allows.
- No build step on the host: a git source must contain its built output.
- No redesign of the Plugins page or System Admin; existing buttons, icons, and component shapes stay.

<a id="current-system-facts"></a>
## Current system facts

These facts were read from the repository and shape the design.

- **Index format 1** (`packages/util/plugin-market-index/src/types.ts`, `index.ts`): a plugin has `name`, display fields, `dist-tags`, and `versions[]`; a version has `version`, `publishTimestamp`, `source`, and `engines.dsh`. An npm source is `{ type: 'npm', registry? }` with no integrity member; a git source is `{ type: 'git', url, commit, path? }` with a 40-hex commit. Readers ignore unknown members at every level but reject an unknown `source.type`. `marketInstallTarget` is the only builder of install arguments: `<name>@<version>` for npm, `git+<url>.git#<commit>` for git; clients never install `name@latest`.
- **Host reader** (`packages/boot/plugin-market/src/index.ts`): `indexes` is a volatile config field written by Settings without a remount; `fetchTimeoutMs` defaults to 15 s, `maxBytes` to 128 MiB, `cacheTtlMs` to 10 minutes. It fetches with `redirect: 'error'` and only an `accept` header, so it cannot send credentials. `normalizeIndexUrl` (`index-url.ts`) refuses URLs with credentials or a fragment. `search.ts` returns at most 100 entries per page.
- **Opt-in bundle** (`packages/experimental/plugin-market-bundle/cordis.patch.yml`): inserts the `plugin-market` row, disabled without a profile, and the `ui-plugin-market` browser row. Shipped profiles leave it off.
- **Discover tab** (`packages/client/ui-plugin-market/src/client/DiscoverSection.tsx`, `market-store.ts`): installs through the owner's `install(spec, registry?)`, and an entry's registry is used for that single install. The `plugin_market` tool (`packages/boot/plugin-market/src/tools.ts`) returns a target and registry for `plugin_manager` `install_bundle`, which still needs approval.
- **Plugin manager** (`packages/boot/plugin-manager/src/index.ts`, `registry.ts`, `build-approval.ts`): `installBundle(spec, options)` runs pnpm, restores `package.json` and `pnpm-lock.yaml` on failure, and with HMR refuses an already-installed package, so an upgrade is remove then install. A requested registry outside the configured set is asked alone and never falls through to a public one. Build scripts run only when approved into `allowBuilds`.
- **Generator** (`apps/plugin-market-generator/src/sources.ts`, `fetchers.ts`, `generate.ts`): reads npm names and git URLs, checks npm tarballs against the registry integrity, reads git objects in a private bare repository with hooks disabled, and never runs package code. Its fetch rules are the model for the mirror.
- **KB share flow** (`integrations/public-harness/packages/kb/src/share.ts`): one pending request per KB, a 30-day request TTL (`REQUEST_TTL_MS`), approve with a parsed scope (`parseScope`), reject, revoke, and rollback; snapshots are immutable.
- **KB views** (`integrations/public-harness/packages/kb/src/views.ts`): `visibleEntries` picks publications whose scope is `company`, one of the user's groups, or the user, skipping disabled principals; `reconcileViews` reapplies them.
- **Three-tier limits** (`integrations/public-harness/packages/kb/src/store.ts`, `limits.ts`, `limits-admin.ts`): `dsh_kb_limit` rows of scope `global`, `group`, or `user`; `effectiveLimits` lets a user row win, then the most permissive of the user's groups, then global. Lowering a limit never deletes data; growth past it is refused with 409.
- **Audit and reauth** (`integrations/public-harness/packages/identity/src/kb-gateway.ts`, `admin.ts`): `KB_ADMIN_ENDPOINTS` whitelists admin routes, `KB_REAUTH` lists those that need a fresh SSO session or password, and `KB_EVENTS` lists the accepted events. The KB service writes events to `kb_audit_outbox` and identity drains them.
- **Root helper** (`integrations/public-harness/packages/kb/src/root-helper.ts`, `deploy/native/systemd/dsh-kb-root.socket`, `dsh-kb-root@.service`): a socket-activated root helper with a fixed verb set (`ROOT_VERBS`), which re-derives the account and paths from a user id.
- **Instance network** (`integrations/public-harness/packages/runtime-systemd/src/network.ts`, `deploy/production/nftables/dsh-public.nft`): an instance account may open new loopback connections only to its own quota port; private address ranges are dropped; public `80` and `443` stay open. The container runtime admits the `QUOTA_PORTS` range through pasta's host-loopback mapping.
- **Launch patch** (`integrations/public-harness/packages/contracts/src/web-rows.ts`, `packages/provisioner/src/runtime.ts`): rows set config on bundled entries or disable them; `kbSkillRows` adds a read-only `customSkillDirs` entry to `skill-filesystem`.
- **Admin UI** (`integrations/public-harness/packages/ui/src/client/nav.tsx`, `admin.tsx`, `admin-kit.tsx`, `admin-kb-limits.tsx`, `theme.ts`): System Admin (`team.admin`) is registered for the `admin` role in the single sidebar; `theme.ts` already holds the enterprise frosted-glass layer.

<a id="architecture-overview"></a>
## Architecture overview

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

- `dsh-plugins` is a host service like `dsh-kb`: it listens on a private Unix socket for identity and the provisioner and trusts the actor headers identity sets.
- Only `dsh-plugins` talks to upstream registries and intranet git servers, through the host's process proxy. Instances keep their current firewall.
- For each running instance the provisioner asks `dsh-plugins` to open a listener in a new `ports.market` range, as it already does for the quota listener. The native runtime admits only that account to that port; the container runtime admits the range, and an unguessable path capability selects the user.
- The instance's `pluginMarket.indexes` is set by the launch patch to the listener's index URL. Discover, the `plugin_market` tool, and `plugin_manager` then work unchanged.
- A root helper reconciles default installs as the tenant before the instance starts, through the existing `dsh plugin` command, which runs pnpm in the profile (`dsh plugin add`, and `dsh plugin remove` for the remove step).

<a id="package-kinds-and-index-extensions"></a>
## Package kinds and index extensions

### Kinds

- **bundle**: an npm package whose `package.json` declares `dsh.bundle`, the only kind the upstream index lists today.
- **skill**: a pure-skill package, a directory of `SKILL.md` folders with no code to load. It is not a Cordis bundle and pnpm cannot activate it, so it is never written into `index.json`. The host links approved skill packages into a per-user read-only directory, the way KB views are built, and the launch patch adds that directory to `skill-filesystem` `customSkillDirs`, as `kbSkillRows` does. It arrives in phase 5.

### Index members added within format 1

Old readers ignore unknown members, so the personalized index adds these without changing `format`:

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

- `source.integrity` is the SRI sha512 of the mirrored tarball, the same value the mirror's packument reports and pnpm verifies. It is proposed upstream as an optional member later.
- `x-dsh-company` carries the original source, the approval time, and whether the plugin is a default for this user. Discover ignores it; the company Plugins panel reads it.
- Every version is served as an npm source pointing at the mirror, including those reviewed from git, because an instance cannot reach the intranet git server. The pinned commit stays in `x-dsh-company.origin`.
- Icons are inlined as `data:` URLs of at most 32 KiB; a URL icon is never passed through, so no instance fetches a third-party host.

<a id="data-model"></a>
## Data model

All tables live in the `dsh-plugins` SQLite database. Users and groups are read from identity's `dsh_user_group` through the same principal sync the KB service uses.

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

- `plugin_version` is the review request: one row per version, so a new version is always reviewed again. At most one `pending` row per package, as the KB flow allows one pending request per KB.
- `plugin_listing` keeps the current and the previous approved version, which makes one-step rollback a pointer change; `plugin_listing_history` keeps the full trail.
- `dsh_plugin_limit` copies `dsh_kb_limit` column for column, so `effectiveLimits` and the limits admin module can be shared.
- `origin = 'public'` is reserved for the later public market.

<a id="store-and-mirror"></a>
## Store and mirror

### Directory layout

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

### Mirroring a version

1. **Resolve.** For an npm source, read the packument from the source registry through the host proxy and take the exact version's `dist.tarball` and `dist.integrity`; a version without integrity is refused. For a git source, fetch the pinned commit into a private bare repository with the generator's rules from `apps/plugin-market-generator/src/fetchers.ts` (depth 1, hooks and file-system monitor off, no submodules, https and ssh only) and build a tarball from the package directory's blobs. For an upload, read the uploaded `.tgz`.
2. **Check the package.** The tarball's `package.json` must name the package and version; a bundle must declare `dsh.bundle` with a patch, a skill package must hold only `SKILL.md` folders and assets. `engines.dsh` follows the generator's rules.
3. **Resolve the closure.** Run `pnpm install --lockfile-only --ignore-scripts` for the single dependency in a scratch directory as `dsh-plugins`, against the source registry, with DSH runtime packages (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`) excluded as provided peers. Every resolved tarball is downloaded, verified against its integrity, and recorded in `plugin_closure` with `has_install_script` from the packument's `hasInstallScript` or the tarball's `preinstall`, `install`, and `postinstall` scripts.
4. **Store.** Tarballs move into `store/sha512/` by digest; a digest already present is shared. `size_bytes` counts only bytes this version added.
5. **Present for review.** The reviewer sees the manifest, the file list, the closure with install-script flags, the size, and a diff of file names against the current listed version.

### What the mirror serves

- A packument per package name holding only the versions some approved closure contains, each with `dist.tarball` pointing back at the same listener and `dist.integrity` from the store.
- The tarball bytes by digest.
- Nothing else: no search endpoint, no proxying to upstream at serve time, no `latest` beyond the listed version.

<a id="serving-instances"></a>
## Serving instances through the host proxy

- When the provisioner starts an instance it calls `dsh-plugins` `open(userId, instanceId)` over the control socket, after it has opened the quota listener. `dsh-plugins` binds `127.0.0.1:<port>` from `ports.market`, draws a 32-byte capability, stores its SHA-256 in `plugin_endpoint`, and returns the port and capability. `close(instanceId)` runs when the instance stops; a restart of `dsh-plugins` closes every listener and the provisioner reopens them.
- The native runtime adds one rule per account in `network.ts`, next to the quota rule: `ct mark <uid> iif "lo" tcp dport <marketPort> accept`. No other account can connect to that port.
- The container runtime admits `MARKET_PORTS` in `dsh-public.nft` the way it admits `QUOTA_PORTS`; there the capability is the guard.
- The launch patch gains `pluginMarketRows(url)` in `web-rows.ts`, which sets `plugin-market` `indexes` to `[url]` and the plugin manager's `registry` to the mirror URL with `fallbackRegistries: []` when `market_only` is on.
- Routes, all `GET`, all under `/m/<capability>/`:
  - `index.json`: the personalized index, rebuilt when the listing generation, the user's groups, or the user's defaults change, and cached by digest.
  - `npm/<name>` and `npm/<scope>%2f<name>`: packuments.
  - `npm/-/<sha512-hex>.tgz`: tarballs.
  - `defaults.json`: the user's default packages and versions, read by reconcile.
- A wrong capability, an unknown route, or a version outside the user's view answers 404 without a body that reveals which. Responses never redirect, because `pluginMarket` refuses redirects.
- A tarball is served to a user only when it belongs to the closure of a version that user can see, so a shared dependency does not reveal a listing outside the user's scope.

<a id="listing-flows"></a>
## Listing flows and state machine

### Path A: user submission and administrator approval

```text
submit -> pending --approve(scope)--> approved --(newer approved)--> approved, previous
              |  \--reject--> rejected
              |  \--withdraw--> withdrawn
              \--30 days--> expired
approved --revoke--> revoked (delisted when it was current)
```

1. The user submits from **Personal > My plugins** an npm name and exact version, a git URL with a 40-hex commit, or a tarball upload, plus a note. `dsh-plugins` checks `max_submissions` and `max_submission_bytes`, creates the package on first submission with `owner_user_id`, and creates a `pending` version. A second pending version of the same package is refused with 409 `pending-exists`.
2. Mirroring runs as a job; the request shows `verifying`, then `ready` or `failed` with the reason. A failed request can be withdrawn and submitted again.
3. An administrator opens **System Admin > Plugin market > Review queue**, inspects the request, and approves with a scope (whole company or departments) after reauth, or rejects with a reason. Approval of a first version creates the listing; approval of a later version moves the current version to `previous_version_id`.
4. Submitters can withdraw pending versions. Delisting a listed plugin needs an administrator.

### Path B: administrator direct listing

- In **System Admin > Plugin market > Upload**, an administrator gives an npm name and version, a git URL and commit, or a tarball, and a scope. The same mirror and checks run; on success the version is `approved` with `requested_by = reviewed_by = <admin>` and listed at once. No review step exists, but reauth is required and the event is `admin-plugin-upload`.

### Rollback, delist, and scope changes

- **Rollback** sets `current_version_id` to `previous_version_id` and records `rollback`; the rolled-back version stays `approved` and can be re-listed. Rolling back again walks `plugin_listing_history`.
- **Delist** sets `delisted_at`; the index stops listing the package, the mirror keeps serving tarballs to users who already installed them so their profiles stay installable, and default reconcile no longer installs it. **Relist** clears it.
- **Revoke** marks a version unusable, for example after a security report: the mirror stops serving that version's own tarball, the index drops it, and a default that pinned it falls back to the previous approved version.
- **Scope change** rewrites `plugin_scope` for the package and records `scope`; users who lose sight of a plugin keep what they installed.

<a id="installation-and-policy"></a>
## Installation and policy

### User installs

- Discover installs `<name>@<version>` from the entry's registry, the mirror. The plugin manager asks that registry alone because it is outside the configured set, so a company package never falls through to a public registry.
- The `plugin_market` tool returns the same target and registry; `plugin_manager` `install_bundle` keeps its approval requirement.
- `dsh plugin add` and manual specs keep working. With `market_only` off they behave as today.

### Default installs

- An administrator marks a listed package as a default for the company or for departments. `defaults.json` for a user lists every default visible to the user.
- Before an instance starts, the provisioner calls the root helper verb `reconcile <userId>`. The helper copies `package.json` and `pnpm-lock.yaml` into `snapshots/`, then runs as the tenant uid, inside the tenant's network rules, `dsh plugin add <name>@<version> --registry <mirror>` for each missing default and the remove-then-add pair for a default whose approved version changed.
- `plugin_default_state` decides what reconcile touches:
  - `installed`: reconcile installed it; it keeps it at the listed version.
  - `opted-out`: reconcile installed it before and the user removed it; it is never added again unless an administrator resets defaults for that package.
  - `user-managed`: the user installed another version by hand; reconcile leaves it alone.
- Reconcile does not run while an instance is running; a running instance picks up changes at its next start, and the Plugins page shows a notice that a default update is waiting.
- Forced installs are out of scope; a later `forced` flag would make reconcile ignore `opted-out`.

### "Only allow installing from the market"

- Policy `market_only` is a toggle in **System Admin > Plugin market > Policy**, for the company or per department.
- When on, the launch patch sets the plugin manager's `registry` to the mirror and `fallbackRegistries` to `[]`. Any registry spec then resolves only against approved versions; anything else answers 404 and the existing install dialog shows a not-found failure. The Plugins page, `dsh plugin add`, and `plugin_manager` stay as they are.
- Git and tarball URLs still leave through public `443`, and a user has full control inside their own instance. The toggle alone is therefore policy, not a boundary. The optional `egress_lock` policy closes public `80` and `443` for accounts under `market_only`; it breaks every other outbound use, so it is an open question with a recommended default of off.

### Install scripts

- Install scripts are disabled by default: a version whose closure contains a package with an install script is approvable only when the administrator explicitly allows each such package after reauth (`admin-plugin-build-allow`); otherwise approval is refused with 409 `install-scripts`.
- The plugin manager's existing build approval still asks the user inside the instance. The allowed list is published in `x-dsh-company` so the company panel can say "allowed by administrator"; Discover ignores it.

<a id="updates-and-rollback"></a>
## Updates and rollback

- **Manual updates.** A plugin a user installed is updated by the user: Discover shows `update-available` when the listed version is newer, and the user removes and installs the new version, as upstream leaves upgrade to that pair today.
- **Default updates.** A newly approved version of a default is installed by reconcile at the next instance start for every user whose state is `installed`.
- **Re-approval.** Every version is a new `plugin_version` row and goes through review or a direct upload; nothing is approved by inheritance.
- **Market rollback.** An administrator rollback moves the listing back one version. Reconcile then downgrades users whose default state is `installed`; users who installed by hand see the listed version change and decide.
- **Profile rollback.** Each reconcile keeps a snapshot of the user's `package.json` and `pnpm-lock.yaml`. The user, or an administrator for the user, can restore the last snapshot through the root helper verb `restore <userId> <snapshotId>`, which writes both files back as the tenant and runs `pnpm install --offline` at the next start. The last five snapshots are kept.

<a id="api-list"></a>
## API list

Admin routes sit under `/api/admin` and personal routes under `/account/api/me`, both served by identity, which forwards them to `dsh-plugins` with actor headers, exactly as `kb-gateway.ts` does for the KB service.

| Method and path | Who | Reauth | Purpose |
|---|---|---|---|
| `GET /plugins` | admin | no | Packages, listing state, scopes, defaults |
| `GET /plugins/requests` | admin | no | Review queue with mirror status |
| `GET /plugins/requests/detail` | admin | no | Manifest, files, closure, install-script flags, diff |
| `POST /plugins/requests/approve` | admin | yes | Approve with scope and allowed builds |
| `POST /plugins/requests/reject` | admin | no | Reject with reason |
| `POST /plugins/upload` | admin | yes | Direct listing from npm, git, or tarball |
| `POST /plugins/scope` | admin | yes | Replace a listing's scope |
| `POST /plugins/rollback` | admin | yes | Move a listing back one version |
| `POST /plugins/delist` | admin | yes | Delist or relist |
| `POST /plugins/revoke` | admin | yes | Revoke one version |
| `POST /plugins/defaults` | admin | yes | Set or clear defaults for company or departments |
| `GET /plugins/policy` | admin | no | Read policies |
| `PUT /plugins/policy` | admin | yes | Change `market_only`, `install_scripts`, `egress_lock` |
| `GET /plugins/limits` | admin | no | Limit rows |
| `GET /plugins/limits/effective` | admin | no | One user's effective limits |
| `PUT /plugins/limits` | admin | yes | Set a limit row |
| `DELETE /plugins/limits` | admin | yes | Remove a limit row |
| `POST /plugins/restore` | admin | yes | Restore a user's profile snapshot |
| `GET /plugins` (me) | user | no | My submissions and their states |
| `POST /plugins/submit` (me) | user | no | Submit a version |
| `POST /plugins/withdraw` (me) | user | no | Withdraw a pending version |
| `GET /plugins/snapshots` (me) | user | no | My profile snapshots |
| `POST /plugins/restore` (me) | user | no | Restore my last snapshot |

Control socket verbs used by the provisioner: `open`, `close`, `reconcile-plan`. Root helper verbs: `reconcile`, `snapshot`, `restore`, each taking only a user id and, for `restore`, a snapshot id. Errors use the KB convention: 400 invalid input, 403 not allowed, 404 not found, 409 state conflict (`pending-exists`, `not-pending`, `install-scripts`, `limit-reached`, `version-exists`), 413 too large.

<a id="permissions-and-audit"></a>
## Permissions and audit

- Only the `admin` role reaches admin routes; identity enforces the whitelist `PLUGIN_ADMIN_ENDPOINTS` and the reauth set `PLUGIN_REAUTH`, modelled on `KB_ADMIN_ENDPOINTS` and `KB_REAUTH`.
- Personal routes act only on the caller's own submissions and snapshots.
- `dsh-plugins` writes events to `plugin_audit_outbox`; identity drains them into its audit log, as it drains `kb_audit_outbox`. `detail` never contains tarball contents or capabilities.

| Event | Actor | Detail |
|---|---|---|
| `plugin-submit` | user | package, version, source type |
| `plugin-withdraw` | user | package, version |
| `plugin-restore` | user | snapshot id |
| `plugin-reconcile` | system | user, added, removed, opted-out |
| `admin-plugin-approve` | admin | package, version, scope, allowed builds |
| `admin-plugin-reject` | admin | package, version, reason |
| `admin-plugin-upload` | admin | package, version, source type, scope |
| `admin-plugin-scope-change` | admin | package, old scope, new scope |
| `admin-plugin-rollback` | admin | package, from version, to version |
| `admin-plugin-delist` | admin | package, delisted or relisted |
| `admin-plugin-revoke` | admin | package, version, reason |
| `admin-plugin-default-set` | admin | package, scope |
| `admin-plugin-default-clear` | admin | package, scope |
| `admin-plugin-build-allow` | admin | package, version, allowed packages |
| `admin-plugin-policy-change` | admin | policy, scope, old value, new value |
| `admin-plugin-limit-change` | admin | scope, name, old value, new value |
| `admin-plugin-limit-delete` | admin | scope, name |
| `admin-plugin-restore` | admin | user, snapshot id |
| `admin-plugin-content-read` | admin | package, version, file |

<a id="plugin-limits"></a>
## Plugin limits

- `dsh_plugin_limit` holds three limits: `max_installed` (market packages in a user's profile), `max_submissions` (a user's pending and listed packages), and `max_submission_bytes` (store bytes a user's submissions added).
- Resolution reuses `effectiveLimits`: a user row wins; otherwise the most permissive value among the user's departments; otherwise the global row; `NULL` means unlimited.
- Lowering a limit never deletes, delists, or uninstalls anything. Only growth is refused: a submission past a limit gets 409 `limit-reached`, and so does the mirror's tarball route for a new top-level market package once `max_installed` is reached, counted from the profile manifest read at the last reconcile plus packages fetched since.
- Default installs count toward `max_installed`; reconcile installs them even past the limit, because an administrator chose them, and records it.
- Instance disk use stays under the existing XFS quota; the market does not add a second disk limit inside the instance.
- The limits page is `admin-kb-limits.tsx` reused with the plugin limit names.

<a id="system-admin-ui"></a>
## System Admin UI

- **Sidebar.** System Admin gains a **Plugin market** item in its submenu in the single sidebar, next to the knowledge base items. No new sidebar.
- **Pages.** Review queue, Listed plugins (scope, current and previous version, rollback, delist), Upload, Defaults, Policy (`market_only`, install scripts, `egress_lock`), Limits, and Audit filtered to `admin-plugin-*`.
- **Personal.** Personal gains **My plugins**: submit, request status, withdraw, and profile snapshots.
- **Plugins page.** The upstream Plugins page and Discover tab are used as they are; the company index appears as an index source the launch patch configured. A small company panel reads `x-dsh-company` to show "default" and "allowed builds".
- **Style.** Keep the existing buttons, icons, and component shapes from `admin-kit.tsx` and the upstream client. Only recolor with the existing palette and the frosted-glass layer in `theme.ts`, in a restrained enterprise style: no new colors, no new icon set, no new component shapes.

<a id="deployment-changes"></a>
## Deployment changes

- **Package.** `integrations/public-harness/packages/plugins/` for the service, the mirror, the views, and the root helper, and `packages/production/src/plugins-service.ts` and `plugins-root-helper.ts` for the entry points, mirroring `kb-service.ts` and `kb-root-helper.ts`.
- **systemd.** `dsh-plugins.service` (user `dsh-plugins`, state in `/var/lib/dsh-plugins`, control socket `/run/dsh-plugins/control.sock`, `IPAddressDeny=any` except loopback and the host proxy), `dsh-plugins-root.socket`, and `dsh-plugins-root@.service`, following `dsh-kb.service`, `dsh-kb-root.socket`, and `dsh-kb-root@.service`.
- **Accounts and directories.** `sysusers.conf` adds `dsh-plugins`; `tmpfiles.conf` adds `/var/lib/dsh-plugins` and `/run/dsh-plugins`.
- **Config.** `deploy/production/config/plugins.example.json` with the database path, store path, `ports.market`, upstream registries, git hosts allowed for sources, size caps, and request TTL. `provisioner.example.json` gains `ports.market`, which must not overlap `ports.web`, `ports.quota`, or the sidecar range; the config validators in `provisioner/src/config.ts` and `runtime-systemd/src/config.ts` check it.
- **Firewall.** `dsh-public.nft` adds `define MARKET_PORTS` and one loopback rule beside `QUOTA_PORTS`; `network.ts` adds the per-account rule; the probe in `probe.ts` checks it. The instance's private-range drop and public egress stay as they are.
- **Provisioner.** `runtime.ts` opens and closes the market listener with the quota listener, adds `pluginMarketRows`, and calls `reconcile` before start. A failing market never blocks a start: the instance starts without the index row and the failure is logged.
- **Identity.** A `plugins-gateway.ts` beside `kb-gateway.ts` forwards the routes, applies reauth, and drains the outbox.
- **Upgrade path.** Off until `plugins.json` exists; then the experimental market bundle is enabled for company profiles (see the unverified items).

<a id="public-market-later"></a>
## Adding a public market later

- Administrators subscribe to external index URLs; `dsh-plugins` fetches them on the host through the proxy, never in instances.
- Entries from a public index are candidates, not listings: an administrator imports a version, which runs the same mirror and review, with `origin = 'public'`.
- The personalized index stays one document. A later option is a second index URL per instance that lists approved public packages separately, so Discover shows two sources.
- Signatures (phase 6) apply to both: npm provenance or Sigstore for upstream packages, and a company signature over each personalized index.

<a id="risks-and-unverified-items"></a>
## Risks and unverified items

### Risks

- **Unsigned index.** Until phase 6 the index is trusted because of the channel: loopback, a per-account firewall rule, and a capability. A compromised host defeats all of it.
- **`market_only` is soft** without `egress_lock`, because git and tarball URLs and manual pnpm runs inside the instance still reach the internet.
- **Closure drift.** A dependency closure is frozen at review; a later security fix in a dependency needs a new version and a new review.
- **Shared tarballs.** A dependency shared by listings with different scopes is served to anyone who sees one of them; the mirror only reveals that the shared dependency exists.
- **Capability exposure.** The capability sits in the index URL that Settings shows. Native accounts cannot use another account's port anyway; in the container runtime it is rotated at every start.
- **Reviewer self-approval.** An administrator can approve their own submission; it is audited, and a four-eyes rule is an open question.

### Unverified items

- **Enabling the experimental bundle.** `web-rows.ts` rows only configure or disable existing entries; whether a launch patch can switch on `plugin-market-bundle` or needs an `insert` row is not verified.
- **Provided peers.** Whether pnpm 11's peer auto-install asks the mirror for `@deepseek-ai/dsh*` during a market install, and whether the mirror must then serve the runtime's own packuments, is not verified.
- **Reconcile as the tenant.** Running `dsh plugin add` on the host as the tenant before start fits the native runtime; the container runtime needs an equivalent one-shot container, not designed yet.
- **Git tarballs.** A tarball built from git blobs must install the same way as `npm pack` output; files selection by `package.json` `files` and `.npmignore` needs a decision and tests.
- **`source.integrity`.** The member name may collide with a future upstream definition; it should be agreed upstream before phase 2 is released.
- **Concurrent profile lock.** Reconcile and a user's own install must not overlap; reconcile runs only when the instance is stopped and takes the plugin manager's profile lock, which needs a test.

<a id="test-plan"></a>
## Test plan

No test uses real model keys or model calls. All listeners bind `127.0.0.1` or Unix sockets.

- **Unit.**
  - Version state machine: every transition and every refusal (`pending-exists`, `not-pending`, `install-scripts`, `version-exists`).
  - Visibility: company, department, several departments, a disabled user, a delisted or revoked version.
  - Limits: user row wins, most permissive department, global fallback, lowering keeps data, growth gets 409.
  - Index builder: format-1 validity through `parseMarketIndex`, `source.integrity`, inlined icons, no URL icons, stable digest.
  - Mirror: packument only lists closure versions in the user's view; tarball by digest; unknown digest 404.
- **Integration.**
  - Identity gateway: whitelist, reauth on the listed routes, audit outbox drained with the right events.
  - Mirror pipeline with a local test registry and a local git server: npm version with integrity, git commit, upload, closure with an install script refused, size accounting.
  - Upstream `pluginMarket` reading the personalized index from the listener, including no redirects and `maxBytes`.
- **End to end** (native stack, extending the kb-stack e2e harness):
  - A department user sees a department listing; a user outside it does not, and its tarball answers 404.
  - Discover installs a market plugin with public egress closed in the test network.
  - Default reconcile installs, the user removes, the next start does not reinstall.
  - A new approved default reaches the user on the next start; rollback brings the previous one back.
  - `market_only` makes a registry spec outside the market fail with not-found.
  - Another account cannot connect to the listener port.
- **Firewall rendering.** `network.ts` and `dsh-public.nft` rule tests, and the probe detects a missing market rule.
- **Regression.** The upstream plugin-market and plugin-manager tests run unchanged.

<a id="phased-implementation-plan"></a>
## Phased implementation plan

### Phase 0: verification spikes

1. Enable `plugin-market-bundle` through a launch patch on a test instance and record the mechanism.
2. Install a bundle from a minimal static registry with pnpm 11 and confirm which packuments it requests, including provided peers.
3. Run `dsh plugin add` and `dsh plugin remove` as a tenant account on the host against a loopback registry with the instance stopped.
4. Build a tarball from git blobs and compare its install with `npm pack` output.

### Phase 1: store, mirror, and serving

1. Create `packages/plugins` with the database schema and migrations.
2. Implement the mirror pipeline for npm and uploads, the content-addressed store, and closure resolution.
3. Implement the per-instance listener, the capability, the index builder, and the packument and tarball routes.
4. Add `ports.market` to the provisioner and runtime configs, the nft rules, and the probe.
5. Add `pluginMarketRows` and open and close calls in the provisioner.
6. Add the systemd units, sysusers, tmpfiles, and `plugins.example.json`.
7. Admin direct upload with company scope only, behind reauth, with audit.

### Phase 2: review flow and scopes

1. Personal submission routes, the pending rule, withdraw, and the 30-day expiry.
2. Git sources with the generator's fetch rules.
3. Review queue, detail, approve with scope, reject, and the install-script refusal.
4. Department scopes, scope change, delist, relist, revoke, and rollback with history.
5. `plugins-gateway.ts` in identity with the whitelist, reauth set, and outbox drain.
6. System Admin pages and Personal **My plugins** with the existing components.

### Phase 3: defaults and updates

1. Defaults per company and department, and `defaults.json`.
2. Root helper verbs `reconcile`, `snapshot`, and `restore`.
3. Reconcile before start, `plugin_default_state`, opt-out detection, and the pending-update notice.
4. Profile snapshot restore for users and administrators.

### Phase 4: policy and limits

1. `dsh_plugin_limit` with the shared limits module and page.
2. `max_installed` on the tarball route and in reconcile.
3. `market_only` per company or department through the launch patch.
4. `egress_lock` if the open question is decided for it.

### Phase 5: pure-skill packages

1. Skill package checks in the mirror.
2. Per-user skill views built like KB views, bound read-only, and the `customSkillDirs` row.
3. Listing, defaults, and limits for skills.

### Phase 6: later

1. Signature verification for upstream packages and a signed personalized index.
2. Public market subscriptions.
3. Forced installs.

<a id="open-questions"></a>
## Open questions and recommended defaults

1. **Should `market_only` also close public egress (`egress_lock`)?** Recommended default: off. `market_only` alone pins the registry; `egress_lock` stays an explicit per-department choice, because it breaks other outbound use. This is security-relevant and needs a user decision.
2. **Install scripts.** Recommended default: refuse a version whose closure has install scripts unless an administrator allows each such package after reauth.
3. **When do default updates arrive?** Recommended default: at the next instance start, with a notice; no forced restart.
4. **Is an opt-out permanent?** Recommended default: yes, per package, until an administrator resets defaults for that package; a new version does not reinstall it.
5. **Default limit values.** Recommended default: global `max_installed` 50, `max_submissions` 20, `max_submission_bytes` 200 MiB.
6. **Git sources that need a build step.** Recommended default: unsupported; the repository must commit built output or publish to npm.
7. **Can an administrator approve their own submission?** Recommended default: yes, audited; a four-eyes option later.
8. **Can a submitter delist their own plugin?** Recommended default: no; submitters withdraw pending versions only.
9. **Mirror retention.** Recommended default: keep every tarball a listing history refers to; revoked versions are purged by an explicit administrator action after 90 days.
10. **Upload size cap.** Recommended default: 50 MiB per tarball and 500 MiB per closure.
11. **Pure-skill packages.** Recommended default: yes, in phase 5, delivered as read-only host views rather than through pnpm.
12. **Single-user scope.** Recommended default: not offered; scopes are departments and the whole company, as decided.

<a id="sources"></a>
## Sources

- [Plugin market index format](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)
- [Plugin market Discover](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md)
- [Plugin install registries](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md)
- [LLM Wiki knowledge base design](2026-10-17-llm-wiki-knowledge-base-design.md)
- [Public Harness native design](2026-10-11-public-harness-native-design.md)
