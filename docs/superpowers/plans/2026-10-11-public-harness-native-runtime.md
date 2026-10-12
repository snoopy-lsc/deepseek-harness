# Native Harness Runtime Implementation Plan

English | [中文](2026-10-11-public-harness-native-runtime.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a systemd provider that confines each user process tree and retains the existing container provider.

**Architecture:** A Cordis runtime service separates provisioning from backend execution. The systemd provider installs account, storage, AppArmor, quota and UID network enforcement before starting user code. The provisioner publishes only an authenticated, verified endpoint.

**Tech Stack:** TypeScript, Node ^22.19 || >=24, Cordis, Vitest, Ubuntu 24.04 LTS, systemd, cgroup v2, AppArmor, nftables, XFS.

**Spec:** [Approved native deployment design](../specs/2026-10-11-public-harness-native-design.md).

**Dependencies:** Can start first; [identity](2026-10-11-public-harness-native-identity.md) can develop independently. [Deployment](2026-10-11-public-harness-native-deployment.md) consumes both.

## Global Constraints

- File paths below are relative to `integrations/public-harness/`; `docs/` paths are relative to the repository root. Changes stay in independent plugins and profiles; Harness Session formats and `InstanceManager` remain unchanged.

- Use strict TypeScript, branded opaque IDs, ESM, documented exports, validated configurable deployment values, and `ctx.effect()` for lifecycle ownership. Launch every Node service through a `dsh` profile.

- Commands and assertions in this plan describe planned checks and expected results, not completed deployment evidence. Focused commands run from the repository root; build the integration before testing built imports.

- Native mode requires no container engine, OCI image, gVisor or user-manager linger. macOS/Windows retain loopback-only development mode; native enforcement requires a dedicated Linux host.

## Review Focus

- Legacy or damaged state: tag valid v1 records as container; reject corruption and backend mismatch (Task 1).
- A user swaps a path for a symlink: root never follows it into user data or another account (Task 2).
- IPv6, established sockets or unrelated host firewall rules: policy denies forbidden destinations and preserves host rules (Task 3).
- Concurrent starts, false readiness or uncertain process state: no duplicate instance or routable unverified endpoint (Task 4).
- Failed cleanup or descendants surviving stop: revoke access and quarantine UID/ports instead of reusing them (Task 4).

---

### Task 1: Runtime service and durable backend selection

**Files:** Create `packages/contracts/src/runtime.ts`, `packages/provisioner/src/runtime-provider.ts`, `packages/contracts/tests/runtime.spec.ts`; modify contracts `src/index.ts`, provisioner `src/{config,state,users,service,reconcile}.ts`, `tests/{config,provisioning,reconcile}.spec.ts`, package README pairs and `docs/upgrade-guide/v0.2.1-alpha.2/public-harness-backends/guide.md` with its Chinese pair and record.

**Interfaces:** Define the following in contracts; `InstanceId`, `UnitName` and `ContainerName` use `Branded` and validated parsers. `InstanceId` accepts `^[A-Za-z0-9_-]{1,128}$`; `ContainerName` accepts the existing derived account-name pattern. `UnitName` accepts only server-derived `dsh-user-<24 lowercase hex>.service` names.

```text
RuntimeKind = 'systemd' | 'podman-gvisor'
RuntimeState = 'running' | 'stopped' | 'unknown'
RuntimeRef = { kind: 'systemd'; unit: UnitName } | { kind: 'podman-gvisor'; container: ContainerName }
RuntimeInstance = { userId: UserId; instanceId: InstanceId; runtime: RuntimeRef;
  account: string; uid: number; gid: number; home: string; workspace: string;
  cache: string; tmp: string; controlDir: string; webPort: number; quotaPort: number }
InstanceRuntime = {
  kind: RuntimeKind;
  prepare(instance: RuntimeInstance): Promise<void>;
  initializeWorkspace(instance: RuntimeInstance): Promise<void>;
  start(instance: RuntimeInstance): Promise<InstanceEndpoint>;
  launchGrant(instance: RuntimeInstance): Promise<string>;
  stop(instance: RuntimeInstance): Promise<void>;
  state(instance: RuntimeInstance): Promise<RuntimeState>;
}
Context.instanceRuntime: InstanceRuntime
UserStateV2 = Omit<UserState, 'version' | 'lifecycle'> & { version: 2; runtime: RuntimeRef;
  instance: RuntimeInstance | null; lifecycle: UserState['lifecycle'] | 'quarantined';
  acquired: ('account' | 'storage' | 'policy' | 'network' | 'quota' | 'unit' | 'forwarder')[] }
```

- [ ] **1. Write failing tests:** `legacy_records_keep_container_backend` asserts `migrateUserState(v1).runtime.kind === "podman-gvisor"`; `backend_mismatch_refuses_start` asserts rejection and zero runner calls; malformed/unknown versions reject without rewriting the original file. `capacity_refusal_allocates_nothing` asserts no account/unit for a verified user beyond capacity. Existing container lifecycle tests still pass.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- runtime.spec.ts config.spec.ts provisioning.spec.ts reconcile.spec.ts`; expect missing new interfaces or failed migration assertions.

- [ ] **3. Implement** `migrateUserState(value: unknown): UserStateV2` in `state.ts`, an explicit tagged config parser, and a container adapter for `InstanceRuntime` registered through a Cordis `apply` provider with disposable service ownership. Reject duplicate providers. Persist backend reference, launch ID, allocated endpoints and a `quarantined` lifecycle in v2; record each acquired resource before proceeding. Keep existing v1 readers/schema history available for migration review. The provisioner consumes the injected service; no provider imports or implicit backend transfer.

- [ ] **4. Verify** the focused tests and integration `typecheck`; expect pass. Update JSDoc, README pairs and the upgrade guide with offline transfer preconditions; commit `refactor: introduce explicit public Harness runtime providers`.

### Task 2: Native accounts, storage and confined units

**Files:** Create `packages/runtime-systemd/{package.json,tsconfig.build.json,README.md,README.zh.md}`, `src/{config,accounts,storage,units,apparmor,limits}.ts`, `tests/{host-policy,storage}.spec.ts`; modify integration lockfile and provisioner `src/{accounts,storage,users}.ts` for provider-specific account home and storage.

**Interfaces:** Produce `parseSystemdConfig(value: unknown): SystemdConfig`, `ensureNativeAccount(userId: UserId, config: SystemdConfig, runner: CommandRunner): Promise<AccountIdentity>`, `prepareHost(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`, `renderUnit(instance: RuntimeInstance, config: SystemdConfig): string`, and `renderAppArmor(instance: RuntimeInstance, config: SystemdConfig): string`. `SystemdConfig` owns absolute tool/release/control/data paths, CPU/memory/PID/nofile/byte/inode limits, resolver/public-egress rules, port ranges and operation/readiness timeouts; reject unknown fields, overlapping ranges and writable release assets.

- [ ] **1. Write failing tests:** `account_requires_no_linger` asserts no `loginctl` invocation; `symlink_cannot_redirect_root_write` asserts victim bytes/owner unchanged and preparation rejection. `unit_confines_descendants` asserts system `User`/`Group`, enforcing AppArmor profile, empty capabilities, `NoNewPrivileges`, whole-cgroup stop, protected proc and no delegation; all writable paths have byte/inode or charged memory limits.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- host-policy.spec.ts storage.spec.ts`; expect missing provider files or failed policy assertions.

- [ ] **3. Implement** the declared host functions using the existing `CommandRunner` through explicit dependencies. Account passwords remain locked with nologin and no admin/SSH access. Keep management ancestors root-owned, create top-level user directories through no-follow file descriptors, and never recursively chown/chmod user trees. Separate root control from user token files. AppArmor child execution inherits confinement, denies foreign files and management sockets, and keeps Node JIT, PTYs, compilers and headless browsers usable.

- [ ] **4. Verify** focused tests and integration `typecheck`; expect pass. Document policy limitations and the dedicated Linux validation prerequisite in the README pair; commit `feat: prepare confined systemd Harness accounts`.

### Task 3: UID networking and observed enforcement

**Files:** Create runtime-systemd `src/{network,probe}.ts`, `tests/{network,probe}.spec.ts`; modify its `config.ts` and README pair.

**Interfaces:** Produce `installNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`, `removeNetwork(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`, and `verifyEnforcement(instance: RuntimeInstance, config: SystemdConfig, runner: CommandRunner): Promise<void>`. The latter rejects disabled/complain/missing AppArmor, missing cgroup controllers or effective limits, and inactive disk/inode quotas; successful command exit alone is insufficient.

- [ ] **1. Write failing tests:** `foreign_loopback_and_ipv6_are_denied` asserts another account cannot connect to any of the user's loopback listeners while the owner can reach every own loopback port; `established_flow_does_not_bypass_uid_policy` rejects forbidden existing flows; `atomic_update_preserves_host_rules` leaves unrelated tables unchanged on success/failure. `disabled_enforcement_refuses_prepare` asserts rejection before any user process starts for each missing mandatory protection, including a loaded main profile that still permits `userns`, `kernel.apparmor_restrict_unprivileged_userns` other than 1, and a missing browser child profile.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- network.spec.ts probe.spec.ts`; expect missing functions or failed enforcement assertions.

- [ ] **3. Implement** atomic changes in an owned nftables table with UID restrictions before generic connection-state accepts. Owner-only loopback: the output hook sets `ct mark` to `meta skuid` on new loopback connections; the input hook drops new connections to sockets in the user's unit cgroup (`socket cgroupv2 level N`) whose mark differs from the user's UID, so any loopback port works for the owner only. Load the per-user rules after the unit cgroup exists and before user code starts, and remove them on stop. Deny host/private/link-local/metadata destinations, unapproved IPv4/IPv6 and external direct ingress to any user listener; allow only configured DNS/public egress and own Web/quota ports. Probe kernel and mounted-filesystem enforcement, not just rendered settings.

- [ ] **4. Verify** focused tests and `typecheck`; expect pass. Record UDS protection as filesystem/AppArmor responsibility and document quarantine after cleanup failure; commit `feat: enforce native per-user network and resource policy`.

### Task 4: Native runtime lifecycle and readiness

**Files:** Create runtime-systemd `src/{index,runtime}.ts`, `tests/lifecycle.spec.ts`; modify provisioner `src/{users,service,reconcile,token-channel,forwarder}.ts`, production `src/provisioner-service.ts`, their lifecycle tests and README pairs.

**Interfaces:** Produce `createSystemdRuntime(config: SystemdConfig, deps: SystemdRuntimeDeps): InstanceRuntime` and Cordis `apply(ctx: Context, config: { configFile: string }): Promise<void>`. `SystemdRuntimeDeps` supplies the existing `CommandRunner`, `QuotaBridge` and an authenticated Web probe `(instance: RuntimeInstance, grant: string) => Promise<boolean>`; migrate quota instance IDs to the shared brand at every consumer. Register `ctx.instanceRuntime`; provisioner injection requires it.

- [ ] **1. Write failing tests:** `parallel_ensure_starts_once` asserts one unit/account/grant; `spoofed_ready_never_publishes` rejects mismatched launch ID/port and unauthenticated Web readiness. `unknown_state_withholds_route` returns no endpoint; `failed_stop_quarantines_allocation` retains reserved UID/ports, revokes quota and closes forwarding. `workspace_hooks_run_only_confined` asserts initialization occurs after policies and inside the unit.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- lifecycle.spec.ts runtime.spec.ts provisioning.spec.ts reconcile.spec.ts`; expect the native cases to fail.

- [ ] **3. Implement** ordered prepare → confined Git initialization → quota grant → Web start → effective enforcement/authenticated readiness → publication. Reuse the private Unix forwarder targeting only the recorded port. Stop/reconcile consult systemd and cgroup membership; suspend first denies routing, revokes grants and forwarding, blocks new UID connections, then kills descendants; remove network allocations only after verifying complete cleanup. Retain private data on idle stop; deletion requires confirmation/recovery expiry and verified cleanup before account/port release. Retry partial starts from durable resource records.

- [ ] **4. Verify** focused tests, integration build/typecheck and existing real Web e2e; expect pass. Apply the CI reliability skill to injected clocks, exclusive port leases and teardown. Commit `feat: integrate recoverable native Harness lifecycle`; leave Linux/public readiness to deployment Task 3.
