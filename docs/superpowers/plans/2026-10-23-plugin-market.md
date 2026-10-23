# Company Plugin Market Implementation Plan

English | [中文](2026-10-23-plugin-market.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the company plugin market from the [approved design](../specs/2026-10-22-plugin-market-design.md): a host store of reviewed plugins, per-user loopback listeners, two audited listing paths, default-install push with reconcile fallback, and both native and container runtimes in phase 1.

**Architecture:** Unprivileged `dsh-plugins` owns the SQLite catalogue and content-addressed store and serves personalized `index.json` plus a read-only npm registry on one stable loopback port per account. Socket-activated `dsh-plugins-fetch@` mirrors sources only through `dsh-plugins-egress`. The provisioner writes a second `--patch` and per-instance npmrc, loads the separate `dsh_market` nft table, and runs pre-start reconcile. In-instance `public-harness-plugin-sync` pushes defaults (install disabled, re-check, then enable). Upstream Discover, `pluginMarket`, and `plugin_manager` stay unchanged.

**Tech Stack:** TypeScript (Node 22 + pnpm 11), Cordis, SQLite, systemd socket activation, nftables, Vitest. Upstream packages used as-is: `packages/util/plugin-market-index`, `packages/boot/plugin-market`, `packages/client/ui-plugin-market`, `packages/experimental/plugin-market-bundle`, `apps/plugin-market-generator`, `packages/boot/plugin-manager`. Host service pattern follows `dsh-quota` / `dsh-kb` (`integrations/public-harness/packages/{quota,kb,production,runtime-systemd}`).

**Spec:** [Company plugin market design](../specs/2026-10-22-plugin-market-design.md) (questions 1–9 confirmed 2026-10-23).

**Branch / worktree:** `codex/plugin-market-impl` at `.worktrees/plugin-market-impl`. Do not push `master`, force-push, use `--no-verify`, or open a PR.

## Global Constraints

- Use only Node 22 (`/home/box/.local/node22/bin`) and pnpm 11 (`/home/box/.local/pnpm11/bin`). Never system Node 20. Set `NODE_OPTIONS=--max-old-space-size=3072`. Prefer focused package tests; do not build the 5GB production image.
- Do not read or print secrets (`/home/box/.config/gh/hosts.yml`, model keys, tokens). Tests use mocks. Model keys only via env `DSH_MODEL_API_KEY`, never logged or written to disk.
- Bind only `127.0.0.1` or Unix sockets. No public listeners in tests or spikes.
- Push only `codex/plugin-market-impl` (and `codex/plugin-market-design` if the design needs a follow-up). No force-push, no `--no-verify`, no PR, no history rewrite.
- UI reuses existing `admin-kit` / upstream client shapes; no new button icons, colors, or shapes.
- Known environment failures (do not treat as regressions): `http-proxy` `install.spec` (1), `matcher-parity.spec` (6), `gen-dependency-catalog.spec` (1), `test:docs` uv.lock commit-hash (1). Under load, re-run alone before blaming: `ptc-runtime-python`, `llm-deepseek`, `scripts/persistence-schema`.
- Before merging to master, code review must say「可以合并」.
- Paths under `integrations/public-harness/` are relative to that tree unless prefixed. Design and plan paths are relative to the repository root.
- Phase 0 is exploration, not product code. Record every result in `docs/superpowers/plans/phase0-results.md` (and `.zh.md`). If an item needs systemd / nft / pasta / root and this box cannot provide it, mark **blocked** with the minimum substitute check; do not pretend pass. If item 8 or 9 falsifies a design assumption, stop and report—do not silently change the design.

## Review Focus

- Phase 0: which layer wins for `indexes` / registry; pnpm lockfile and `bundleDependencies` behaviour; listener cgroup; `inet_diag` from an unprivileged service.
- 1A: SSRF and allowlist on egress; `name@version` invariant; approve binds `expected_artifact_sha512`; no rewrite of ready artifacts.
- 1B onward: port ownership + peer check; sync install-disabled-then-enable; opted-out from sync-log only.

---

## Phase 0: verification spikes

Results file: `docs/superpowers/plans/phase0-results.md` (+ `.zh.md`). Each item below is a checkbox task.

### Task P0.1: Second `--patch` and Settings overrides

**Purpose:** Confirm a second native `--patch` with `insert` rows mounts `plugin-market`, `ui-plugin-market`, and a stub sync plugin, and which layer wins when the user edits `indexes` or the registry in Settings (CLI applies patches after the profile: `apps/cli/src/args.ts`).

**Steps:**
- [ ] Read `apps/cli/src/args.ts` patch order and Cordis patch merge behaviour; note which source wins for `plugin-market.indexes` and plugin-manager `registry`.
- [ ] Write a minimal fixture patch YAML with `insert` for `plugin-market` / `ui-plugin-market` / stub sync; apply via `dsh` or the CLI args helper in a temp profile under `/tmp/dsh-p0-1/`.
- [ ] Edit the profile's own `cordis.patch.yml` (or Settings-equivalent) to a different `indexes` value; re-apply the market patch; record which value is active.

**Pass:** Documented winner for `indexes` and `registry`; insert rows load without error. **Blocked if:** CLI cannot run without a full profile bootstrap—then static analysis of `args.ts` + a unit that replays the merge is the substitute.

**Record:** `phase0-results.md` §P0.1.

### Task P0.2: pnpm 11 against a loopback registry

**Purpose:** Lockfile keeps standard tarball paths across port changes; `NPM_CONFIG_GLOBALCONFIG` supplies auth; peer auto-install behaviour for `@deepseek-ai/dsh*`; repair of a repacked public name with and without `registry=` in the npmrc.

**Steps:**
- [ ] Start a tiny loopback npm registry (verdaccio or a static fixture server on `127.0.0.1`) serving one scoped and one public package with integrity.
- [ ] `pnpm install` with scope mapping and `NPM_CONFIG_GLOBALCONFIG` pointing at a token-bearing npmrc; inspect `pnpm-lock.yaml` for tarball URLs.
- [ ] Change the registry port, reinstall; confirm lockfile still installs.
- [ ] Publish a repacked public name to the mirror; repair with and without `registry=` in the global npmrc.

**Pass:** No tarball URL in lockfile (or documented exception); auth works via globalconfig; repair behaviour recorded for both npmrc shapes. **Blocked if:** verdaccio install is too heavy—use a static fixture registry under `docs/superpowers/plans/fixtures/p0-registry/`.

**Record:** `phase0-results.md` §P0.2.

### Task P0.3: `bundleDependencies` and `--allow-build`

**Purpose:** pnpm 11 installs a `bundleDependencies` artifact; whether `allowBuilds` / `--allow-build` governs bundled packages with scripts; that builds outside allow-list do not run.

**Steps:**
- [ ] Build two fixture tarballs under `/tmp/dsh-p0-3/`: one with `bundleDependencies` and no scripts; one with a bundled dep that has `postinstall` writing a marker file.
- [ ] Install with and without `--allow-build=<bundled>`; observe marker and exit code.
- [ ] Confirm default (no allow) runs no dependency build.

**Pass:** Clear yes/no on whether bundle mode can host scripted deps; default denies builds. Feeds design fallback-mode decision.

**Record:** `phase0-results.md` §P0.3.

### Task P0.4: Reconcile transient unit flags

**Purpose:** Transient unit in the instance slice with `IPAddressAllow=localhost`; `--ignore-pnpmfile` and `--config.userconfig=/dev/null` hold.

**Steps:**
- [ ] Static review of `initializeWorkspace` / `systemd-run` usage in `runtime-systemd`.
- [ ] If root/systemd available: `systemd-run --wait --collect` with the planned flags running `pnpm config get userconfig` and a planted `.pnpmfile.cjs` that would throw.
- [ ] Without systemd: run pnpm as the plan's argv would, in a temp dir with hostile `.pnpmfile.cjs` and `.npmrc`, and assert they are ignored.

**Pass:** Hostile pnpmfile/userconfig cannot change the install. Mark **blocked** for full slice/`IPAddressAllow` if no root.

**Record:** `phase0-results.md` §P0.4.

### Task P0.5: Container pasta matching and one-shot reconcile

**Purpose:** `meta skuid . tcp dport` through pasta; shape of a one-shot reconcile `runsc` container.

**Steps:**
- [ ] Static review of `deploy/production/nftables/dsh-public.nft` and pasta flags in the provisioner (`--no-splice` etc.).
- [ ] If pasta/runsc available: minimal listen + connect as a mapped uid and observe nft counters; else mark **blocked**.
- [ ] Draft `assertSafeReconcileArgv` allowlist from `assertSafeRunArgv` by diff.

**Pass:** Documented whether skuid matching is already relied on by quota (yes → market can reuse). Reconcile argv allowlist sketched.

**Record:** `phase0-results.md` §P0.5.

### Task P0.6: Git blob tarball vs `npm pack`

**Purpose:** Tarball from git blobs installs like `npm pack` output (`files` / `.npmignore`).

**Steps:**
- [ ] Clone a tiny fixture repo (or use an in-tree sample); `npm pack` vs custom tar of tree blobs at the same commit.
- [ ] Install both into empty dirs; compare file lists.

**Pass:** Diff empty, or documented gaps that the mirror must close.

**Record:** `phase0-results.md` §P0.6.

### Task P0.7: Idle signal and `installBundle({ enabled: false })`

**Purpose:** Existing idle signal for sync; HMR path does not start plugins when `enabled: false`.

**Steps:**
- [ ] Search Cordis / agent runtime for idle / turn-running signals; shortlist one.
- [ ] Unit or harness test: `installBundle(spec, { enabled: false })` under HMR mock; assert no fiber for that bundle; then `setBundleEnabled(name, true)` starts it. Code refs: `packages/boot/plugin-manager/src/index.ts` (`enabled !== false`, `setBundleEnabled`).

**Pass:** Chosen idle signal named; disabled-install behaviour confirmed in-process (no full UI needed).

**Record:** `phase0-results.md` §P0.7.

### Task P0.8: Socket unit cgroup and `dsh_market` loader

**Purpose:** Which cgroup holds systemd INET listeners (`init.scope` vs `system.slice/dsh-plugins.socket`); loader from `ExecStartPost`; reload after socket restart.

**Steps:**
- [ ] If root + systemd: generate a tiny socket unit with one `ListenStream=127.0.0.1:<free>`, start it, read cgroup for the listening inode; load a toy nft chain with each candidate path.
- [ ] Restart the socket unit; see if nft `socket cgroupv2` still matches.
- [ ] Without root: mark **blocked**; record kernel BPF firewall presence as hint only—not a pass.

**Pass:** Chosen cgroup path written into loader template notes. **If assumption wrong:** stop and report before coding 1B.

**Record:** `phase0-results.md` §P0.8.

### Task P0.9: `inet_diag` peer check from unprivileged service

**Purpose:** Exact four-tuple `NETLINK_SOCK_DIAG` returns peer UID on `127.0.0.1` (and pasta if available); cost per accept; `/proc/net/tcp` fallback cost. If neither works → user decision before phase 1.

**Steps:**
- [ ] Write a small Node script under `docs/superpowers/plans/fixtures/p0-peer-check/` that listens on `127.0.0.1`, accepts, and looks up peer UID via netlink (or a tiny native helper). Run as an unprivileged user.
- [ ] Benchmark 1k accepts.
- [ ] Implement `/proc/net/tcp` fallback path and benchmark.
- [ ] Pasta path: **blocked** without pasta; note quota already depends on skuid identity.

**Pass:** Working method named with µs/accept. **Fail both:** stop; escalate as design risk change (no silent downgrade).

**Record:** `phase0-results.md` §P0.9.

---

## Milestone 1A: store and mirror (TDD)

Package home: `integrations/public-harness/packages/plugins/` (new). Entry: `integrations/public-harness/packages/production/src/plugins-service.ts`, `plugins-fetch.ts`, `plugins-egress.ts`. Follow `packages/kb` + `packages/quota` layout (schema, migrations, service, tests).

### Task 1A.1: Schema, partial indexes, migrations

**Files:** Create `packages/plugins/{package.json,tsconfig.json,src/{schema.ts,db.ts,migrate.ts,ids.ts},tests/schema.spec.ts,README.md,README.zh.md}`. Tables per design `plugin_package`, `plugin_version`, `plugin_artifact`, `plugin_closure`, `plugin_endpoint`, `plugin_default*`, `plugin_policy`, `dsh_plugin_limit`, `plugin_audit_outbox`, `claimed_at` on package.

- [ ] **1. Write failing tests:** unique `name@version` artifact; one pending version per package (partial unique); resubmit after reject/withdraw/expire; name release when first version never approved.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/plugins test -- schema.spec.ts`; expect fail.
- [ ] **3. Implement** migrations and helpers.
- [ ] **4. Verify** tests pass; commit `feat(plugins): catalogue schema and migrations`.

### Task 1A.2: Egress proxy and SSRF checks

**Files:** Create `packages/plugins/src/egress/{server.ts,policy.ts,ranges.ts}`, `tests/egress.spec.ts`; `production/src/plugins-egress.ts`; native unit sketch `deploy/native/systemd/dsh-plugins-egress.service` (install later in 1B).

**Interfaces:** `startEgressProxy({ listen: '127.0.0.1', port, allow, intranet, fetchUidOnly: true })`. Connect only to validated A/AAAA; reject IP literals unless intranet; IPv6 ranges per design.

- [ ] **1. Write failing tests:** forbidden IPv4/IPv6, DNS rebinding (resolve then swap), IP literal, redirect to unlisted host, non-allow host.
- [ ] **2. Run** focused egress tests; expect fail.
- [ ] **3. Implement** CONNECT proxy.
- [ ] **4. Verify** pass; commit `feat(plugins): allowlisting egress CONNECT proxy`.

### Task 1A.3: Fetch service verbs

**Files:** Create `packages/plugins/src/fetch/{server.ts,verbs.ts,framing.ts}`, `tests/fetch-verbs.spec.ts`; `production/src/plugins-fetch.ts`; socket unit notes for 1B.

**Interfaces:** verbs `npm-version`, `git-commit`, `upload-check`, `closure`, `artifact` with argument allowlists; KB-helper framing.

- [ ] **1. Write failing tests:** unknown verb, extra args, path `..`, non-SemVer version refused before network.
- [ ] **2. Run** tests; expect fail.
- [ ] **3. Implement** framing + allowlists (network calls mocked).
- [ ] **4. Verify** pass; commit `feat(plugins): socket-activated fetch verbs`.

### Task 1A.4: Mirror pipeline (npm + upload)

**Files:** Create `packages/plugins/src/mirror/{resolve.ts,closure.ts,scripts.ts,artifact.ts,store.ts}`, `tests/mirror.spec.ts`.

**Interfaces:** `mirrorVersion(source) -> { artifactSha512, mode: 'bundle' | 'fallback', closure }`; refuse non-SemVer deps before pnpm; detect install scripts; freeze on `ready`; `expected_artifact_sha512` compare on approve (approve API in 1C—store the compare helper here).

- [ ] **1. Write failing tests:** integrity mismatch; git/URL/`file:` dep → `closure-source`; script detection matrix; ready blob never rewritten; bundle vs fallback selection using P0.3 result.
- [ ] **2. Run** tests; expect fail.
- [ ] **3. Implement** with fixtures; real pnpm only in integration test marked serial.
- [ ] **4. Verify** pass; commit `feat(plugins): mirror pipeline with pinned artifacts`.

### Task 1A.5: Admin upload + audit outbox (path B core)

**Files:** Create `packages/plugins/src/{upload.ts,audit.ts}`, `tests/upload.spec.ts`. Company scope `@corp-dsh/` mandatory.

- [ ] **1. Write failing tests:** rejects non-`@corp-dsh/` git/upload; `version-exists`; writes `admin-plugin-upload` outbox row.
- [ ] **2. Run** tests; expect fail.
- [ ] **3. Implement** upload path calling mirror.
- [ ] **4. Verify** pass; commit `feat(plugins): admin upload with company scope and audit`.

**1A exit:** schema + egress + fetch verbs + mirror + admin upload tests green; no systemd install required yet.

---

## Milestone 1B: serving (TDD)

Package home remains `integrations/public-harness/packages/plugins/`. Systemd units under `integrations/public-harness/deploy/native/systemd/`. Firewall / probe under `packages/runtime-systemd/`. Do **not** claim P0.8 systemd-cgroup results (still blocked); peer check uses P0.9 method with `/proc/net/tcp` fallback. P0.1: `--patch` wins over Settings.

### Task 1B.1: Ports, tokens, HTTP routes

**Files:** Create `packages/plugins/src/{listen.ts,routes.ts,token.ts}`, `tests/serving.spec.ts` (or split).

**Interfaces:** `validateMarketPorts` / `openEndpoint` / `closeEndpoint` (1:1 port↔user, cap `MAX_PLUGIN_ACCOUNTS` = 4096); `mintMarketToken` + constant-time bearer compare against `token_sha256`; `startMarketHttpServer({ host: '127.0.0.1', port, ... })` serving `GET /index.json`, `GET /npm/<name>`, `GET /npm/<name>/-/<basename>-<version>.tgz` (stub bodies OK; real index builder is 1B.3). Loopback only.

- [ ] **1. Write failing tests:** port allocation uniqueness and 4096 cap; refuse non-`127.0.0.1` listen host; bearer reject/accept; basic route 404/200 shapes.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/plugins test -- serving.spec.ts`; expect fail.
- [ ] **3. Implement** listen / routes / token.
- [ ] **4. Verify** pass; commit `feat(plugins): per-user market ports tokens and routes`.

### Task 1B.2: Peer UID check

**Files:** Create `packages/plugins/src/peer-check.ts`, `tests/peer-check.spec.ts`.

**Interfaces:** `lookupPeerUid(socket)` via `NETLINK_SOCK_DIAG` `inet_diag` with `/proc/net/tcp` fallback (P0.9); on accept, refuse foreign uid / unmapped port / failed lookup before reading a byte. Do not claim systemd cgroup results (P0.8 still blocked).

- [ ] **1. Write failing tests:** matching uid accepted; foreign uid / unmapped / lookup failure closed; fallback path exercised with fixture table.
- [ ] **2. Run** focused peer-check tests; expect fail.
- [ ] **3. Implement** peer-check and wire into listen accept path.
- [ ] **4. Verify** pass; commit `feat(plugins): inet_diag peer uid check on accept`.

### Task 1B.3: Index builder

**Files:** Create `packages/plugins/src/index-builder.ts`, `tests/index-builder.spec.ts`.

**Interfaces:** `buildPersonalizedIndex(db, userId, groups)` — visibility scopes → personalized `index.json` (KB-view style); cache by digest; skills omitted from index (phase 2).

- [ ] **1. Write failing tests:** company vs group scope; delisted omitted; generation / groups change busts cache digest.
- [ ] **2. Run** tests; expect fail.
- [ ] **3. Implement** builder; wire `GET /index.json` to it.
- [ ] **4. Verify** pass; commit `feat(plugins): personalized market index builder`.

### Task 1B.4: Market firewall render + probe (unit tests)

**Files:** Create / modify `packages/runtime-systemd/src/{market-firewall.ts,probe.ts}` and wire `network.ts`.

**Interfaces:** render `inet dsh_market` table text + owner accept in `in_<uid>`; probe self-heal when table/chain missing; exact set equality of `market_owner` vs endpoint rows under one lock. **No root required** — assert rendered nft/text and probe logic with fixtures.

- [ ] **1. Write failing tests:** rendered table/set/chain text; missing-table self-heal; extra element deleted; missing element added; lock serializes compare+mutate.
- [ ] **2. Run** focused runtime-systemd market tests; expect fail.
- [ ] **3. Implement** render + probe helpers (fixtures only).
- [ ] **4. Verify** pass; commit `feat(runtime-systemd): market firewall render and probe`.

### Task 1B.5: Units, contracts, provisioner patches

**Files:** Create `deploy/native/systemd/{dsh-plugins.socket,dsh-plugins.service,dsh-plugins-fetch.socket,dsh-plugins-fetch@.service,dsh-plugins-egress.service}`; add `pluginMarketRows` in `packages/contracts/src/web-rows.ts`; provisioner writes `instance-market/<account>.{yml,npmrc}`; config rejects overlapping / `ports.market` > 4096.

- [ ] **1. Write failing tests:** unit file contents (`LimitNOFILE=16384`, `AF_NETLINK`, `ListenStream=127.0.0.1`); `pluginMarketRows` shape; config overlap and >4096 refusal; npmrc / patch writers.
- [ ] **2. Run** focused tests; expect fail.
- [ ] **3. Implement** units, contracts, provisioner writers/validators.
- [ ] **4. Verify** pass; commit `feat(plugins): systemd units contracts and market patches`.

**1B exit:** serving + peer-check + index + firewall-render/probe + units/contracts tests green; no root systemd install required (P0.8 remains blocked).

## Milestone 1C: review flow (TDD)

Package home remains `integrations/public-harness/packages/plugins/`. Identity gateway under `packages/identity/`. Admin UI under `packages/ui/src/client/` (admin-kit patterns). Transition table: design § Listing flows (~410–440). Path B upload already in 1A.5; this milestone owns path A submit/approve and listing ops.

### Task 1C.1: Submit + ownership + name release

**Files:** Create `packages/plugins/src/submit.ts`, `tests/submit.spec.ts`; export from `index.ts`.

**Interfaces:** `submitPluginVersion` / `withdrawSubmission` / `expireSubmission` — first version of an unclaimed `@corp-dsh/` name sets `owner_user_id` (held; `claimed_at` stays NULL until approve); one pending per package; withdraw (submitter) / expire (system) / reject (via state helper until 1C.2) of an unclaimed first version calls `releaseUnclaimedName`; later versions refuse foreign users with 403 `not-owner` (admin may submit); also 409 `pending-exists`, `version-exists`, `limit-reached`, `name-taken` (held by another). Mirror stays `queued` (fetch runs later).

- [ ] **1. Write failing tests:** first version claims name; pending uniqueness; withdraw/expire/reject allow resubmit + name release; refuse foreign ownership; company scope.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/plugins test -- submit.spec.ts`; expect fail.
- [ ] **3. Implement** `submit.ts` (+ exports), reusing schema helpers from 1A.1.
- [ ] **4. Verify** pass; commit `feat(plugins): plugin submit ownership and name release`.

### Task 1C.2: Approve / reject (path A)

**Files:** Create `packages/plugins/src/approve.ts`, `tests/approve.spec.ts`.

**Interfaces:** `approveSubmission` / `rejectSubmission` — approve requires `expected_artifact_sha512` (409 `artifact-mismatch` / `mirror-not-ready` / `install-scripts`); 403 `self-approval`; sets `reviewed_by` / `reviewed_at`; first approval sets `claimed_at`; listing pointer: newer than current → current + old to `previous_version_id`, else history only.

- [ ] **1. Write failing tests:** sha512 bind, self-approval, mirror-not-ready, install-scripts allow-list, listing current/previous, reject → `not-pending` after.
- [ ] **2. Run** focused approve tests; expect fail.
- [ ] **3. Implement** approve/reject; reuse `compareExpectedArtifactSha512` from 1A.4.
- [ ] **4. Verify** pass; commit `feat(plugins): path A approve reject and listing pointers`.

### Task 1C.3: Listing ops

**Files:** Create `packages/plugins/src/{listing.ts,visibility.ts}`, `tests/listing.spec.ts`.

**Interfaces:** `changeScope` / `delistPackage` / `relistPackage` / `rollbackListing` / `revokeVersion` — scope rewrite; delist keeps scope rows and mirror for original scope; relist clears `delisted_at`; rollback by pointer rules (409 `no-previous`); revoke non-current removes from packuments/index, revoke current rolls back or delists with reason `revoked`.

- [ ] **1. Write failing tests:** scope change visibility; delist/relist; rollback pointer; revoke current vs non-current.
- [ ] **2. Run** focused listing tests; expect fail.
- [ ] **3. Implement** listing + visibility helpers; wire index builder if needed.
- [ ] **4. Verify** pass; commit `feat(plugins): listing scope delist rollback revoke`.

### Task 1C.4: Identity gateway

**Files:** Create `packages/identity/src/plugins-gateway.ts`, `tests/plugins-gateway.spec.ts` (mirror `kb-gateway.ts`).

**Interfaces:** `PLUGIN_ADMIN_ENDPOINTS`, `PLUGIN_REAUTH`, `PLUGIN_EVENTS` (+ me endpoints as needed); reauth on approve / upload / scope / rollback / delist / revoke; forward to plugins control socket with `x-dsh-user` / role; drain `plugin_audit_outbox`.

- [ ] **1. Write failing tests:** endpoint maps; reauth set membership; forward strips password; audit drain filters `PLUGIN_EVENTS`.
- [ ] **2. Run** focused identity tests; expect fail.
- [ ] **3. Implement** gateway module and wire into admin/me routers.
- [ ] **4. Verify** pass; commit `feat(identity): plugins admin gateway with reauth`.

### Task 1C.5: Admin + My plugins UI

**Files:** Create / modify `packages/ui/src/client/admin-plugins*.tsx` and a personal **My plugins** page; reuse `admin-kit` `Card` / `Row` / `useReauth` / field helpers. Keep existing buttons, icons, and component shapes.

**Surfaces:** System Admin > Plugin market — review queue, listed plugins, upload, defaults, policy, limits (stubs OK if API not fully wired). Personal > My plugins — submit, withdraw, ask delist.

- [ ] **1. Write failing tests / smoke:** routes render with admin-kit primitives; reauth hook on approve/upload/scope/rollback/delist/revoke actions.
- [ ] **2. Run** focused UI / identity page tests; expect fail.
- [ ] **3. Implement** minimal pages matching existing identity admin UI patterns.
- [ ] **4. Verify** pass; commit `feat(ui): plugin market admin and my-plugins pages`.

**1C exit:** every transition-table row + refusal code tested; department visibility; reauth on approve/upload/scope/rollback/delist/revoke; admin + My plugins pages present.

## Milestone 1D: defaults and updates (TDD)

Server side stays in `integrations/public-harness/packages/plugins/` (`plugin_default` / `plugin_default_state`, `GET /sync`, `POST /sync/report`, `reconcile-plan`, reconcile entry). In-instance sync lives in new `packages/plugin-sync/` (`public-harness-plugin-sync`). Design: § Default installs, sync, and reconcile; Updates and rollback; API `/sync` `/sync/report`. P0.7: gate on agent `status: 'idle'` (not `idleWatchdog`). P0.4: pnpm ignore flags OK; live systemd slice / `IPAddressAllow` still **blocked** — unit-text / argv fixtures only (same pattern as 1B). Container one-shot reconcile stays in **1E**.

### Task 1D.1: Defaults CRUD + state

**Files:** Create `packages/plugins/src/defaults.ts`, `tests/defaults.spec.ts`; export from `index.ts`.

**Interfaces:** `setDefault` / `clearDefault` / `resetDefault` (admin) / `reenableDefault` (me) — write `plugin_default` for company or group targets; `reset_at` clears opt-outs older than it; `plugin_default_state` values `installed` | `pending` | `failed` | `opted-out` | `user-managed`; a user's default set is every default visible to them (same visibility as listings); delisted packages stop installing as defaults; apply-count helpers for admin. Wire control handlers behind identity routes already stubbed in 1C.4/1C.5 (`POST /plugins/defaults`, `/defaults/reset`, me `/defaults/reenable`).

- [ ] **1. Write failing tests:** set/clear company and group defaults; visibility filter; reset clears opted-out; re-enable restores pending/installed path; delisted refuse / stop; state stubs.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/plugins test -- defaults.spec.ts`; expect fail.
- [ ] **3. Implement** `defaults.ts` (+ exports / control wiring as needed).
- [ ] **4. Verify** pass; commit `feat(plugins): default installs set clear reset reenable`.

### Task 1D.2: Sync plan + report API

**Files:** Create `packages/plugins/src/sync-plan.ts`, `tests/sync-plan.spec.ts`; wire `GET /sync` and `POST /sync/report` on the market HTTP server; expose control-socket `reconcile-plan(userId)`.

**Interfaces:** `buildSyncPlan(userId)` → `{ entries: [{ name, version, fromVersion, sha512, action, allowedBuilds }], ... }` with `action` in `install` | `update` | `downgrade` (plan is a request, not an order); `applySyncReport(userId, report)` derives `opted-out` **only** from `user-removed` op-log records, marks open/failed applies as `failed`, derives `user-managed` and installed count for `max_installed`; `reconcilePlan(userId)` returns the same plan shape for the provisioner (`name@exact-semver` + sha512 + registry = that user's `ports.market` on `127.0.0.1` / `hostAddress`). Bearer + peer checks already from 1B apply.

- [ ] **1. Write failing tests:** plan actions for new / newer / rolled-back defaults; skip opted-out / user-managed; report maps user-removed → opted-out only; bad registry rejected for reconcile-plan.
- [ ] **2. Run** focused sync-plan tests; expect fail.
- [ ] **3. Implement** plan builder, report apply, route + control verb wiring.
- [ ] **4. Verify** pass; commit `feat(plugins): sync plan report and reconcile-plan`.

### Task 1D.3: plugin-sync apply core

**Files:** Create `integrations/public-harness/packages/plugin-sync/` (`public-harness-plugin-sync`); `src/{oplog.ts,apply.ts,index.ts}`, `tests/{oplog,apply}.spec.ts`.

**Interfaces:** poll `GET /sync` at start (idle/apply wiring in 1D.4); local op log `~/.dsh-market/sync-log.jsonl` (`intent` / `done` / `removed` / `failed` / `recovered` / `user-removed`); **user-removal rule** — sync `done` install, package now absent from `package.json`, no later sync `removed` → write `user-removed` (covers Discover, `dsh plugin remove`, hand edit); preconditions under the same `package.json.lock` `withFileLock` as plugin-manager (fresh read): `update`/`downgrade` only at exact `fromVersion`; `install` only if absent and not user-removed since reset/re-enable; apply: `removeBundle` (update/downgrade) → `installBundle(name@version, { registry, enabled: false, approvedBuilds })` → re-check presence + lockfile integrity == `sha512` + no user-removal since intent → `setBundleEnabled(name, true)`; **integrity mismatch never enables** (remove never-enabled bundle; on update reinstall `fromVersion`); `already-installed` / `not-removable` abandon entry. Mock plugin-manager; do not depend on live HMR.

- [ ] **1. Write failing tests:** user-removed from CLI/hand-edit shapes; preconditions skip reasons; enabled:false then enable; integrity fail never enables; already-installed / not-removable.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/plugin-sync test`; expect fail.
- [ ] **3. Implement** package scaffold, oplog, apply core (snapshots/recovery stubs OK until 1D.5).
- [ ] **4. Verify** pass; commit `feat(plugin-sync): oplog user-removed and disabled install apply`.

### Task 1D.4: Idle gate (P0.7)

**Files:** Create `packages/plugin-sync/src/idle.ts`, `tests/idle.spec.ts`; wire poll loop (every ~5 minutes + jitter) and apply gate.

**Interfaces:** `isAgentIdle(ctx)` uses agent `status: 'idle'` (P0.7 shortlist — **not** LLM `idleWatchdog`); apply runs only while idle; when not idle, leave defaults `pending` and skip mutate; `plugin-manager/changed` only schedules an earlier re-check (never used as the user-removal source). Design ~5 minute live push window.

- [ ] **1. Write failing tests:** idle allows apply; non-idle skips; jittered poll schedule; changed event advances next check only.
- [ ] **2. Run** focused idle tests; expect fail.
- [ ] **3. Implement** idle helper + poll/apply gate.
- [ ] **4. Verify** pass; commit `feat(plugin-sync): agent idle gate for default apply`.

### Task 1D.5: Snapshots + recovery

**Files:** Create `packages/plugin-sync/src/snapshots.ts`, `tests/snapshots.spec.ts` (helpers reusable by reconcile in 1D.6).

**Interfaces:** before each `intent`, copy `package.json` + `pnpm-lock.yaml` to `~/.dsh-market/snapshots/<op>/` (keep last five); read with `O_NOFOLLOW`, regular files only, ≤ 4 MiB; refuse symlink planted as `package.json`; **recovery:** if `removeBundle` succeeded and `installBundle` failed → reinstall `fromVersion` from mirror; if that fails → restore both files from snapshot, leave intent `failed` for next reconcile; integrity-failure path must leave plugin never started. Hashes only go to server `plugin_profile_snapshot` (files stay in the account home). Queued user/admin restore runs at next reconcile start (never mid-run) — wire queue stubs here; execute in 1D.6.

- [ ] **1. Write failing tests:** snapshot write/rotate; symlink refuse; remove+install failure recovers to fromVersion or files; integrity mismatch leaves disabled/absent.
- [ ] **2. Run** focused snapshot tests; expect fail.
- [ ] **3. Implement** snapshot IO + recovery paths; hook into apply.
- [ ] **4. Verify** pass; commit `feat(plugin-sync): profile snapshots and apply recovery`.

### Task 1D.6: Reconcile entry + provisioner pre-start (P0.4)

**Files:** Create `packages/plugins/src/reconcile-entry.ts` (and release entry/bin as needed), `tests/reconcile-entry.spec.ts`; provisioner hooks in `packages/provisioner/src/runtime.ts` (native order: slice → `network.install` → reconcile unit → instance); unit-text fixtures under `deploy/native/systemd/` or beside tests. **No live `systemd-run`** on this box (P0.4 blocked) — assert argv / unit text / env allowlist with fixtures, same substitute style as 1B. Container one-shot reconcile → **1E**.

**Interfaces:** entry runs as the account; loads plan only from `reconcile-plan`; each entry `name@exact-semver` + sha512; registry must be that user's market port on loopback/`hostAddress` or abort; same user-removal rule + op log as sync; first complete any open `failed` sync from its snapshot; pnpm as `dsh plugin` with `--ignore-pnpmfile`, `--config.registry=<mirror>`, `--config.userconfig=/dev/null`, one `--allow-build=<pkg>` per allowed build (never `ignore-scripts`); update/downgrade = single `pnpm add name@version`; failure/timeout (120 s/pkg, 300 s total) restores snapshot then `pnpm install --frozen-lockfile --offline`, else online against user mirror only; instance starts anyway on error; env allowlist exactly `HOME` / `DSH_HOME` / `XDG_CACHE_HOME` / `TMPDIR` / toolchain `PATH` / `NPM_CONFIG_GLOBALCONFIG` (no root inherit, no model key). Unit text modeled on `initializeWorkspace`: slice, uid/gid, AppArmor, `IPAddressDeny=any` + `IPAddressAllow=localhost`, `RuntimeMaxSec=300`.

- [ ] **1. Write failing tests:** plan validation / bad registry abort; user-removed skip; open failed sync restored; pnpm argv flags (P0.4 substitute); unit-text / env allowlist fixtures; offline then online repair path.
- [ ] **2. Run** focused reconcile-entry (+ provisioner fixture) tests; expect fail.
- [ ] **3. Implement** entry + provisioner pre-start wiring; mark live systemd as partial/blocked in notes.
- [ ] **4. Verify** pass; commit `feat(plugins): pre-start reconcile entry and provisioner hook`.

**1D exit:** CLI/hand-edit uninstall not reinstalled; remove+install failure recovers; integrity mismatch never enables; idle gate uses P0.7 agent idle signal; live systemd reconcile remains partial/blocked per P0.4 (fixtures green).

## Milestone 1E: policy, limits, containers (TDD)

Server-side policy and limits live in `integrations/public-harness/packages/plugins/` (`plugin_policy`, `dsh_plugin_limit`) with resolution shared via a generalized `packages/kb/src/limits.ts` `effectiveLimits`. Container production pieces live under `deploy/production/` and `packages/provisioner/`. Design: § Installation and policy; Plugin limits; Deployment changes (production). **Locked decisions:** `market_only` is policy-only (no `egress_lock` in phase 1 — that is phase 2); signatures phase 2; ~5 min idle push already in 1D; native + container in phase 1 (containers here); no self-review on path A; force company scope `@corp-dsh/`; production firewall gains a market-range exception only (Q7); accept the three phase-1 residual risks; scale cap 4096 accounts. P0.5 live pasta/runsc still **blocked** — argv / nft-text / volume fixtures only. Fold deferred from 1D: promote `assertSafeReconcileArgvDraft` → `assertSafeReconcileArgv`; release packaging for `reconcile-entry.mjs`.

### Task 1E.1: Generalize effectiveLimits + plugin limits

**Files:** Generalize `packages/kb/src/limits.ts` `effectiveLimits` over caller-supplied limit names (KB `LIMIT_NAMES` stay the default for KB callers); create `packages/plugins/src/limits.ts`, `tests/limits.spec.ts`; seed / CRUD on `dsh_plugin_limit`; wire identity-backed admin control (`GET`/`PUT`/`DELETE /plugins/limits`, `GET /plugins/limits/effective`) already stubbed in the gateway.

**Interfaces:** `PLUGIN_LIMIT_NAMES` = `max_installed` | `max_submissions` | `max_submission_bytes`; defaults global 50 / 20 / 1 GiB (design Q12); `effectivePluginLimits(rows, userId, groups)` reuses the generalized resolver (user wins → most permissive among effective groups incl. ancestors → global; `NULL` = unlimited); `setPluginLimit` / `deletePluginLimit` (admin, reauth); **lowering a limit never deletes, delists, or uninstalls** — only growth returns 409 `limit-reached`; enforce `max_submissions` / `max_submission_bytes` on submit/upload; `max_installed` best-effort on packument + index mark when last sync/reconcile report is at limit (tarball/git/stale reports may escape); default installs count toward `max_installed` but sync/reconcile still install past the limit when an admin chose them (record it); audit `admin-plugin-limit-change` / `admin-plugin-limit-delete`.

- [ ] **1. Write failing tests:** generalized resolver with plugin names; user/group/global precedence; lower limit leaves existing installs/submissions; submit/upload refuse at cap; packument/index mark at `max_installed`; defaults still plan past limit; delete/set admin shapes.
- [ ] **2. Run** `pnpm --dir integrations/public-harness/packages/kb test` (resolver) and `pnpm --dir integrations/public-harness/packages/plugins test -- limits.spec.ts`; expect fail on new cases.
- [ ] **3. Implement** generalized `effectiveLimits`, plugin limits module, enforcement hooks, control wiring.
- [ ] **4. Verify** pass; commit `feat(plugins): generalize effectiveLimits and plugin limits`.

### Task 1E.2: market_only / install_scripts policies

**Files:** Create `packages/plugins/src/policy.ts`, `tests/policy.spec.ts`; wire `GET`/`PUT /plugins/policy`; ensure provisioner / market-file writers consume resolved `marketOnly` (npmrc `registry=` + `pluginMarketRows` `fallbackRegistries: []` already exist in 1B — bind them to policy resolution); keep `egress_lock` schema/name only (phase 2 — do not implement firewall drops).

**Interfaces:** `effectivePolicy(userId, groups)` — user is under `market_only` when any effective group or the global row turns it on; default `install_scripts = deny` (approve already 409 `install-scripts` unless each package allowed after reauth); under `market_only`, registry specs outside the user mirror fail closed with not-found in the existing dialog **without** needing `egress_lock` (git/tarball/`443` still leave — accepted soft policy); company scope remains forced `@corp-dsh/`; audit `admin-plugin-policy-change`. Phase 0 confirmed `--patch` wins over Settings for registry/`indexes`.

- [ ] **1. Write failing tests:** resolve market_only from global/group; install_scripts deny default; market_only drives npmrc `registry=` + empty `fallbackRegistries`; non-mirror registry spec fails closed; `egress_lock` PUT refused or no-op stub (phase 2); no firewall mutation from this task.
- [ ] **2. Run** focused policy (+ market-files / contracts) tests; expect fail on new cases.
- [ ] **3. Implement** policy module, control wiring, provisioner consume-resolved-marketOnly path.
- [ ] **4. Verify** pass; commit `feat(plugins): market_only and install_scripts policy`.

### Task 1E.3: Production nftables + README (Q7)

**Files:** Update `deploy/production/nftables/dsh-public.nft`; create `deploy/production/nftables/dsh-market.nft`; update `deploy/production/README.md` (and tests/fixtures under `deploy/production/` or package tests that already parse nft text). **No live `nft`** required — static text / example-parse fixtures (same substitute style as 1B.4).

**Interfaces:** `define MARKET_PORTS` matching `ports.market` / provisioner config; in `dsh-public.nft`, `oif "lo" ip daddr 127.0.0.1 tcp dport $MARKET_PORTS accept` **before** `oif "lo" drop`; keep `dsh-plugins-fetch` → `egressPort` only; **do not** land `egress_locked` drops (phase 2); `dsh-market.nft` holds table `dsh_market` with `market_listener` input subchain, `market_owner` set, and owner drop in an output chain at priority `filter - 2`, loaded by the socket unit `ExecStartPost=-` and **never** by the `dsh-public.nft` load; README records the overturned decision (Q7): per-user set elements + receiving-socket rule exist **for the market range only**; root / `dsh-router` / `dsh-identity` / other host accounts stay off those ports; note `flush ruleset` risk and probe restore (peer check remains defense in depth).

- [ ] **1. Write failing tests:** MARKET_PORTS accept precedes lo drop; dsh-market table/set/chain text; README mentions market-range exception; examples stay consistent with provisioner `ports.market` width ≤ 4096.
- [ ] **2. Run** focused production / nft fixture tests; expect fail.
- [ ] **3. Implement** nft files + README; mark live nft apply as out-of-scope on this box.
- [ ] **4. Verify** pass; commit `feat(production): market nftables and README Q7 exception`.

### Task 1E.4: Container webPatch, market volume, market_owner

**Files:** Extend `packages/provisioner/src/runtime.ts` (and `config.ts` / `market-files.ts` as needed), `tests/runtime.spec.ts` (or split); ensure `pluginMarketRows` with `hostAddress` land in container `webPatch`; admit read-only market volume on `assertSafeRunArgv` allowlist; add/remove `market_owner` set elements around instance life.

**Interfaces:** `webPatch` includes the same market insert rows as native (`plugin-market`, `ui-plugin-market`, sync plugin, optional `plugin_manager` registry under market_only) with registry host = `config.quota.hostAddress`; mount `<marketDir>/<account>:/run/dsh-market:ro` and set `NPM_CONFIG_GLOBALCONFIG=/run/dsh-market/npmrc`; volume must pass `assertSafeRunArgv`; provisioner adds the account to `market_owner` before start and removes on stop (fixture the nft set element argv/text — no live nft); `ports.market` validation already refuses overlap / >4096 — keep covered.

- [ ] **1. Write failing tests:** webPatch contains pluginMarketRows + hostAddress; RO market volume admitted; foreign volume / publish still refused; market_owner add/remove call shapes; marketOnly flips registry rows.
- [ ] **2. Run** focused provisioner runtime / market tests; expect fail.
- [ ] **3. Implement** webPatch rows, volume allowlist, set-element helpers.
- [ ] **4. Verify** pass; commit `feat(provisioner): container market webPatch volume and owner set`.

### Task 1E.5: One-shot reconcile container + assertSafeReconcileArgv (P0.5)

**Files:** Promote `assertSafeReconcileArgvDraft` → `assertSafeReconcileArgv` in `packages/provisioner/src/runtime.ts`; create reconcile-container argv builder + tests; wire provisioner pre-start after `market_owner` is present (container order: network/set → one-shot reconcile → instance). **No live pasta/runsc** (P0.5 blocked) — argv / allowlist fixtures only.

**Interfaces:** one-shot `runsc` with the instance image, userns, pasta `--no-splice` + `--map-host-loopback`, **no publish**; volumes narrowed to workspace + market/snapshot paths only (forbid-list same spirit as `assertSafeRunArgv`); command allowlist `pnpm` / `node` reconcile entry only; env allowlist identical to native reconcile (`HOME` / `DSH_HOME` / `XDG_CACHE_HOME` / `TMPDIR` / toolchain `PATH` / `NPM_CONFIG_GLOBALCONFIG`); plan still only from `reconcile-plan` with user mirror registry; instance starts anyway on reconcile error; owner reach + cross-tenant deny covered by set + peer check (fixture assertions).

- [ ] **1. Write failing tests:** safe argv admits workspace+market, refuses publish/extra volume/forbidden flags; pasta flags present; command allowlist; runs after market_owner add; error still starts instance (mock).
- [ ] **2. Run** focused provisioner reconcile-container tests; expect fail.
- [ ] **3. Implement** `assertSafeReconcileArgv` + one-shot wiring; note live pasta blocked.
- [ ] **4. Verify** pass; commit `feat(provisioner): container one-shot reconcile argv allowlist`.

### Task 1E.6: Release packaging for reconcile-entry.mjs

**Files:** Ship `reconcile-entry.mjs` (from `packages/plugins` build / `reconcile-entry-main`) into the release/production asset layout used by native units and the container one-shot; update `packages/production` entry or release manifest as needed; tests that the packaged path is what provisioner argv and systemd unit text reference.

**Interfaces:** stable artifact path consumable as `node <release>/reconcile-entry.mjs <planPath>` (native) and as the container command allowlist entry; no new behaviour beyond packaging + path wiring; keep env allowlist and plan-file contract from 1D.6.

- [ ] **1. Write failing tests:** packaged file exists at expected release path; unit/argv fixtures point at that path; `node … reconcile-entry.mjs` help/missing-plan exit shapes still hold when run from the packaged file.
- [ ] **2. Run** focused production / plugins packaging tests; expect fail.
- [ ] **3. Implement** packaging + path wiring for native and container consumers.
- [ ] **4. Verify** pass; commit `feat(plugins): package reconcile-entry.mjs for release`.

**1E exit:** market_only registry specs fail closed without `egress_lock`; container owner reach + cross-tenant deny (fixtures); lowering limits never deletes data; production README records market-range firewall exception (Q7); `assertSafeReconcileArgv` + one-shot reconcile fixtures green (live pasta/runsc still blocked per P0.5); reconcile-entry.mjs packaged for release.

## Phase 2 (later; not in this plan's coding tasks)

Signatures; pure-skill views; optional `egress_lock`.

---

## Execution order

1. Complete Phase 0 tasks P0.1–P0.9; fill `phase0-results.md`. Stop if P0.8/P0.9 falsify assumptions.
2. Milestone 1A tasks in order.
3. Milestone 1B tasks in order (outline expanded 2026-10-23). Milestone 1C tasks in order (outline expanded 2026-10-23). Milestone 1D tasks in order (outline expanded 2026-10-23). Milestone 1E tasks in order (outline expanded 2026-10-23).
4. Push `codex/plugin-market-impl` after each green task commit. Await「可以合并」before master.
