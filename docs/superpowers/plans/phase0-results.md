# Phase 0 results — company plugin market

English | [中文](phase0-results.zh.md)

Record of verification spikes from [2026-10-23-plugin-market](2026-10-23-plugin-market.md). Environment: Grok Bot box (uid 1000, no root systemd socket units, no production nft, no pasta/runsc). Dates in Asia/Taipei. Toolchain: Node 22.23.3, `/home/box/.local/pnpm11/bin/pnpm` → **11.7.0** (workspace lockfile also references 11.28.5 as the repo pin).

## P0.1 Second `--patch` and Settings overrides

**Status:** done (static + code-path substitute; full `dsh` profile boot not required)

**Findings:**
- Layer order in `apps/cli/src/dump-config.ts` `collectConfigDumpLayers` / `apps/cli/src/profile-boot.ts`: bundle layers → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays (argv order). **`--patch` wins.**
- Settings updates (`packages/boot/plugin-market` `settings.update(this.entryId, { indexes })`) write the profile user layer, which loses to the market overlay on every start.
- Same ordering applies to plugin-manager registry rows if they live in the profile patch.

**Pass criteria:** met (winner documented). Full CLI boot of insert rows deferred to 1B fixture tests.

## P0.2 pnpm 11 against a loopback registry

**Status:** done (static fixture registry on `127.0.0.1`)

**Findings:**
- Minimal Node registry serving `@corp-dsh/tiny@1.0.0` works with project `.npmrc` scope mapping.
- **Lockfile embeds an absolute tarball URL including the port:**
  `resolution: {integrity: sha512-…, tarball: http://127.0.0.1:4873/@corp-dsh/tiny/-/….tgz}`
  This is **not** the “no tarball URL / port-stable” ideal. Content-addressed store reuse can satisfy `pnpm install` after a port change **only if the blob is already in the store**; a **fresh store** with the old-port lockfile **fails** (`ECONNREFUSED` on the locked tarball URL) even when `.npmrc` points at the new port.
- `NPM_CONFIG_GLOBALCONFIG` alone did not apply scope mapping (pnpm still hit registry.npmjs.org). Scope mapping belonged in the project/instance npmrc; auth via `--config.globalconfig=` is the right shape, but this spike’s token was **not** observed on the fixture server (`noauth` in access log)—recheck when the mirror enforces bearer auth.
- Implication for 1A/1B: prefer a **stable loopback identity** (fixed port per account, as designed) and/or lockfile rewrite on port remap; do not assume lockfiles survive port moves on cold stores.

**Pass criteria:** met with documented exception (tarball URL present for private registry).

## P0.3 `bundleDependencies` and `--allow-build`

**Status:** done

**Findings (pnpm 11.7.0):**
- Default install: `[ERR_PNPM_IGNORED_BUILDS]` — dependency lifecycle scripts do **not** run.
- `--config.dangerouslyAllowAllBuilds=true`: **parent** `postinstall` runs; **nested** `bundleDependencies` package scripts **do not** run under pnpm (only extracted as files).
- `npm install` of the same tarball runs **both** parent and nested bundled `postinstall`.
- `--allow-build=<name>` alone did not approve builds in this environment (approve-builds / allowBuilds config path needs the product’s exact knobs in 1A); `dangerouslyAllowAllBuilds` is the blunt control that worked here.
- **Design feed:** bundle mode under pnpm does **not** execute nested bundled scripts; fallback mode must still gate top-level package scripts via allowBuilds. Prefer bundle when the goal is to ship deps without running their scripts.

**Pass criteria:** met.

## P0.4 Reconcile transient unit flags

**Status:** partial — pnpm flags **done**; systemd slice / `IPAddressAllow` **blocked**

**Findings:**
- Hostile `.pnpmfile.cjs` (throws) fails `pnpm install` without flags; with `--ignore-pnpmfile --config.userconfig=/dev/null` install succeeds (exit 0).
- No root / no system systemd here → full `systemd-run` in instance slice with `IPAddressAllow=localhost` **blocked**. Substitute is the argv proof above; production still needs a privileged host check.

**Pass criteria:** substitute met; privileged part blocked.

## P0.5 Container pasta matching and one-shot reconcile

**Status:** partial — static **done**; live pasta/runsc **blocked**

**Findings:**
- Production README and `dsh-public.nft` already use `meta skuid` for instance traffic; native `network.ts` uses `ct mark set meta skuid` / `meta skuid vmap`. Quota reachability through pasta’s host-loopback is an existing assumption—market can reuse skuid identity.
- Provisioner always builds `pasta:--map-host-loopback,<addr>,--no-splice`.
- `assertSafeRunArgv` allowlists volumes, exact `--userns`, network string, publish range, `--read-only`, `--cap-drop all`. **`assertSafeReconcileArgv` draft:** same forbid-list; narrower volumes (workspace + market snapshot paths only); no publish; network still pasta with `--no-splice`; one-shot command allowlist (`pnpm`, `node` entry only)—expand in 1E.

**Pass criteria:** static met; live pasta blocked.

## P0.6 Git blob tarball vs `npm pack`

**Status:** done

**Findings:**
- `npm pack` honors `files` / `.npmignore` (omitted `.secret-should-omit`, `.npmignore`, `.gitignore`).
- `git archive HEAD` includes the whole tree (secret + ignore files present).
- **Gap the mirror must close:** blob/git export is **not** npm-pack equivalent; implement pack semantics (`files` / `.npmignore` / npm defaults) when building from git, or shell out to `npm pack` in a clean worktree.

**Pass criteria:** met (gaps documented).

## P0.7 Idle signal and `installBundle({ enabled: false })`

**Status:** done (code-path; no full HMR harness run)

**Findings:**
- `installBundle` (`packages/boot/plugin-manager/src/index.ts`): `if (options?.enabled !== false) await this.selectBundle(name, true)` — with `enabled: false` the bundle is **not** selected; reload only publishes selected rows.
- `setBundleEnabled(name, true)` selects and reloads.
- Idle signal shortlist: agent `status: 'idle'` (used across plan-mode / subagent / workflow). Prefer gating sync on agent idle (and the design’s ~5 minute window), not `idleWatchdog` (that is LLM stream idle).

**Pass criteria:** met for in-process behaviour; optional upstream `installBundle` precondition still nice-to-have.

## P0.8 Socket unit cgroup and `dsh_market` loader

**Status:** **blocked** (needs root + systemd)

**Findings:**
- Box has cgroup v2 (`/sys/fs/cgroup`) but cannot install system socket units.
- No live measurement of `init.scope` vs `system.slice/dsh-plugins.socket`.
- **Does not falsify design** — deferred to a privileged host. Do not code the loader’s cgroup path as final until that host check lands; keep both candidates in the 1B template notes.

**Pass criteria:** blocked with substitute note only.

## P0.9 `inet_diag` peer check from unprivileged service

**Status:** partial — `/proc/net/tcp` **done**; exact `inet_diag` four-tuple **needs correct request packing** (not a design falsification)

**Findings:**
- Unprivileged process can `socket(AF_NETLINK, SOCK_RAW, NETLINK_SOCK_DIAG)` successfully.
- First-cut four-tuple request returned `NLMSG_ERROR` errno **-2 (ENOENT)** — packing/byte-order of `inet_diag_sockid` still wrong; **not** evidence that inet_diag is unavailable.
- `/proc/net/tcp` fallback: **works** on loopback; ~**855 µs/lookup** mean over 200 accepts (fixture `docs/superpowers/plans/fixtures/p0-peer-check/proc-fallback.mjs`). Same-uid peer observed as expected.
- Pasta path: **blocked** (no pasta). Quota already relies on skuid; peer check remains defense in depth.
- **No silent isolation downgrade:** 1B should land a correct inet_diag implementation with tests; keep `/proc/net/tcp` as the documented fallback. Do **not** change the design conclusion.

**Pass criteria:** fallback verified; inet_diag openable; exact lookup follow-up in 1B. Not a stop-the-line falsification.

---

## Summary for milestone planning

| Item | Result | Blocks 1A? |
|------|--------|------------|
| P0.1 | `--patch` wins over Settings | No |
| P0.2 | Lockfile may embed tarball+port | Informs mirror/lock strategy |
| P0.3 | pnpm ignores builds by default; nested bundled scripts do not run | Informs bundle vs fallback |
| P0.4 | pnpm ignore flags OK; systemd blocked | No for 1A |
| P0.5 | skuid/pasta assumed OK; live blocked | No for 1A |
| P0.6 | Must apply npm pack semantics to git | Informs mirror |
| P0.7 | `enabled:false` + agent idle OK | No |
| P0.8 | cgroup **blocked** | Blocks **final** 1B loader path only |
| P0.9 | `/proc` OK; inet_diag packing TBD | Does not block 1A |

**Next:** start Milestone 1A TDD on `integrations/public-harness/packages/plugins/` after review. Privileged P0.8 (+ pasta P0.5/P0.9) on a production-like host before locking 1B firewall templates.
