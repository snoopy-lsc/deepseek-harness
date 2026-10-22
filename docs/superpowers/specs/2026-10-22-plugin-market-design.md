# Company plugin market design

English | [中文](2026-10-22-plugin-market-design.zh.md)

## Summary

This is a design specification for review; it contains no implementation code. It adds a company plugin market to the [native public Harness deployment](2026-10-11-public-harness-native-design.md) and to its container (production) runtime. It extends the plugin market that already exists upstream and does not replace it: the [index format 1](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md), the Host `pluginMarket` service and the Web **Discover** tab described in the [Discover note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md), and the registry plan of the [plugin install registries note](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md). No upstream package changes.

A new unprivileged host service, `dsh-plugins`, keeps the catalogue of reviewed plugins. A separate socket-activated fetch service, which can reach the network only through a new allowlisting egress proxy, mirrors every approved version into a content-addressed company store as one pinned artifact that bundles its reviewed dependency closure. Each user has one stable loopback port from a range that systemd holds open for `dsh-plugins`. In both runtimes the firewall lets only that user's account reach that port, and only `dsh-plugins` can receive on it. The listener serves a personalized `index.json`, built from visibility scopes the way the [knowledge base design](2026-10-17-llm-wiki-knowledge-base-design.md) builds KB views, and a read-only npm registry of approved artifacts. The instance firewall stays closed to the intranet.

Plugins reach the catalogue in two ways: a user submits and a different administrator approves and picks the visibility scope, reusing the KB share approval flow; or an administrator uploads and lists directly in System Admin. Every step writes an audit event and can be rolled back. Users install and update plugins themselves through every existing path. Administrators set default installs per department or for the whole company. A newly approved default version is pushed to running instances by a small in-instance sync plugin, with a pre-start reconcile as the fallback. Signature verification is phase 2, as decided.

## Contents

- [Goals and non-goals](#goals-and-non-goals)
- [Requirements mapping](#requirements-mapping)
- [Current system facts](#current-system-facts)
- [Architecture overview](#architecture-overview)
- [Package kinds and index extensions](#package-kinds-and-index-extensions)
- [Data model](#data-model)
- [Store, egress, and mirror](#store-and-mirror)
- [Serving instances](#serving-instances)
- [Listing flows and state machine](#listing-flows)
- [Installation and policy](#installation-and-policy)
- [Default installs, sync, and reconcile](#default-installs)
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
- Only pinned, reviewed versions: an npm version is pinned by exact version and integrity, a git source by an exact commit, the dependency closure by the reviewed lockfile, and every new version is reviewed again.
- Instances never reach the intranet or an upstream registry for market installs; they fetch only from their own loopback listener.
- Two listing paths, both audited and both reversible.
- Default installs per department or company that a user can remove, and automatic push of newly approved default versions.
- Every existing install path keeps working: `dsh plugin add`, the Plugins page, the `plugin_manager` tool, and manual URLs.
- Limits on plugins per user and on submission storage, reusing the three-tier limit rules of `dsh_kb_limit`.
- Room to add a public market later without changing the data model.

### Non-goals

- No signature verification in phase 1; it is phase 2.
- No forced installs that a user cannot remove; they come later.
- No automatic update of plugins a user installed by hand.
- No change to upstream packages: not the index format, `pluginMarket`, the Discover UI, nor the plugin manager.
- No build step on the host: a git source must contain its built output.
- No redesign of the Plugins page or System Admin; existing buttons, icons, and component shapes stay.

<a id="requirements-mapping"></a>
## Requirements mapping

| # | User decision | Where | Status |
|---|---|---|---|
| 1 | Company market in the deployment; per-user `index.json` from the server; host proxy serves containers; intranet firewall stays closed; public market later | [Serving instances](#serving-instances), [Public market](#public-market-later) | Met |
| 2 | Two listing paths, both audited and reversible; reuse the KB share approval | [Listing flows](#listing-flows), [Audit](#permissions-and-audit) | Met; self-approval refused by default (open question 5) |
| 3 | Exact npm version plus integrity, exact git commit, install scripts off, internal mirror, signatures phase 2, pure-skill type considered | [Store](#store-and-mirror), [Package kinds](#package-kinds-and-index-extensions), [Plan](#phased-implementation-plan) | Met, with one limit: if phase 0 forces fallback mode (or a version has install scripts), transitive dependencies are limited to reviewed tarballs but not pinned, and Discover installs get no lockfile check. Pure-skill in phase 2 |
| 4 | Users install; department or company defaults that users can remove; market-only toggle; all install paths kept | [Installation](#installation-and-policy), [Default installs](#default-installs) | Met; market-only is policy unless `egress_lock` (open question 1) |
| 5 | Manual updates; defaults pushed automatically after approval; re-approval of every version; rollback to the previous snapshot | [Default installs](#default-installs), [Updates](#updates-and-rollback) | Met; live push within minutes when the instance is idle, next start as fallback (open question 3) |

<a id="current-system-facts"></a>
## Current system facts

These facts were read from the repository and shape the design.

- **Index format 1** (`packages/util/plugin-market-index/src/types.ts`, `index.ts`): a plugin has `name`, display fields, `metadata`, and `versions[]`; there is no `dist-tags` member. A version has `version`, `publishTimestamp` in Unix **seconds** below 10^11, `source`, and `engines.dsh`. An npm source is `{ type: 'npm', registry? }`; a git source is `{ type: 'git', url, commit, path? }`. `parseMarketIndex` ignores **and drops** members the format does not define, so nothing extra reaches `pluginMarket` consumers. `marketInstallTarget` builds `<name>@<version>` or `git+<url>.git#<commit>`.
- **Host reader** (`packages/boot/plugin-market/src/index.ts`): `indexes` is a volatile config field the user can change in Settings; `fetchTimeoutMs` 15 s, `maxBytes` 128 MiB, `cacheTtlMs` 10 minutes. It fetches with `redirect: 'error'` and only an `accept` header. The `plugin_market` tool (`tools.ts`) lists the configured index URLs and returns each version's target and registry to the model.
- **Opt-in bundle** (`packages/experimental/plugin-market-bundle/cordis.patch.yml`): inserts the `plugin-market` and `ui-plugin-market` rows; shipped profiles leave it off.
- **Plugin manager** (`packages/boot/plugin-manager/src/index.ts`, `operations.ts`, `build-approval.ts`): `installBundle(spec, { registry })` runs pnpm and restores `package.json` and `pnpm-lock.yaml` on failure, repairing with `pnpm install --frozen-lockfile`; with HMR an upgrade is remove then install. pnpm checks lockfile tarball URLs against its default registry unless they belong to a named registry. Build scripts run only when approved into `allowBuilds` in the tenant-writable `pnpm-workspace.yaml`.
- **CLI** (`apps/cli/src/args.ts`): `dsh plugin <args>` forwards its arguments verbatim to pnpm in the profile directory; `--patch` may be given more than once.
- **Generator** (`apps/plugin-market-generator/src/fetchers.ts`): checks npm tarballs against registry integrity and reads git objects in a private bare repository with hooks disabled, never running package code.
- **KB patterns** (`integrations/public-harness/packages/kb/src/share.ts`, `views.ts`, `limits.ts`, `store.ts`): one pending request per KB with a 30-day TTL; scopes of company, group, or user; `effectiveLimits` resolves user, then the most permissive of the user's effective groups including ancestor departments, then global, and is bound to the KB `LIMIT_NAMES`.
- **Audit and reauth** (`integrations/public-harness/packages/identity/src/kb-gateway.ts`): `KB_ADMIN_ENDPOINTS`, `KB_REAUTH`, and the `KB_EVENTS` set; the outbox drain drops events not in that set.
- **KB root helper** (`integrations/public-harness/deploy/native/systemd/dsh-kb-root@.service`, `packages/kb/src/runner.ts`): reads no tenant file and writes nothing; user helpers run with `PrivateNetwork=yes` and `RestrictAddressFamilies=AF_UNIX`. `dsh-kb.service` itself has no network.
- **Native launch** (`integrations/public-harness/packages/runtime-systemd/src/units.ts`, `config.ts`, `deploy/native/config/native.json.example`): every instance runs `--patch <paths.launchPatch>`, one root-owned file inside the release directory shared by all users; per-instance facts reach the unit as environment variables such as `PUBLIC_HARNESS_QUOTA_PORT`.
- **Native start order** (`runtime-systemd/src/runtime.ts`): start the slice, `network.install`, then the instance unit. `initializeWorkspace` runs git as the account in a transient unit with the instance slice, AppArmor profile, `PrivateNetwork=yes`, and memory and task limits.
- **Native network** (`runtime-systemd/src/network.ts`): the output chain stamps loopback connections with the sender UID; an account's input rules admit only its own quota port on loopback; accounts not in `users_out` fall through to the default accept.
- **Container launch** (`integrations/public-harness/packages/provisioner/src/runtime.ts`, `limits.ts`): `webPatch` writes a per-user patch with `insert` rows for the release's own bundles; the instance reaches the host at `config.quota.hostAddress` through `pasta:--map-host-loopback`. `assertSafeRunArgv` admits a fixed volume set.
- **Container network** (`deploy/production/nftables/dsh-public.nft`, `deploy/production/README.md`): pasta connects as the account UID, so `meta skuid` selects one instance; today the static table admits the whole `QUOTA_PORTS` range for the whole UID range, a recorded decision to keep per-user rules out of the firewall.
- **Service sandboxes**: `deploy/native/systemd/dsh-quota.service` is the model for a service that binds loopback listeners (`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`). No host egress proxy exists in the repository.
- **Admin UI** (`integrations/public-harness/packages/ui/src/client/nav.tsx`, `admin-kit.tsx`, `admin-kb-limits.tsx`, `theme.ts`): System Admin is registered for the `admin` role in the single sidebar; `theme.ts` holds the enterprise frosted-glass layer.

<a id="architecture-overview"></a>
## Architecture overview

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

- `dsh-plugins` holds the catalogue and serves instances. It has no outbound network beyond loopback.
- Fetching runs in `dsh-plugins-fetch@.service` instances, socket-activated per request with fixed verbs, which can reach only the new `dsh-plugins-egress` proxy, which enforces a host allowlist.
- The provisioner, already root in both runtimes, writes the per-instance patch and npmrc, adds the firewall element, and runs the pre-start reconcile as the account. No new root helper is added.
- In the instance, Discover, the `plugin_market` tool, and `plugin_manager` work unchanged; the inserted `public-harness-plugin-sync` plugin pushes default updates.
- `<host>` is `127.0.0.1` in the native runtime and `config.quota.hostAddress` in the container runtime.

<a id="package-kinds-and-index-extensions"></a>
## Package kinds and index extensions

### Kinds

- **bundle**: an npm package whose `package.json` declares `dsh.bundle`, the only kind the upstream index lists today.
- **skill**: a pure-skill package, a directory of `SKILL.md` folders with no code. It is never written into `index.json`. The host links approved skill packages into a per-user read-only directory, as KB views are built, and the per-instance patch adds it to `skill-filesystem` `customSkillDirs`, as `kbSkillRows` does. Phase 2.

### Index members added within format 1

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

- `parseMarketIndex` drops `x-dsh-integrity` and `x-dsh-company`, so Discover and the `plugin_market` tool never see them. They exist for our own readers: the sync plugin and tools that read the raw document. The company facts users see come from **Personal > My plugins** over `/account/api/me/plugins`, not from the upstream Plugins page.
- `x-dsh-integrity` is namespaced until upstream defines an integrity member; it is proposed upstream later.
- Every version is served as an npm source on the user's listener, including those reviewed from git, because an instance cannot reach the intranet git server. The commit stays in `x-dsh-company.origin`.
- Timestamps are Unix seconds. Icons are inlined `data:` URLs of at most 32 KiB; URL icons are never passed through.
- The registry URL carries no secret. It is the same for the user across instance starts and `dsh-plugins` restarts, so it is safe in Settings, the model context, and logs.

<a id="data-model"></a>
## Data model

All tables live in the `dsh-plugins` SQLite database. Users and groups come from identity's `dsh_user_group` through the principal sync the KB service uses, with effective groups including ancestor departments.

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

- `plugin_version` is the review request. The two partial unique indexes enforce one pending version per package and let a rejected, withdrawn, or expired version number be submitted again as a new row.
- `plugin_artifact` enforces the global invariant `name@version -> one sha512`. A second artifact for an existing pair is refused with 409 `version-exists`.
- `claimed_at` is set by the first approval. Until then a rejected, withdrawn, or expired first version releases the name (see [Who may submit](#listing-flows)).
- `dsh_plugin_limit` copies `dsh_kb_limit` column for column; `effectiveLimits` is generalized over the limit names before it is shared.
- `origin = 'public'` is reserved for the later public market.

<a id="store-and-mirror"></a>
## Store, egress, and mirror

### Directory layout

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

### Fetch service

`dsh-plugins` has no capabilities, so it cannot start units as another user; the KB needs its root helper for the same reason. Fetching therefore uses socket activation, which needs neither root nor polkit:

- `dsh-plugins-fetch.socket`: `ListenStream=/run/dsh-plugins/fetch.sock`, `Accept=yes`, `SocketUser=root`, `SocketGroup=dsh-plugins`, `SocketMode=0660`.
- `dsh-plugins-fetch@.service`: `User=dsh-plugins-fetch`, `StandardInput=socket`, `IPAddressDeny=any`, `IPAddressAllow=localhost`, `Environment=HTTPS_PROXY=http://127.0.0.1:<egressPort>`, no other environment, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, no writable path outside its private tmp, empty capabilities, `MemoryMax`, `TasksMax`, and `RuntimeMaxSec=900`. `IPAddressAllow=localhost` alone would still reach other loopback services, so an nft output rule lets the `dsh-plugins-fetch` UID connect only to `127.0.0.1:<egressPort>`; quota, identity, and every other local port are refused.
- One request per connection, framed like the KB root helper: a JSON header `{verb, args, input}` followed by `input` bytes, and one reply `{ok, bytes}` followed by the result archive and a JSON report. `dsh-plugins` writes the result into `staging/` and then the store; the fetch service writes nothing outside its private tmp.
- Fixed verbs, each with an argument allowlist:
  - `npm-version {registry, name, version}`: registry must be in `egress.allow`, name a valid npm name, version exact SemVer.
  - `git-commit {url, commit, path}`: https URL on an allowed git host and path prefix, 40-hex commit, relative path without `..`.
  - `upload-check {}`: the uploaded tarball arrives as `input`.
  - `closure {name, version, registry}` and `artifact {versionId}`: resolve the closure and build the pinned artifact from bytes passed in `input`.
- Credentials: none for user submissions. A read-only deploy token for administrator git uploads is passed to the one request that needs it, as `input`, never in the environment or argv.

### Egress: the new host proxy component

No host egress proxy exists today, so this design builds one, `dsh-plugins-egress`:

- A small HTTP CONNECT proxy, part of `packages/plugins`, running as its own user, listening on `127.0.0.1:<egressPort>`. A firewall rule lets only the `dsh-plugins-fetch` UID connect to it.
- It accepts `CONNECT host:443` only for host names in `plugins.json` `egress.allow`: the configured npm registries and git hosts. A git host may be narrowed to path prefixes, which the fetch service checks.
- It rejects IP-literal targets unless the address is in an `egress.intranet` CIDR.
- It resolves the name itself and checks **every** A and AAAA record. It refuses the request if any record is in a forbidden range: IPv4 loopback, private, link-local, CGNAT, multicast, and metadata; IPv6 `::1`, `::ffff:0:0/96`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`, `2002::/16`, `2001::/32`, and multicast. The exception is a host listed in `egress.intranet`, which must resolve inside its configured CIDRs.
- It then connects to the exact address it validated, never resolving again, so DNS rebinding cannot swap the target.
- It never follows redirects (CONNECT has none), so a redirect to an unlisted host fails at the next CONNECT. It logs every tunnel with host, address, port, request id, and bytes.
- `dsh-plugins` itself keeps only loopback: it accepts on the instance listeners and talks to the fetch service over its socket.

### Mirroring a version

1. **Resolve the source.** npm: read the packument from the source registry, take the exact version's `dist.tarball` and `dist.integrity`; the tarball host must be the registry's host, a version without integrity is refused. git: https only; fetch the pinned commit with the generator's rules (depth 1, hooks and file-system monitor off, no submodules) and `-c http.followRedirects=false`; build a tarball from the package directory's blobs. A user submission is fetched without credentials, so it can read only repositories readable anonymously from the host. Upload: the `.tgz` is unpacked safely, refusing absolute paths, `..`, symbolic and hard links, device files, more than 10,000 entries, or more than 200 MiB unpacked.
2. **Check the package.** The tarball's `package.json` must name the package and version. git and upload sources must use a configured company scope such as `@corp-dsh/`, and the name must not exist on any configured upstream registry. A bundle must declare `dsh.bundle` with a patch; a skill package holds only `SKILL.md` folders and assets.
3. **Resolve the closure.** First scan the package's own dependency specs statically and refuse anything that is not a SemVer range (git, URL, `file:`, `link:`, `workspace:`, `npm:` alias) before any request is made. Then run `pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --config.registry=<source registry>` for the single dependency in an empty directory, with `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` excluded as provided peers. Parse the lockfile: every entry must be a SemVer version resolved from the configured registry with integrity; anything else is refused with 409 `closure-source`. Download every tarball through the proxy and verify its integrity.
4. **Detect install scripts.** A closure package has an install script when its manifest has `preinstall`, `install`, `postinstall`, or `prepare`, sets `gypfile`, or ships a top-level `binding.gyp` (pnpm runs `node-gyp rebuild` implicitly). Each is recorded in `plugin_closure.install_script`.
5. **Choose the mode and build the artifact.**
   - **Bundle mode** repacks the plugin tarball with its reviewed closure under `bundleDependencies`, laid out from the lockfile, so installing it resolves no dependency ranges at all. It is used only when the closure has no install script, or when phase 0 shows that pnpm 11 applies `allowBuilds` to bundled packages. Bundle mode is never a way around the install-script default.
   - **Fallback mode** serves the original tarballs and per-user filtered packuments, for versions with install scripts that bundle mode cannot govern, or for every version if phase 0 rejects bundle mode. Its guarantee is weaker: only reviewed tarballs are installed, but pnpm may pick a different combination of reviewed versions. Sync and reconcile check the installed lockfile against `plugin_closure`; **Discover and manual installs get no lockfile check**.
   - The artifact is capped at 200 MiB. Its sha512 becomes `artifact_sha512`; the upstream integrity is kept for provenance.
6. **Store and freeze.** Move the artifact into `store/sha512/` by digest and insert `plugin_artifact`; `mirror_state` becomes `ready`, or `failed` with `mirror_error`. Once `ready`, a version is never mirrored or repacked again; a different artifact needs a new submission.

### Integrity guarantees

- **Review binding**: the review page shows `artifact_sha512`, the mode, and the artifact's file list. The approve request must carry `expected_artifact_sha512`, and the server approves only if it equals the stored value (409 `artifact-mismatch` otherwise).
- **Fetch**: every tarball matches the source registry's integrity, or the git commit it was built from.
- **Store**: blobs are named by their digest and never rewritten.
- **Serve**: each blob is re-hashed on its first read after a start and by a daily scrub. A mismatch quarantines the blob, answers 503, and writes `plugin-store-corrupt`.
- **Client**: pnpm checks the artifact against the integrity in the packument, which comes from the same server, and the lockfile then pins it for later installs. Sync and reconcile also compare the installed lockfile integrity with `artifact_sha512` from the catalogue and roll back on mismatch. A Discover install has no independent client-side check until upstream carries an integrity member; this is an unverified item and an upstream proposal.

<a id="serving-instances"></a>
## Serving instances

### Listener and port

- `plugin_endpoint` maps ports and users one to one: a port from `ports.market` belongs to at most one user, and a user has at most one port. The range must lie in 1024-32767, must not overlap `ports.web`, `ports.quota`, or `ports.sidecar`, and is capped at 4,096 ports. A user keeps the port across starts, so the URL in Settings and the model context does not change. Ports are held per account for as long as the account exists, unlike the quota ports allocated per running instance, so the cap of 4,096 is the maximum number of accounts that can use the market. The config validator also checks that `ports.web`, `ports.quota`, `ports.sidecar`, and `ports.market` all fit below 32768 without overlap. A port is reassigned only after its row has been deleted. Rows are deleted when the account is deleted, and when the provisioner starts and finds a row whose account no longer exists.
- **The whole range is held by systemd.** The installer generates `dsh-plugins.socket` with one `ListenStream=127.0.0.1:<port>` line per port in `ports.market` and `Service=dsh-plugins.service`. The socket unit starts before any tenant unit or container, so no other process can bind a market port. The listeners stay open while `dsh-plugins` restarts or is stopped. `dsh-plugins` takes the descriptors through `LISTEN_FDS`, maps each to its port, and answers the common 404 on a port with no row.
- When the provisioner starts an instance it calls `open(userId, instanceId, uid)` on the control socket. `dsh-plugins` assigns or confirms the user's port, draws a fresh npm bearer token, stores its SHA-256, and returns the port and token. `close(instanceId)` clears the token when the instance stops. After a restart `dsh-plugins` keeps accepting the stored token hash for rows that still have an `instance_id`.

### Who can connect

Market traffic must pass two drop rules and then reach one accept. In nftables an `accept` ends only the current base chain, and a packet then still traverses every later base chain, while a `drop` anywhere is final. So the drops live in their own table, and the accept sits where the existing rules would otherwise drop the traffic.

- **Own table, loaded on its own.** Both drops live in a separate table, `inet dsh_market`, with base chains at priority `filter - 2`.
  - It is not part of the per-instance `network.install` transaction, and not part of `dsh-public.nft`. `dsh-plugins.socket` loads it with `ExecStartPost=-<loader>`, so it is loaded again on every socket unit start. The `-` prefix keeps a load failure from failing the socket unit or any instance start.
  - The loader creates the table and the `market_owner` set if they are absent. It flushes and refills only the chains and never flushes the set, so the elements survive a reload.
  - `renderInputDispatch`, which flushes and refills `dsh_native input` on every instance install and removal, never touches it.
- **Receiving socket.** `iif "lo" tcp dport $MARKET_PORTS jump market_listener`. The subchain `market_listener` holds `socket cgroupv2 level <n> "<listener cgroup>" return`, followed by `drop`.
  - Which cgroup holds the listening sockets is an assumption until phase 0 item 8 settles it. The candidate first assumed was `init.scope` (level 1), on the reasoning that PID 1 creates the sockets. It is likely wrong: with BPF firewall support, systemd creates INET listeners in a helper inside the socket unit's own cgroup, so they probably sit in `system.slice/dsh-plugins.socket`. The alternative rule is `socket cgroupv2 level 2 "system.slice/dsh-plugins.socket"`, and the loader is rendered with whichever cgroup phase 0 measures.
  - Either way, accepted connections inherit the listener's cgroup, so the rule does not depend on whether `dsh-plugins.service` is running or has restarted.
  - The rule never names `dsh-plugins.service`. nft resolves `socket cgroupv2` paths when the rule loads (`network.ts`). A missing service cgroup would fail the load, and a restarted service would get a new cgroup id.
  - The socket unit's cgroup exists while the unit is active, and the loader runs from its `ExecStartPost`, so the path resolves. If the socket unit stops, its ports are no longer held, and a stale cgroup id makes the rule drop all market traffic: it fails closed.
- **Sender owns the port.** `set market_owner` holds exactly the `uid . port` pairs of `plugin_endpoint`: `type mark . inet_service` natively and `type uid . inet_service` in containers. Both rules use a `!=` set lookup, so every pair not in the set is dropped, including any unmapped port. A map lookup is not used, because a port missing from the map would not match and would fail open.
  - Native, in the `dsh_market` input chain: `iif "lo" tcp dport $MARKET_PORTS ct mark . tcp dport != @market_owner drop`. This works because the output chain stamps every loopback connection with `ct mark set meta skuid`, for every UID.
  - Container, in the `dsh_market` output chain: `oif "lo" tcp dport $MARKET_PORTS meta skuid . tcp dport != @market_owner drop`. Being a separate base chain, its drop applies before `dsh_instances` accepts UIDs outside the instance range.
  - Unmapped ports, root, and host service accounts such as `dsh-router` and `dsh-identity` are therefore refused. Health checks by the provisioner and the probe use the control socket, never a market port.
- **The accept for the owner.** Traffic that passes both drops would still be dropped by the existing rules, so each runtime adds one accept:
  - Native: `renderUserNetwork` adds `ct mark <uid> iif "lo" tcp dport $MARKET_PORTS accept` to `in_<uid>`, before its final `ct mark <uid> iif "lo" counter drop`.
  - Container: `dsh-public.nft` adds `oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept` before `oif "lo" drop`.
  - Neither names a cgroup, so neither can fail to load.
- **Together.** The market range is guarded jointly by this accept and the two drops in `dsh_market`: the accept admits any instance account to the range, and the drops narrow it to the owner of the port and to the systemd listener.
- **Fail closed.** The accepts admit the whole range, so a missing `dsh_market` table would let one instance account reach another's port.
  - The probe checks for the table, both chains, and every endpoint's set element before each instance start and every minute.
  - While anything is missing, the provisioner reports `firewall-state down` on the control socket. `dsh-plugins` then closes every market connection without reading it, and instances start without the market rows.
  - `dsh-plugins` starts in that state and serves only after the provisioner reports `up`.
- The provisioner adds the set element before the instance starts and deletes it with the endpoint row.
- This changes the recorded decision that the container firewall has no per-user rules, only for the market range.
- Isolation rests on these rules. The npm bearer token is defence in depth.

### Routes

- `GET /index.json`: the personalized index, rebuilt when the listing generation, the user's groups, or the user's defaults change, and cached by digest.
- `GET /npm/<name>`: packuments, accepting `@scope%2Fname`, `@scope%2fname`, and `@scope/name`. Each lists only the artifacts of versions visible to the user, with standard tarball paths.
- `GET /npm/<name>/-/<basename>-<version>.tgz`: the artifact, standard npm path, so pnpm writes no tarball URL into the lockfile.
- `GET /sync` and `POST /sync/report`: the sync plan and the instance's report (see [Default installs](#default-installs)).
- npm routes require `authorization: Bearer <token>`, compared in constant time. Every refusal is the same 404 with the same body, after the same work as a success, so it reveals neither a wrong token nor an unseen listing. Responses never redirect. Access logs record only the first 8 hex characters of the token hash.

### How the instance learns the URL and token

- **Native**: the unit gets a second patch, `--patch /run/dsh-public/instance-market/<account>.yml`, root-owned and readable only by the account's group, written atomically by the provisioner before the unit starts. It also gets `NPM_CONFIG_GLOBALCONFIG=/run/dsh-public/instance-market/<account>.npmrc`. The shared `paths.launchPatch` stays untouched. `config.ts` validates the new `paths.instanceMarketDir` as a root-owned directory outside the tenant's writable paths.
- **Container**: `webPatch` gains the same rows. The npmrc is mounted read-only as `<marketDir>/<account>:/run/dsh-market:ro`, a volume added to the `assertSafeRunArgv` allowlist, with `NPM_CONFIG_GLOBALCONFIG=/run/dsh-market/npmrc`.
- The npmrc holds `@corp-dsh:registry=http://<host>:<port>/npm/` and `//<host>:<port>/npm/:_authToken=<token>`. Under `market_only` it also sets `registry=http://<host>:<port>/npm/`, so a plugin manager repair or a plain `pnpm install` resolves public-name artifacts from the mirror too. `NPM_CONFIG_GLOBALCONFIG` applies to every npm and pnpm run in the instance, so this also sends the user's own workspace installs to the mirror, where public packages are not available; open question 1 states this. The company scope is a dedicated name such as `@corp-dsh/`, so the mapping does not capture a scope the company already uses for its own development packages (open question 6).
- Token exposure: the token is not in any URL, in the patch, in the lockfile, in `plugin_market` output, or in access logs. Any process running as the account can read the npmrc, including model-run shell commands; that is the account's own trust domain, and the token only reaches that account's own port.
- The patch rows, built by a new `pluginMarketRows` in `contracts/src/web-rows.ts`:
  - insert `plugin-market` and `ui-plugin-market` as the experimental bundle's `cordis.patch.yml` does;
  - set `plugin-market` `indexes` to `[http://<host>:<port>/index.json]`;
  - insert `public-harness-plugin-sync` from the release assets with its sync URL;
  - when the user is under `market_only`, set the plugin manager's `registry` to the mirror and `fallbackRegistries` to `[]`.
- `indexes` and the registry fields: the CLI applies `--patch` files after the profile layer, in argument order (`apps/cli/src/args.ts`). The market patch may therefore override a user's own Settings change to these fields at every start. Phase 0 checks which layer wins and whether upstream records the user's edit separately. Until then the doc does not promise that a user can keep a different `indexes` value, and `market_only` is only as strong as that order (see [Installation and policy](#installation-and-policy)).

<a id="listing-flows"></a>
## Listing flows and state machine

### Who may submit

- Any user may submit the first version of a new company-scoped name. The name is held while that version is pending and claimed (`claimed_at` set) when it is approved.
- If that first version is rejected, withdrawn, or expires before any version of the package was approved, the name is released: `owner_user_id` is cleared and the next submission of the name, by anyone, makes its submitter the owner.
- Later versions of a claimed package may be submitted only by its owner or an administrator; others get 403 `not-owner`.
- An administrator may not approve a version they submitted themselves (403 `self-approval`); they use path B instead, which is audited as an upload.

### Transitions

| From | Action | To | Who | Refusals |
|---|---|---|---|---|
| none | submit | pending, mirror queued | owner, or anyone for an unclaimed name | 403 `not-owner`, 409 `pending-exists`, 409 `version-exists`, 409 `limit-reached`, 409 `name-taken` |
| pending | mirror finishes | pending, mirror ready or failed | system | none |
| pending | approve with scope and `expected_artifact_sha512` | approved | admin, not the submitter | 409 `mirror-not-ready`, 409 `artifact-mismatch`, 409 `install-scripts`, 403 `self-approval` |
| pending | reject | rejected | admin | 409 `not-pending` |
| pending | withdraw | withdrawn | submitter | 409 `not-pending` |
| pending | 30 days pass | expired | system | none |
| none | upload with scope | approved | admin | 409 `version-exists`, 409 `install-scripts`, 409 `closure-source` |
| approved | revoke | revoked | admin | 409 `not-approved` |
| rejected, withdrawn, expired | submit the same number | new pending row | owner, or anyone once the name is released | as submit |

### Listing pointer rules

- Approving or uploading a version greater than the current one makes it current and moves the old current to `previous_version_id`. A lower or equal version is approved into history only and never becomes current by approval.
- **Rollback** makes `previous_version_id` current. The new previous is the highest approved, unrevoked version below the new current, or `NULL`. With no previous version it is refused with 409 `no-previous`.
- **Revoke** of a non-current version removes it from packuments and the index. Revoke of the current version rolls back as above. With no previous version the package is delisted with reason `revoked`.
- **Delist** keeps the scope rows. The index stops listing the package, defaults stop installing it, and the mirror keeps serving its artifacts to users in the original scope so existing profiles stay reinstallable. **Relist** clears `delisted_at`.
- **Scope change** rewrites `plugin_scope`. Users who lose sight of a plugin keep what they installed, but the mirror stops serving them its artifacts, so a later reinstall from the market fails with not-found.

### Path A: user submission and administrator approval

1. The user submits from **Personal > My plugins** an npm name and exact version, an https git URL with a 40-hex commit, or a tarball, plus a note.
2. The fetch service mirrors it; the request shows `mirror_state`. A failed mirror can be withdrawn and submitted again.
3. A different administrator reviews it in **System Admin > Plugin market > Review queue**: manifest, the artifact's `artifact_sha512`, mode, and file list, closure with install-script flags, size, and a file-name diff against the current version. They approve with scope and any allowed builds after reauth, or reject with a reason. The page sends the digest it showed as `expected_artifact_sha512`, so the approval covers exactly the reviewed artifact.
4. Submitters can withdraw pending versions and can ask for a delist, which an administrator handles.

### Path B: administrator direct listing

- In **System Admin > Plugin market > Upload**, an administrator gives an npm name and version, a git URL and commit, or a tarball, and a scope. The same mirror and checks run. On success the version is `approved` with `requested_by = reviewed_by = <admin>` and listed at once, after reauth, as `admin-plugin-upload`.

<a id="installation-and-policy"></a>
## Installation and policy

### User installs

- Discover installs `<name>@<version>` with the entry's registry, the user's mirror. The plugin manager asks that registry alone, so a company package never falls through to a public registry.
- The `plugin_market` tool returns the same target and registry, which carry no secret; `plugin_manager` `install_bundle` keeps its approval requirement.
- The npmrc maps the company scope to the mirror, so `dsh plugin add @corp-dsh/x@1.2.3` resolves there too. Other specs behave as today unless `market_only` applies.

### "Only allow installing from the market"

- `market_only` is set in **System Admin > Plugin market > Policy** for the company or per department; a user is under it when any of their effective groups or the global row turns it on.
- When on, the per-instance patch sets the plugin manager's `registry` to the mirror and `fallbackRegistries` to `[]`, and the npmrc sets `registry=` to the mirror. Because that npmrc is global to the instance, the user's own project installs then resolve against the mirror too. Registry specs then resolve only against approved artifacts; anything else fails with not-found in the existing dialog.
- Whether a user's Settings change overrides these rows depends on the patch order the CLI applies, which phase 0 verifies (see [Serving instances](#serving-instances)).
- This is policy, not a boundary. Git and tarball URLs still leave through public `443`, and a user controls their own instance and npmrc. The optional `egress_lock` makes it a boundary:
  - native: `network.ts` omits the public `80` and `443` accept for that account;
  - container: `dsh-public.nft` gains `set egress_locked { type uid; }` and `meta skuid @egress_locked tcp dport { 80, 443 } drop` before the public accept, maintained by the provisioner;
  - model calls are unaffected because they go through the quota loopback listener; browsing, git, pip, and public npm stop working.
- `egress_lock` is open question 1 and needs a user decision.

### Install scripts

- Default `install_scripts = deny`. A version whose closure has any install script, including `prepare` and `binding.gyp`, is approvable only when the administrator allows each such package in the approve request after reauth; otherwise approval gets 409 `install-scripts`.
- A version with an allowed install script is served in fallback mode unless phase 0 shows that pnpm 11 applies `allowBuilds` to bundled packages (see [Mirroring a version](#store-and-mirror)).
- Sync and reconcile rely on pnpm 11's default of running no dependency build that is not allowed, and pass each allowed package as `--allow-build=<pkg>`. They never set `ignore-scripts`. In an interactive install the plugin manager's own build approval still asks the user, but every script-bearing package in an approved closure was already allowed.
- The profile's `pnpm-workspace.yaml`, including `allowBuilds`, is writable by the account, so a user can allow more builds in their own profile. That stays within the account's own rights.

<a id="default-installs"></a>
## Default installs, sync, and reconcile

### Defaults

- An administrator marks a listed package as a default for the company or for departments. A user's default set is every default visible to them.
- `plugin_default_state` records per user and package:
  - `installed`: put there by sync or reconcile; kept at the listed version.
  - `pending`: a newer listed version waits to be applied.
  - `failed`: the last apply failed and was rolled back; retried with backoff.
  - `opted-out`: installed by the market and later removed by the user; never added again unless an administrator resets the default (`reset_at`) or the user re-enables it in My plugins.
  - `user-managed`: the user installed another version by hand; left alone.

### Live push: the sync plugin

- `public-harness-plugin-sync`, a new small plugin in `integrations/public-harness/packages/plugin-sync`, is inserted into every company instance by the per-instance patch.
- It polls `GET /sync` at start and every 5 minutes, with jitter. The answer is a list of `{ name, version, fromVersion, sha512, action }` with actions `install`, `update`, or `downgrade`, plus the allowed builds. The plan is a request, not an order; the local checks below decide.
- **Local op log.** The plugin keeps `~/.dsh-market/sync-log.jsonl` in the account's home. Each operation writes an `intent` record with a snapshot of `package.json` and `pnpm-lock.yaml` under `~/.dsh-market/snapshots/<op>/` before it starts, and a `done`, `removed`, `failed`, or `recovered` record after it ends. The log is the only source for deciding what the user removed. `plugin-manager/changed` is not used for that: CLI changes and hand edits applied by the HMR watcher emit no event, and the event names no package. Sync uses the event only to check again sooner.
- **User removal rule.** A package counts as removed by the user when the log has a `done` install of it by sync, the package is now absent from `package.json`, and the log has no sync `removed` record after that install. Sync then writes a `user-removed` record. The rule covers removals through Discover, `dsh plugin remove`, and hand edits alike, and reconcile applies the same rule.
- **Preconditions, checked against a fresh read.** Immediately before each operation the plugin takes the profile lock, the same `package.json.lock` `withFileLock` that the plugin manager uses. Under the lock it re-reads `package.json` and the lockfile, checks the conditions, writes the `intent` record, and releases the lock:
  - `update` and `downgrade` run only if the package is still installed at exactly `fromVersion`.
  - `install` runs only if the package is absent and is not `user-removed` since the last reset or re-enable.
  - Any removal by sync requires the package to exist. `removeBundle` itself refuses with `not-removable` otherwise, and sync then abandons the entry.
  - Otherwise the entry is skipped and reported as `skipped` with the reason.
- **Apply: install disabled, check, then enable.** Only while the instance is idle:
  1. `update` and `downgrade` first call `removeBundle(name)`; `not-removable` means the user removed it, and sync stops. With HMR the plugin manager refuses to install over an installed package (`already-installed`), so `install` stops on that answer too.
  2. `installBundle(name@version, { registry, enabled: false, approvedBuilds })` installs the bundle without selecting it, so none of its plugins start.
  3. Sync takes the lock again and re-reads: the package is present at `version`, the lockfile integrity equals `sha512`, and no user removal has been recorded since the `intent`.
  4. If every check passes, `setBundleEnabled(name, true)` starts it; that call itself fails if the package disappeared in between. If a check fails, sync calls `removeBundle(name)` on the never-enabled bundle. After an integrity failure in an update it reinstalls `fromVersion`; after a user removal it leaves the package absent.
- **Why this is enough for phase 1.** The plugin manager's lock is not re-entrant and `change()` is private, so sync cannot hold the lock across `installBundle`. Under HMR, an `installBundle` without `enabled: false` selects the bundle and reloads inside its own lock, so the plugin would be active, and could register tools for an agent turn, before sync could check anything. With the disabled install, at most the install scripts an administrator allowed for that version can have run during the window, as the account; the plugin itself starts only after the checks pass. Phase 1 accepts this after-the-fact check as a listed risk, without changing upstream or holding a lock for the whole operation.
- **Without HMR.** Changes take effect at the next start anyway, so the check runs before any plugin code does. But `removeBundle` refuses (`stop-profile`) to remove a bundle that already started in this process, so a failed check is left to the next reconcile, which restores the snapshot before the instance starts.
- **Optional upstream proposal.** A precondition option on `installBundle` would close the window inside the lock. It stays an optional proposal in phase 0 item 7; the design does not depend on it.
- **Recovery.** If `removeBundle` succeeded and `installBundle` failed, sync reinstalls `fromVersion` from the mirror at once. If that fails too, it restores both files from the snapshot. It then leaves the `intent` record open as `failed`, and the next reconcile completes the restore before the instance starts.
- **Reports.** `POST /sync/report` sends results, the installed bundle list, and the op-log entries since the last report. The server derives `opted-out` only from `user-removed` records. A package absent because a sync operation failed or is open stays `failed`. It also derives `user-managed` and the installed count used for `max_installed`.
- The sync plugin runs inside the tenant's own instance, so its reports are trusted only for that user's own state and soft limits, never for security decisions.
- Administrators see per package how many users are applied, pending, skipped, or failed.

### Fallback: pre-start reconcile

When the instance was stopped at approval time, or sync could not apply an update in time, the provisioner reconciles before the next start.

- **Order (native)**: start the slice, `network.install`, run the reconcile unit, start the instance unit. The account's firewall rules are already in place.
- **Unit (native)**: modeled on `initializeWorkspace`:
  - `systemd-run --wait --collect --pipe --slice=<instance slice> --uid --gid`;
  - `AppArmorProfile=<account>`, `NoNewPrivileges=yes`, empty `CapabilityBoundingSet`, `ProtectSystem=strict`, `ProtectHome=yes`;
  - `ReadWritePaths` of the profile directory, cache, and tmp only;
  - `InaccessiblePaths` of the state and socket trees;
  - `IPAddressDeny=any` with `IPAddressAllow=localhost`, so it can reach only loopback, where the firewall admits only its own market port;
  - the instance's `MemoryMax` and `TasksMax`, and `RuntimeMaxSec=300`.
- **Unit (container)**: a one-shot `runsc` container with the instance's image, volumes, user namespace, and `--network` argument, checked by an `assertSafeReconcileArgv` that mirrors `assertSafeRunArgv`, after the `market_owner` element is added.
- **Environment allowlist**: exactly `HOME`, `DSH_HOME`, `XDG_CACHE_HOME`, `TMPDIR` as in the instance unit, `PATH` of the toolchain, and `NPM_CONFIG_GLOBALCONFIG`. Nothing is inherited from root: no `npm_config_*`, no proxy variables, no model key. `DSH_MODEL_API_KEY` is absent, as it is from instance units today.
- **Input**: the provisioner gets the plan from `dsh-plugins` `reconcile-plan(userId)` over the control socket, the only source of the plan. Each entry must be `name@exact-semver` with a sha512, and the registry must be the user's own port in `ports.market` on `127.0.0.1` or `hostAddress`; anything else aborts reconcile. The reconcile entry applies the same preconditions, user removal rule, and op log as sync, and first completes any open `failed` sync record from its snapshot.
- **pnpm**: the reconcile entry, shipped in the release, runs the profile's pnpm as `dsh plugin` does, with `--ignore-pnpmfile`, `--config.registry=<mirror>`, `--config.userconfig=/dev/null`, and one `--allow-build=<pkg>` per allowed build. It relies on pnpm 11's default of running no dependency build that is not allowed and never sets `ignore-scripts`, which would also block the allowed builds. An update or downgrade is a single `pnpm add name@version`, since no live plugin manager holds the package.
- **Tenant files**: the root provisioner opens no tenant path. The reconcile entry, running as the account, reads `package.json` and `pnpm-lock.yaml` with `O_NOFOLLOW`, accepts only regular files of at most 4 MiB, and writes the snapshot into the account's own `~/.dsh-market/snapshots/<id>/`. Only the hashes go to `plugin_profile_snapshot`. Tenant-controlled config (project `.npmrc`, `pnpm-workspace.yaml`, including its `allowBuilds`) can at worst change that account's own profile, because the process has only that account's rights and only loopback network.
- **Failure**: 120 s per package and 300 s in total. On any failure or timeout the entry restores both files from the snapshot and runs `pnpm install --frozen-lockfile --offline`, as `operations.ts` repairs a failed install. If the offline install fails because the store lacks a package, it runs the same install online against the user's mirror only. If that fails too, it leaves the restored files and the partial install in place, records `plugin-reconcile` with outcome `error`, and marks the state `failed`. The instance starts anyway.

<a id="updates-and-rollback"></a>
## Updates and rollback

- **Manual updates.** A plugin a user installed is updated by the user: Discover shows `update-available`, and the user removes and installs the new version.
- **Default updates.** A newly approved default version is pushed by sync within minutes when the instance is idle, otherwise applied by reconcile at the next start. My plugins shows "update waiting, restart to apply" while a default is `pending`.
- **Re-approval.** Every version is a new `plugin_version` row; nothing is approved by inheritance.
- **Market rollback.** An administrator rollback moves the listing back one version; sync and reconcile then downgrade users whose state is `installed`. Users who installed by hand see the listed version change.
- **Revoked versions.** Users who installed a revoked version by hand see it flagged in My plugins with a prompt to remove or change it; sync flags it in its report.
- **Profile rollback.** Each reconcile and each sync apply keeps a snapshot in the user's home; the last five are kept. A restore, requested by the user or by an administrator for that user, is queued and runs in the reconcile unit at the next start, never in a running instance. The snapshot id must belong to that user, and the files' hashes must match the recorded ones.

<a id="api-list"></a>
## API list

Admin routes sit under `/api/admin` and personal routes under `/account/api/me`, both served by identity and forwarded to `dsh-plugins` with actor headers, exactly as `kb-gateway.ts` does for the KB service.

| Method and path | Who | Reauth | Purpose |
|---|---|---|---|
| `GET /plugins` | admin | no | Packages, listing state, scopes, defaults, apply counts |
| `GET /plugins/requests` | admin | no | Review queue with mirror state |
| `GET /plugins/requests/detail` | admin | no | Manifest, file list, closure, install-script flags, diff |
| `GET /plugins/requests/file` | admin | no | One file of the artifact, audited as content read |
| `POST /plugins/requests/approve` | admin | yes | Approve with scope, allowed builds, and `expected_artifact_sha512` |
| `POST /plugins/requests/reject` | admin | no | Reject with reason |
| `POST /plugins/upload` | admin | yes | Direct listing from npm, git, or tarball |
| `POST /plugins/scope` | admin | yes | Replace a listing's scope |
| `POST /plugins/rollback` | admin | yes | Move a listing back one version |
| `POST /plugins/delist` | admin | yes | Delist a package |
| `POST /plugins/relist` | admin | yes | Relist a package |
| `POST /plugins/revoke` | admin | yes | Revoke one version |
| `POST /plugins/defaults` | admin | yes | Set or clear defaults for company or departments |
| `POST /plugins/defaults/reset` | admin | yes | Clear opt-outs for one default |
| `GET /plugins/policy` | admin | no | Read policies |
| `PUT /plugins/policy` | admin | yes | Change `market_only`, `install_scripts`, `egress_lock` |
| `GET /plugins/limits` | admin | no | Limit rows |
| `GET /plugins/limits/effective` | admin | no | One user's effective limits |
| `PUT /plugins/limits` | admin | yes | Set a limit row |
| `DELETE /plugins/limits` | admin | yes | Remove a limit row |
| `POST /plugins/restore` | admin | yes | Queue a user's snapshot restore |
| `GET /plugins` (me) | user | no | My submissions, my defaults and their state, revoked flags |
| `POST /plugins/submit` (me) | user | no | Submit a version |
| `POST /plugins/withdraw` (me) | user | no | Withdraw a pending version |
| `POST /plugins/delist-request` (me) | user | no | Ask an administrator to delist my package |
| `POST /plugins/defaults/reenable` (me) | user | no | Re-enable a default I removed |
| `GET /plugins/snapshots` (me) | user | no | My profile snapshots |
| `POST /plugins/restore` (me) | user | no | Queue a restore of my snapshot |

Control socket verbs for the provisioner: `open`, `close`, `instance-config` (patch rows, policies, npmrc content), `reconcile-plan`, and `firewall-state` (`up` or `down`, from the probe). Errors use the KB convention: 400 invalid input, 403 not allowed (`not-owner`, `self-approval`), 404 not found, 409 state conflict (`pending-exists`, `not-pending`, `not-approved`, `mirror-not-ready`, `artifact-mismatch`, `install-scripts`, `closure-source`, `limit-reached`, `version-exists`, `name-taken`, `no-previous`), 413 too large.

<a id="permissions-and-audit"></a>
## Permissions and audit

- Only the `admin` role reaches admin routes. Identity enforces `PLUGIN_ADMIN_ENDPOINTS`, the reauth set `PLUGIN_REAUTH`, and an event allowlist `PLUGIN_EVENTS` in a new `plugins-gateway.ts`, modelled on `KB_ADMIN_ENDPOINTS`, `KB_REAUTH`, and `KB_EVENTS`. Events outside `PLUGIN_EVENTS` would be dropped by the drain, so every event below is listed there.
- Personal routes act only on the caller's own submissions, defaults, and snapshots.
- `dsh-plugins` writes events to `plugin_audit_outbox`, drained like `kb_audit_outbox`. `detail` never contains artifact contents or tokens.
- An approve request with allowed builds writes `admin-plugin-approve` and, when the list is not empty, also `admin-plugin-build-allow`, so build permissions can be filtered on their own.

| Event | Actor | Detail |
|---|---|---|
| `plugin-submit` | user | package, version, source type |
| `plugin-withdraw` | user | package, version |
| `plugin-expire` | system | package, version |
| `plugin-mirror-failed` | system | package, version, reason |
| `plugin-delist-request` | user | package |
| `plugin-default-reenable` | user | package |
| `plugin-restore` | user | snapshot id |
| `plugin-sync` | system | user, applied, failed |
| `plugin-reconcile` | system | user, added, removed, opted-out, outcome |
| `plugin-store-corrupt` | system | blob digest |
| `admin-plugin-approve` | admin | package, version, scope, artifact digest |
| `admin-plugin-reject` | admin | package, version, reason |
| `admin-plugin-upload` | admin | package, version, source type, scope |
| `admin-plugin-scope-change` | admin | package, old scope, new scope |
| `admin-plugin-rollback` | admin | package, from version, to version |
| `admin-plugin-delist` | admin | package, reason |
| `admin-plugin-relist` | admin | package |
| `admin-plugin-revoke` | admin | package, version, reason |
| `admin-plugin-default-set` | admin | package, scope |
| `admin-plugin-default-clear` | admin | package, scope |
| `admin-plugin-default-reset` | admin | package, scope |
| `admin-plugin-build-allow` | admin | package, version, allowed packages |
| `admin-plugin-policy-change` | admin | policy, scope, old value, new value |
| `admin-plugin-limit-change` | admin | scope, name, old value, new value |
| `admin-plugin-limit-delete` | admin | scope, name |
| `admin-plugin-restore` | admin | user, snapshot id |
| `admin-plugin-content-read` | admin | package, version, file |

<a id="plugin-limits"></a>
## Plugin limits

- `dsh_plugin_limit` holds `max_installed` (market packages in a user's profile), `max_submissions` (a user's pending and listed packages), and `max_submission_bytes` (store bytes a user's submissions added).
- Resolution reuses `effectiveLimits` after it is generalized over limit names: a user row wins; otherwise the most permissive value among the user's effective groups, which include ancestor departments as in the KB; otherwise the global row; `NULL` means unlimited.
- Lowering a limit never deletes, delists, or uninstalls anything. Only growth is refused with 409 `limit-reached`.
  - A submission past `max_submissions` or `max_submission_bytes` is refused.
  - `max_installed` is enforced where it can be counted: the packument route refuses a listed package the user does not yet have once the last sync or reconcile report reached the limit, and the index marks such entries. This is best effort, because tarball and git installs and stale reports escape it.
- Default installs count toward `max_installed`; sync and reconcile install them even past the limit, because an administrator chose them, and record it.
- A single version's artifact is capped at 200 MiB, below the default per-user total of 1 GiB.
- Instance disk use stays under the existing XFS quota.

<a id="system-admin-ui"></a>
## System Admin UI

- **Sidebar.** System Admin gains a **Plugin market** item in its submenu in the single sidebar, next to the knowledge base items. No new sidebar.
- **Pages.** Review queue, Listed plugins (scope, current and previous version, rollback, delist, relist, apply counts), Upload, Defaults (with reset), Policy (`market_only`, install scripts, `egress_lock`), Limits (the `admin-kb-limits.tsx` page reused), and Audit filtered to the plugin events.
- **Personal.** Personal gains **My plugins**: submissions and their mirror and review state, withdraw, delist request, my defaults with their state and "re-enable", revoked flags, the "restart to apply" notice, and profile snapshots.
- **Upstream pages untouched.** The upstream Plugins page and Discover tab are used as they are; the company index appears there as an index source. Company-specific facts live only in My plugins, so upstream syncs do not conflict.
- **Style.** New pages only compose existing components from `admin-kit.tsx` and the upstream client: the same buttons, icons, and component shapes, recolored with the existing palette and the frosted-glass layer in `theme.ts`, in a restrained enterprise style. No new colors, icon sets, or shapes.

<a id="deployment-changes"></a>
## Deployment changes

### Shared code

- `integrations/public-harness/packages/plugins/`: the service, the store, the mirror pipeline, the fetch service entry, `dsh-plugins-egress`, the index builder, and the reconcile entry.
- `integrations/public-harness/packages/plugin-sync/`: the in-instance sync plugin.
- `packages/production/src/plugins-service.ts`, `plugins-fetch.ts`, and `plugins-egress.ts`: entry points, beside `kb-service.ts` and `quota-service.ts`.
- `packages/contracts/src/web-rows.ts`: `pluginMarketRows`.
- `packages/identity/src/plugins-gateway.ts`: routes, reauth, `PLUGIN_EVENTS`, outbox drain.
- `packages/kb/src/limits.ts`: `effectiveLimits` generalized over limit names.

### Native deployment (`integrations/public-harness/deploy/native/`)

- `systemd/dsh-plugins.socket`, generated by the installer from `ports.market`: one `ListenStream=127.0.0.1:<port>` per port, `Service=dsh-plugins.service`, `ExecStartPost=-<loader>` for the `dsh_market` table, ordered before the provisioner and every instance unit.
- `systemd/dsh-plugins.service`: user `dsh-plugins`, `Sockets=dsh-plugins.socket`, `LimitNOFILE=16384` for the up to 4,096 inherited listeners, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `IPAddressDeny=any`, `IPAddressAllow=localhost`, `ReadWritePaths=/var/lib/dsh-plugins /run/dsh-plugins`, the hardening set of `dsh-quota.service`, `CapabilityBoundingSet=`. It differs from `dsh-kb.service`, which has `PrivateNetwork=yes` and only `AF_UNIX`, because it accepts loopback connections.
- `systemd/dsh-plugins-fetch.socket` and `systemd/dsh-plugins-fetch@.service`, as described in [Fetch service](#store-and-mirror).
- `systemd/dsh-plugins-egress.service`: user `dsh-plugins-egress`, outbound network allowed, no state, `ProtectSystem=strict`, empty capabilities.
- `systemd/sysusers.conf`: users `dsh-plugins`, `dsh-plugins-fetch`, `dsh-plugins-egress`, and group `dsh-plugins-clients`. The `dsh-plugins` group, which owns `/var/lib/dsh-plugins` (0750) and the fetch socket, has `dsh-plugins` as its only member; `dsh-plugins-fetch` and `dsh-identity` are not in it. `dsh-plugins-clients` has `dsh-identity` as its only member; the provisioner runs as root. `systemd/tmpfiles.conf`: `/var/lib/dsh-plugins`, `/run/dsh-plugins`, `/run/dsh-public/instance-market` (root 0711).
- `config/plugins.json.example`: database and store paths, `ports.market`, `egressPort`, `egress.allow`, `egress.intranet`, company scopes, size caps, request TTL. `config/native.json.example` gains `paths.instanceMarketDir`; `config/provisioner.json.example` gains `ports.market`.
- `runtime-systemd`:
  - `units.ts` adds the second `--patch` and `NPM_CONFIG_GLOBALCONFIG`;
  - a new `market-firewall.ts` renders the `dsh_market` table (input chain at priority `filter - 2`, the `market_listener` subchain, and the `market_owner` set) for the socket unit's loader; it is outside `network.install`;
  - `network.ts` adds `ct mark <uid> iif "lo" tcp dport $MARKET_PORTS accept` to `in_<uid>` before its final drop, and under `egress_lock` drops the public accept;
  - `probe.ts` checks the `dsh_market` table, both chains, and every endpoint's set element, and the provisioner reports `firewall-state` to `dsh-plugins`;
  - `runtime.ts` adds the reconcile step between `network.install` and the unit start, writes the per-instance files, and adds and deletes the set element.
- Firewall rules let only the `dsh-plugins-fetch` UID reach `egressPort`, and let that UID reach nothing else.

### Production container deployment (`integrations/public-harness/deploy/production/`)

- `systemd/`: `dsh-plugins.socket`, `dsh-plugins.service`, `dsh-plugins-fetch.socket`, `dsh-plugins-fetch@.service`, and `dsh-plugins-egress.service` with the same sandbox as above; `sysusers.conf` and `tmpfiles.conf` gain the same accounts and directories.
- `config/plugins.example.json`; `config/provisioner.example.json` gains `ports.market` and `paths.marketDir`.
- `nftables/dsh-public.nft`: `define MARKET_PORTS`, `oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept` before `oif "lo" drop`, the `egress_locked` set with its rule, and the rules that keep `dsh-plugins-fetch` to `egressPort` only.
- `nftables/dsh-market.nft`: the `dsh_market` table with the `market_listener` input subchain, the `market_owner` set, and the owner drop in an output chain at priority `filter - 2`, loaded by the socket unit's `ExecStartPost=-` and never by the `dsh-public.nft` load.
- `provisioner/src/runtime.ts`: `webPatch` adds `pluginMarketRows` with `hostAddress`; `assertSafeRunArgv` admits the read-only market volume; the provisioner adds and removes set elements and runs the one-shot reconcile container. `provisioner/src/config.ts` validates `ports.market`.
- `README.md` records the changed decision: per-user firewall elements exist for the market range.

### Startup behaviour

- A failing market never blocks an instance start: without `dsh-plugins` the instance starts without the market rows and the failure is logged. The socket unit still holds the range.
- The feature is off until `plugins.json` exists.

<a id="public-market-later"></a>
## Adding a public market later

- Administrators subscribe to external index URLs; the fetch service reads them through `dsh-plugins-egress`, never in instances.
- Public entries are candidates: an administrator imports a version, which runs the same mirror and review with `origin = 'public'`, under its own public name with the `name@version` invariant.
- The personalized index stays one document; a second index URL per instance listing approved public packages separately is an option.
- Signatures (phase 2) apply to both: npm provenance or Sigstore for upstream packages, and a company signature over each personalized index and artifact.

<a id="risks-and-unverified-items"></a>
## Risks and unverified items

### Risks

- **Unsigned index until phase 2.** Trust rests on the channel: loopback, the systemd-held listeners, the receiving-socket and port-owner firewall rules in both runtimes, and the npm token. A compromised host defeats all of it.
- **`market_only` is soft** without `egress_lock`, and its strength also depends on the patch order phase 0 verifies. Its global npmrc also sends the user's own project installs to the mirror.
- **Fallback mode is weaker.** If a version is served in fallback mode, transitive dependencies are limited to reviewed tarballs but not pinned, and Discover and manual installs get no lockfile check.
- **Closure drift.** A closure is frozen at review; a dependency's later security fix needs a new version and review.
- **Repacked artifacts.** A company artifact for a public npm name has a different integrity from the public tarball. Under `market_only` the npmrc points `registry=` at the mirror, so repairs resolve there. Without it, a later reinstall of that unscoped name from the public registry fails the lockfile integrity check. It fails safely, and sync or reconcile reinstalls from the mirror; a user's own manual repair needs `--registry=<mirror>`, which My plugins shows.
- **Sync race window.** Sync cannot hold the plugin manager's lock across `installBundle`, so phase 1 relies on after-the-fact checks: the bundle is installed disabled and enabled only after a second check. During the window at most the administrator-allowed install scripts of that version can have run. Without HMR a started bundle cannot be removed and waits for reconcile.
- **Account cap.** One `ListenStream` per market port and one port per account, so at most 4,096 accounts can use the market (open question 9). `dsh-plugins` runs with `LimitNOFILE=16384`; phase 0 checks start time.
- **Allowlist upkeep.** A registry that moves its tarballs to a new CDN host fails fetches until `egress.allow` is updated.
- **In-instance sync is tenant-controlled.** A user can disable or alter it; this only affects their own defaults and soft limits.
- **Separately loaded market table.** If `dsh_market` fails to load, the range-wide accepts alone would admit any instance account to any market port; the probe and the `firewall-state` gate keep `dsh-plugins` closed until the table is back.
- **Changed firewall decision.** The container firewall gains per-user elements, which the provisioner must keep in step; stale elements are removed at stop and at provisioner start.

### Unverified items

- **Per-instance patch and inserts.** That a second native `--patch` file with `insert` rows mounts `plugin-market`, `ui-plugin-market`, and `public-harness-plugin-sync` correctly next to the profile's own bundle settings, and which value wins when a user edits `indexes` or the registry in Settings.
- **pnpm 11 behaviour.** That standard tarball paths with a scope-mapped registry keep tarball URLs out of `pnpm-lock.yaml` across port changes; that `NPM_CONFIG_GLOBALCONFIG` supplies the auth token; whether peer auto-install asks the mirror for `@deepseek-ai/dsh*`; how a repair resolves a repacked public name with and without `registry=` in the npmrc.
- **Pinned artifacts.** That pnpm 11 installs an artifact with `bundleDependencies` correctly, and whether `allowBuilds` governs scripts of bundled packages. Until shown, versions with install scripts use fallback mode.
- **Build defaults.** That pnpm 11 runs no dependency build outside `--allow-build` and `allowBuilds` in both sync and reconcile.
- **Listener cgroup.** Whether the listening sockets sit in `system.slice/dsh-plugins.socket` (likely, with BPF firewall support) or in `init.scope`, that accepted connections inherit it, and whether the `dsh_market` rules must be reloaded after a socket unit restart.
- **Disabled installs.** That `installBundle` with `enabled: false` under HMR starts none of the bundle's plugins, and `setBundleEnabled` then starts them.
- **Idle detection.** Which existing signal tells the sync plugin that no agent turn is running.
- **Install preconditions.** Whether upstream would accept an optional precondition option on `installBundle`; the design does not need it.
- **Container reconcile.** The one-shot `runsc` container with the instance's volumes and network.
- **Git tarballs.** That a tarball built from git blobs installs like `npm pack` output, including `files` and `.npmignore` selection.
- **Client-side integrity for Discover.** Not available until upstream defines an integrity member.

<a id="test-plan"></a>
## Test plan

No test uses real model keys or model calls. All listeners bind `127.0.0.1` or Unix sockets.

- **Unit.**
  - Transition table: every row and every refusal code, including resubmission after reject, withdraw, and expiry, release of an unclaimed name, and both partial unique indexes.
  - Approval binding: an approve request whose `expected_artifact_sha512` differs from the stored digest gets 409 `artifact-mismatch`; a `ready` version is never mirrored again.
  - Listing pointers: greater, equal, and lower approvals; rollback; revoke of current with and without a previous version; delist and scope change serving rules.
  - Visibility: company, department, ancestor department, several departments, a disabled user.
  - Limits: user row wins, most permissive department, global fallback, lowering keeps data, growth gets 409.
  - Index builder: format-1 validity through `parseMarketIndex`, `publishTimestamp` in seconds, inlined icons, stable digest.
  - Packument routes: all three scoped-name encodings, standard tarball paths, only visible versions.
  - Tokens: constant-time comparison; wrong token and unseen listing give identical responses.
  - Ports: one port per user and one user per port; a port is reassigned only after its row is deleted; rows of deleted accounts are removed at provisioner start.
  - Upload unpacking: absolute paths, `..`, symbolic and hard links, devices, entry and size caps.
  - Install-script detection: each of `preinstall`, `install`, `postinstall`, `prepare`, `gypfile`, and `binding.gyp`; a closure with a script is never built in bundle mode unless the phase-0 flag allows it.
  - Fetch service framing: unknown verbs, extra arguments, and arguments outside each allowlist are refused before any network use.
  - Sync preconditions: `update` skipped when the package is gone or at another version; `install` skipped after a user removal; a package sync installed, now absent with no sync `removed` record, counts as user-removed; `opted-out` comes only from such records.
- **Integration.**
  - Identity gateway: whitelist, reauth on the listed routes, `PLUGIN_EVENTS` drained, self-approval refused.
  - Egress and SSRF: a closure with git, tarball URL, `file:`, `link:`, or alias dependencies is refused before pnpm runs; a `dist.tarball` on another host is refused; a redirect to an unlisted host fails; an allowlisted name with any A or AAAA record in a forbidden range is refused, including `::ffff:127.0.0.1`, `64:ff9b::` and `2002::` forms; an IP-literal target is refused; a name that re-resolves to another address between check and connect still reaches the checked address; only the fetch UID can reach the proxy.
  - Conflicts: a second artifact for an existing `name@version`; a company-scope name that exists upstream.
  - Store tampering: a modified blob is quarantined and answers 503.
  - `pluginMarket` reading the personalized index from the listener, including `maxBytes` and no redirects.
- **End to end** (native stack, extending the kb-stack e2e harness, and the container stack where the runtime is in scope):
  - Owner reach: in both runtimes the owner account connects to its own market port and gets its index and packuments; this is the positive case for the accept rules.
  - Cross-tenant: another account cannot connect to a user's port in either runtime; a wrong token gets 404.
  - Firewall gate: with `dsh_market` removed, instances still start, `dsh-plugins` closes every market connection, and serving resumes after the table is reloaded.
  - Port hijack: with `dsh-plugins` stopped, another account cannot bind a market port; with the socket unit also stopped, an account that binds user B's port receives nothing from B. The test runs with every instance list order.
  - Host accounts: root, `dsh-router`, `dsh-identity`, and an unmapped port are refused by the port-owner rule.
  - A department user sees a department listing; others do not, and its artifacts answer 404 to them.
  - Discover installs a market plugin with public egress closed in the test network; the lockfile holds no tarball URL and still installs after an instance restart, a port change, and a `dsh-plugins` restart.
  - Default push: approve a new default version while the instance runs; sync applies it when idle; integrity mismatch rolls back.
  - Sync races: a user removes the package between the fresh read and the enable step, and the never-enabled bundle is deleted without any of its plugins starting; an integrity mismatch leaves the plugin never started; `removeBundle` succeeds and `installBundle` fails, and the old version is back, or the next reconcile restores it; without HMR a failed check is restored by reconcile.
  - Reconcile: runs in the instance slice after the firewall rules, with the exact environment allowlist, ignores a planted `.pnpmfile.cjs` and hostile `.npmrc`, times out and rolls back, falls back to the online mirror install when the offline repair lacks a package, and the instance still starts.
  - Snapshots: a symbolic link planted as `package.json` is refused; restore runs only at the next start and only for the owner's snapshot.
  - Opt-out: the user removes a default through Discover, through `dsh plugin remove`, or by editing `package.json` by hand; in each case neither sync nor reconcile reinstalls it until reset or re-enable.
  - Revoke: the full flow, including the My plugins flag for a hand-installed revoked version.
  - Build scripts: an allowed build runs in sync and reconcile; a non-allowed one does not run.
  - `market_only` makes a registry spec outside the market fail with not-found; `egress_lock` blocks public `443` but not model calls.
- **Firewall rendering.** `network.ts` and `dsh-public.nft` rule tests: the market chain runs before the per-instance dispatch and the container rules before the out-of-range accept; the market rules survive instance install and removal; `network.install` succeeds while `dsh-plugins` is stopped and never loads `dsh_market`; the owner accept sits before the final drop in `in_<uid>` and before `oif "lo" drop`; the loader keeps set elements across a reload; an unmapped port is dropped by the `!=` set lookup; the fetch UID reaches only `egressPort`; set element add and remove; the probe detects a missing market rule or set element. Config validators reject overlapping, out-of-range, or oversized `ports.market`.
- **Regression.** The upstream plugin-market and plugin-manager tests run unchanged.

<a id="phased-implementation-plan"></a>
## Phased implementation plan

Phase 1 is the first release (一期); phase 2 is the second (二期), as the user decided. Phase 0 runs first and can change details of phase 1.

### Phase 0: verification spikes

1. A second native `--patch` with `insert` rows for `plugin-market`, `ui-plugin-market`, and a stub sync plugin. Which layer wins when the user edits `indexes` or the registry in Settings, given that the CLI applies patches after the profile.
2. pnpm 11 against a minimal loopback registry: lockfile contents with standard paths and scope mapping across a port change; auth through `NPM_CONFIG_GLOBALCONFIG`; requests for provided peers; a repair of a repacked public name with and without `registry=` in the npmrc.
3. Install of a `bundleDependencies` artifact with pnpm 11, and whether `allowBuilds` governs bundled packages with scripts. That pnpm runs no build outside `--allow-build`.
4. The reconcile transient unit in the instance slice with `IPAddressAllow=localhost`; that `--ignore-pnpmfile` and `--config.userconfig` hold.
5. Container: `meta skuid . tcp dport` matching through pasta, and a one-shot reconcile container.
6. A tarball built from git blobs compared with `npm pack` output.
7. An idle signal for the sync plugin; that `installBundle(..., { enabled: false })` starts no plugin under HMR. Optionally, propose a precondition option on `installBundle` upstream.
8. `dsh-plugins.socket` with the full range: start time with `LimitNOFILE=16384`; which cgroup holds the listening sockets, testing both `init.scope` and `system.slice/dsh-plugins.socket`; that accepted connections inherit it; that the `dsh_market` loader works from `ExecStartPost` while `dsh-plugins` is stopped; and whether the rules need reloading after the socket unit restarts.

### Phase 1 (一期)

Milestone 1A, store and mirror:

1. `packages/plugins` with the schema, partial indexes, and migrations.
2. `dsh-plugins-egress`, the socket-activated fetch service with its verbs, and the SSRF checks.
3. Mirror for npm and uploads: closure resolution, install-script detection, bundle and fallback modes, the `name@version` invariant, the integrity scrub.
4. Admin direct upload with company scope, behind reauth, with audit.

Milestone 1B, serving:

1. `dsh-plugins.socket`, one-to-one ports, routes, tokens.
2. Native: second patch, npmrc, the separately loaded `dsh_market` table, the owner accept in `in_<uid>`, probe and `firewall-state` gate, config validation.
3. `pluginMarketRows` and the provisioner `open` and `close` calls.

Milestone 1C, review flow:

1. Submission, ownership, name release, self-approval refusal, withdraw, expiry, delist request.
2. Git sources through the egress proxy.
3. Review queue, detail, file view, approve with scope, allowed builds, and `expected_artifact_sha512`, reject.
4. Department scopes, scope change, delist, relist, revoke, and rollback per the pointer rules.
5. `plugins-gateway.ts` with `PLUGIN_EVENTS`; System Admin pages and My plugins.

Milestone 1D, defaults and updates:

1. Defaults, reset, and re-enable.
2. The sync plugin with preconditions, disabled install and enable, the user removal rule, op log, recovery, integrity check, and reports.
3. Pre-start reconcile with snapshots, rollback, online fallback, and queued restore.

Milestone 1E, policy, limits, and containers:

1. Generalized `effectiveLimits` and `dsh_plugin_limit`.
2. `market_only` per company or department; install-script policy.
3. Container runtime: `market_owner` set, receiving-socket rule, `webPatch` rows, market volume, one-shot reconcile. If open question 4 limits phase 1 to native, this item moves to phase 2.

### Phase 2 (二期)

1. Signature verification: npm provenance or Sigstore on fetch, and a signed personalized index and artifacts.
2. Pure-skill packages delivered as read-only host views.
3. `egress_lock`, if open question 1 chooses it.

### Later

1. Public market subscriptions.
2. Forced installs.
3. A four-eyes approval rule.

<a id="open-questions"></a>
## Open questions and recommended defaults

Questions 1 to 9 need a user decision; the rest have defaults that can be confirmed with the review.

1. **Strength of "only allow installing from the market".** Recommended default: policy only; `egress_lock` stays an explicit per-department choice, because it breaks browsing, git, pip, and public npm. Without it a user can change the registry back in their npmrc, and git and tarball installs keep working. Two effects to accept: under `market_only` the global npmrc sends every npm install in the instance to the mirror, including the user's own projects; and because the CLI applies patches after the profile, a user's own `indexes` and registry edits in Settings may be overwritten at each start (phase 0 confirms).
2. **When signature verification lands.** Recommended default: phase 2 (二期), as decided. The doc places it there; please confirm.
3. **What "pushed automatically" means for defaults.** Recommended default: live push by the sync plugin within about 5 minutes while the instance is idle; next start as fallback, with a "restart to apply" notice and an admin view of how many users are pending.
4. **Runtimes in phase 1.** Recommended default: both, with containers in milestone 1E. If the user prefers, phase 1 supports native only and containers move to phase 2.
5. **Can an administrator approve their own path-A submission?** Recommended default: no; they use path B, which is audited as an upload.
6. **Mandatory company scope for git and upload sources, and its name.** Recommended default: yes, with a dedicated scope such as `@corp-dsh/` that no in-house development package uses, and the name must not exist upstream.
7. **Overturning the production README decision.** The container firewall had no per-user rules; the market range now has per-user set elements and a receiving-socket rule, and root, `dsh-router`, `dsh-identity`, and other host accounts are kept off market ports. Recommended default: accept, for the market range only.
8. **Residual risks accepted for phase 1.** Recommended default: accept all three:
   - versions with install scripts, or every version if phase 0 rejects bundle mode, use fallback mode: transitive dependencies are limited to reviewed tarballs but not pinned, and Discover and manual installs get no lockfile check;
   - the default-push race window: with install-disabled-then-enable, at most the administrator-allowed install scripts can have run in it;
   - the index is unsigned until phase 2.
9. **Scale.** Each account holds one market port for as long as it exists; the cap is 4,096, so at most 4,096 accounts can use the market. Recommended default: 4,096; otherwise give the expected number of accounts.
10. **Install scripts.** Recommended default: refused unless an administrator allows each such package, `prepare` and `binding.gyp` included.
11. **Is an opt-out permanent?** Recommended default: yes, until an administrator resets the default or the user re-enables it in My plugins.
12. **Limit values.** Recommended default: global `max_installed` 50, `max_submissions` 20, `max_submission_bytes` 1 GiB; one version's artifact at most 200 MiB; one uploaded tarball at most 50 MiB.
13. **Git sources that need a build step.** Recommended default: unsupported; commit built output or publish to npm.
14. **Can a submitter delist their own plugin?** Recommended default: no; they can request a delist.
15. **Mirror retention.** Recommended default: keep every artifact a listing history refers to; revoked versions stop being served at once and are purged by an explicit administrator action after 90 days.
16. **Credentials for git sources.** Recommended default: user submissions are fetched without credentials; a read-only deploy token is used only for administrator uploads.
17. **Pure-skill packages.** Recommended default: yes, in phase 2.
18. **Single-user scope.** Recommended default: not offered; departments and the whole company only.

<a id="sources"></a>
## Sources

- [Plugin market index format](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)
- [Plugin market Discover](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md)
- [Plugin install registries](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md)
- [LLM Wiki knowledge base design](2026-10-17-llm-wiki-knowledge-base-design.md)
- [Public Harness native design](2026-10-11-public-harness-native-design.md)
