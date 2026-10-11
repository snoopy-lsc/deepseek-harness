# Native Harness Deployment Implementation Plan

English | [中文](2026-10-11-public-harness-native-deployment.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the native service and keep public admission closed until real-host evidence approves the exact release.

**Architecture:** Native profiles compose the runtime and identity providers without container requirements. Release manifests and enforcement evidence are backend-specific. A dedicated Linux rehearsal owns functional, adversarial and recovery verification.

**Tech Stack:** TypeScript, Cordis profiles, Caddy HTTPS, systemd, AppArmor, nftables, XFS, Vitest.

**Spec:** [Approved native deployment design](../specs/2026-10-11-public-harness-native-design.md).

**Dependencies:** Execute after [runtime](2026-10-11-public-harness-native-runtime.md) and [identity](2026-10-11-public-harness-native-identity.md). Local development completes Tasks 1–2; Task 3 requires a dedicated Linux test host.

## Global Constraints

- File paths below are relative to `integrations/public-harness/`; `docs/` paths are relative to the repository root. Changes stay in independent plugins and profiles; Harness Session formats and `InstanceManager` remain unchanged.

- Use strict TypeScript, branded opaque IDs, ESM, documented exports, validated configurable deployment values, and `ctx.effect()` for lifecycle ownership. Launch every Node service through a `dsh` profile.

- Commands and assertions in this plan describe planned checks and expected results, not completed deployment evidence. Focused commands run from the repository root; build the integration before testing built imports.

- Initial target: dedicated Ubuntu 24.04 LTS, cgroup v2, enforcing AppArmor, nftables and XFS byte/inode quotas. Native confinement shares the host kernel; neither local mocks nor container evidence approve it.

- Only Caddy is public. Router, identity and quota have separate service UIDs; the provisioner alone owns narrow root operations. No public preview publication or official model-page hiding is included.

## Review Focus

- Native selection on a host without Podman/runsc/images: configuration succeeds without container probes (Task 1).
- Complain AppArmor, wrong host/policy/backend or incomplete evidence: enrollment remains closed (Tasks 2–3).
- Upgrade interruption or backward schema incompatibility: preserve data and refuse unsafe rollback/transfer (Task 2).
- Backup omits identity state or includes platform credentials in user archives: reject or repair the backup (Tasks 2–3).
- Hostile public code attacks files, sockets, descendants, resources or the network: functional Linux checks must deny it (Task 3).

---

### Task 1: Native profiles and host configuration

**Files:** Create `deploy/native/{README.md,README.zh.md,Caddyfile}`, `config/{identity,router,provisioner}.json.example`, `systemd/{dsh-identity,dsh-router,dsh-quota,dsh-provisioner}.service`, `systemd/{sysusers.d,tmpfiles.d}/dsh-public.conf`, `scripts/host-preflight.ts`; create production `src/identity-service.ts`; modify `deploy/production-profile.ts`, production package exports, config parsing and `tests/deploy-config.spec.ts`.

**Interfaces:** Extend `writeProductionProfile` with explicit native composition and an `identity` profile; the provisioner profile mounts the selected runtime service before its consumer. Produce `preflightNativeHost(config: SystemdConfig): Promise<void>` using runtime observed probes. Native config requires Better Auth files, tools/policies/limits/endpoints; container config retains authentik/image/runsc fields only in its own tag.

- [ ] **1. Write failing tests:** `native_profile_omits_container_requirements` asserts a valid profile with no Podman/runsc/image and no engine runner call. `all_services_launch_through_dsh` checks profile entries; `private_services_are_not_public` asserts private sockets and separate UIDs. Caddy preserves exact origin/authority and does not let caller headers choose user identity or upstream.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- deploy-config.spec.ts production.spec.ts`; expect native composition assertions to fail.

- [ ] **3. Implement** tagged profile composition, separate trusted-service ownership/socket grants, root-owned read-only release assets and Caddy account/auth/user paths. Add preflight for supported host, controllers, loaded policies, quotas and destination rules. Supply sysusers/tmpfiles configuration in `deploy/native/systemd/`; keep registration closed by default and describe privileged installation as operator work.

- [ ] **4. Verify** focused tests, build/typecheck and built profile smokes; expect pass without container tooling. Update native README pairs with planned Linux validation steps, capacity reserves, host update and abuse-response responsibilities; commit `feat: compose native public Harness deployment profiles`.

### Task 2: Evidence, backup and safe upgrades

**Files:** Modify `deploy/{release-check,upgrade,dshctl}.ts`, `tests/{release-check,upgrade}.spec.ts`; create `deploy/native/scripts/{backup,restore}.ts`; modify native README pairs and the backend upgrade guide.

**Interfaces:** Define `RuntimeRelease = { kind: "systemd"; policyDigest: string; toolchainDigest: string } | { kind: "podman-gvisor"; image: string }`; v2 `ReleaseManifest` uses this tag and preserves Harness/plugin pins, prior release and closed enrollment. Define `NativeEvidence = { schema: 1; backend: "systemd"; hostId: NativeHostId; release: string; policyDigest: string; toolchainDigest: string; architecture: string; kernel: string; checks: Record<NativeCheck, "passed" | "failed">; verifiedAt: number }`; `NativeHostId` is branded and derives from root-controlled host identity; `NativeCheck` enumerates deployment Task 3 checks. Produce `validateNativeEvidence(manifest: ReleaseManifest, evidence: NativeEvidence, hostId: NativeHostId): void`; require every check and bind evidence to effective host/toolchain/policy.

- [ ] **1. Write failing tests:** `container_evidence_cannot_open_native_enrollment`, `stale_or_wrong_policy_stays_closed` and `missing_check_stays_closed` assert refusal. `legacy_manifest_is_container_only` preserves v1 pins. `interrupted_upgrade_keeps_user_data` retains Sessions/workspaces; `restore_requires_identity_database` rejects incomplete backups; `restore_rejects_archive_paths` leaves outside files unchanged for traversal/symlink entries; incompatible identity/state migrations reject code-only rollback.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- release-check.spec.ts upgrade.spec.ts`; expect new manifest/evidence assertions to fail.

- [ ] **3. Implement** versioned strict parsers and a backend-specific admission validator with configurable evidence age. Invalidate approval after host/policy/toolchain/release change. Back up identity SQLite consistently together with provisioning/quota state and private user data, while separating trusted secrets from user archives. Offline backend transfer requires backup, full stop, restore/rehearsal and explicit operator selection; no implicit live movement. Canary login/model/PTY/session/plugin flows precede rollout.

- [ ] **4. Verify** focused tests, build/typecheck and restore fixtures; expect pass. Document migration compatibility and deletion recovery, update the upgrade guide and commit `feat: gate native releases on backend-specific evidence`.

### Task 3: Dedicated Linux rehearsal and public admission

**Files:** Create `tests/native-linux.e2e.ts`, `tests/native-linux-fixture.ts`, `vitest.native.config.ts`, `deploy/native/scripts/rehearse.ts`; modify integration scripts, native README pairs and release-check tests.

**Interfaces:** Produce `runNativeRehearsal(configFile: string): Promise<NativeEvidence>` and an explicit `test:native` script. Use dedicated destructive-test accounts and owned firewall tables/paths/ports; record cleanup failures and quarantine. Ordinary local tests skip the real-host suite; release validation rejects skipped checks. Never run this suite against the developer Mac or an arbitrary shared Linux host.

- [ ] **1. Write failing tests** for admission rejecting simulated/skipped evidence, then write real-host cases producing the following `NativeCheck` values. Each case checks the observable allowed or denied operation, not configuration text alone.

| Check | Required observed result |
| --- | --- |
| `tools` | Two users register/login and run real model, shell, PTY, Git, dependency install, language server, browser, child-agent and extension flows; quotas bill the correct user. |
| `files` | Foreign home/secrets, symlink/path-swap and UDS management access are denied. |
| `processes` | Cross-user proc/signal, setuid/capability escalation, cgroup escape and plugin policy removal are denied; all descendants stop. |
| `network` | Foreign loopback, host/private/metadata, unapproved IPv6, existing forbidden connections and external arbitrary listeners are denied; configured public DNS/egress and own endpoints work. |
| `resources` | Real CPU, memory, PID, byte and inode exhaustion stays within limits without affecting the other user's instance. |
| `recovery` | Reboot, parallel wake, partial provisioning, false readiness, unknown systemd state and failed cleanup retain data and withhold unsafe routes/allocations. |
| `failures` | Disabled/complain/missing AppArmor, controllers, quotas, identity/accounting databases or quota service close admission; existing authenticated channels are revoked as specified. |
| `upgrade-restore` | Backup/restore, canary upgrade and supported rollback retain identity, Sessions, Git and credentials; incompatible migration or incomplete backup is refused. |

- [ ] **2. Run** local release-check tests first; expect missing/skipped checks to fail approval. On an available dedicated Ubuntu host, run the new `test:native` command; expect the incomplete native behavior to fail. If no host exists, report this task pending and keep public admission closed.

- [ ] **3. Implement** the opt-in fixture/evidence writer and fix demonstrated provider/policy defects without weakening mandatory protections. Bind evidence to observed host identity, architecture/kernel, policy/toolchain/release digests and timestamps. Add public-service security review of the actual policy and test results before allowing admission.

- [ ] **4. Verify** every real-host check passes, restore succeeds and approval refuses one deliberately invalid evidence fixture; record exact commands/results in the operational owner. Run relevant doc/build checks and a whole-branch review, then commit `test: verify native public Harness enforcement on Linux`. Open registration only for the approved host/release; absent evidence remains a deployment limitation.
