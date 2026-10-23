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

## Milestone 1D: defaults and updates (outline)

**Create / modify:**
- `packages/plugin-sync/` — `public-harness-plugin-sync`; sync-log; install `enabled:false` → re-check → `setBundleEnabled`; user-removed rule.
- Reconcile entry + provisioner pre-start unit (flags from P0.4).
- Snapshots under `~/.dsh-market/snapshots/`.

**Acceptance:** CLI/hand-edit uninstall not reinstalled; remove+install failure recovers; integrity mismatch never enables; idle gate uses P0.7 signal.

## Milestone 1E: policy, limits, containers (outline)

**Create / modify:**
- Generalize `packages/kb/src/limits.ts` `effectiveLimits` over limit names; `dsh_plugin_limit`.
- `market_only` / `install_scripts` policies; npmrc `registry=` when market_only.
- `deploy/production/nftables/{dsh-public.nft,dsh-market.nft}`; provisioner `webPatch` + market volume; one-shot reconcile container (P0.5).
- README records market-range firewall exception (decided Q7).

**Acceptance:** market_only registry specs fail closed without egress_lock; container owner reach + cross-tenant deny; limits lowering never deletes data.

## Phase 2 (later; not in this plan's coding tasks)

Signatures; pure-skill views; optional `egress_lock`.

---

## Execution order

1. Complete Phase 0 tasks P0.1–P0.9; fill `phase0-results.md`. Stop if P0.8/P0.9 falsify assumptions.
2. Milestone 1A tasks in order.
3. Milestone 1B tasks in order (outline expanded 2026-10-23). Milestone 1C tasks in order (outline expanded 2026-10-23). Expand 1D–1E from outlines after 1C review.
4. Push `codex/plugin-market-impl` after each green task commit. Await「可以合并」before master.
