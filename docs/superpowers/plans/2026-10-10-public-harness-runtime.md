# Public Harness Runtime Implementation Plan

English | [中文](2026-10-10-public-harness-runtime.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run real per-user Harness Web processes on macOS and Windows development hosts, and confined per-user instances on one Linux production server.

**Architecture:** The router consumes one Cordis `InstanceManager` service. Its development provider starts loopback-only child processes with separate user homes; its production provider calls a privileged provisioner through a protected Unix socket. The provisioner derives host account and storage names from an opaque authentik user ID, starts gVisor containers, and exposes user-specific Unix-socket endpoints.

**Tech Stack:** TypeScript, Node 22.19+ or 24+, Cordis profiles, macOS and Windows child processes, Linux systemd, rootless Podman, OCI, gVisor `runsc`, Vitest.

**Spec:** [Public multi-user Harness design](../specs/2026-10-10-public-team-harness-design.md).

**Execution order:** Complete Tasks 1–2, then the [quota plan](2026-10-10-public-harness-quota.md) and local router/UI work; Linux Tasks 3–5 follow on a real Linux host.

## Global Constraints

- Runtime code lives in the independently versioned `integrations/public-harness/` project; no Harness agent-loop, Session, or core Web edits.
- Explicit development mode is loopback-only on macOS and Windows, uses fixed test identities and separate child-process homes, and never claims host security isolation.
- Each user gets one non-login Linux service account, one rootless Podman container using gVisor `runsc`, private `DSH_HOME` and Git workspaces, and mandatory CPU, memory, process, disk, and network limits.
- The container has no management socket, platform model key, or other user's mount. Provisioning refuses to start if gVisor or a mandatory limit is absent.
- Only `dsh --profile web` starts a user's Harness; the provisioner itself runs from its own `dsh` profile.
- The provisioner accepts only validated opaque user IDs and fixed operations; account names, paths, images, and unit names are derived server-side.
- Paths in task file lists are relative to `integrations/public-harness/` unless they include that prefix.

## Review Focus

- A user ID containing separators or Unicode lookalikes must never choose a host path or account name; Task 1 pins the rejection.
- Two first requests for the same user must create exactly one account and instance; Task 3 pins the lock and recovery behavior.
- A half-created account or directory after power loss must be reconciled without publishing a routable endpoint; Task 3 pins this.
- A missing gVisor runtime or unenforced resource limit must fail before container start; Task 4 pins this.
- After account suspension, an old socket must not remain routable and stored data must remain private; Task 5 pins this.
- A development bind outside loopback or production mode on macOS/Windows must fail before any child starts; Task 2 pins this.

---

### Task 1: Instance Manager and Fixed Provisioner Protocol

**Files:** Create `integrations/public-harness/package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `packages/contracts/src/index.ts`, `packages/provisioner/src/protocol.ts`, `packages/contracts/tests/instance-manager.spec.ts`, and `packages/provisioner/tests/protocol.spec.ts`; add package manifests and a project README pair.

**Interfaces:** Produce branded `UserId`, `parseUserId(value: string): UserId` accepting only `^[A-Za-z0-9_-]{1,128}$`, and Cordis `InstanceManager` with `ensure(userId): Promise<InstanceEndpoint>`, `launchGrant(userId): Promise<string>`, and `stop(userId): Promise<void>`. `InstanceEndpoint` is `{ kind: 'unix'; path: string } | { kind: 'tcp'; host: '127.0.0.1'; port: number }`. The production provider uses a `ProvisionerClient` with fixed `ensure`, `launch-grant`, `stop`, and `status` wire tags. The router consumes `InstanceManager`.

- [ ] **Step 1: Write failing tests** for both endpoint tags, canonical user IDs, rejected separators and lookalikes, unknown fields and operation tags, socket permissions, and response size limits.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- instance-manager.spec.ts protocol.spec.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement** the Cordis service definition, branded parser, endpoint schema, and Unix-socket client/server framing with bounded messages and explicit errors.
- [ ] **Step 4: Run** the same focused test; expect it to pass, then commit the protocol and README pair.

### Task 2: macOS and Windows Development Runtime

**Files:** Create `packages/dev-runtime/src/index.ts`, `processes.ts`, `config.ts`, and `tests/dev-runtime.spec.ts`; create `packages/web-token/src/index.ts`, `tests/web-token.spec.ts`, and its bundle; add package manifests and README pairs.

**Interfaces:** The development provider implements `InstanceManager` using one real `dsh --profile web` child per fixed test identity, a private `DSH_HOME` and Git workspace for each child, and a loopback TCP `InstanceEndpoint`. It obtains the launch grant through a private parent-child channel; `printUrl: false` and `--no-open` prevent token display.

- [ ] **Step 1: Write failing tests** for two child homes, real shell and terminal access, launch-grant secrecy, restart with retained Session data, rejection of non-loopback binds, and rejection of production mode on macOS/Windows.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- dev-runtime.spec.ts web-token.spec.ts`; expect failure.
- [ ] **Step 3: Implement** portable process launch and teardown with Node path APIs, per-user directory mapping, loopback binding, startup readiness, and the shared Web token bundle.
- [ ] **Step 4: Run** the focused test on macOS and Windows plus a two-real-Web-process browser flow; expect pass, then commit.

### Task 3: Idempotent Linux User Provisioning

**Files:** Create `packages/provisioner/src/accounts.ts`, `storage.ts`, `state.ts`, and `tests/provisioning.spec.ts` beneath the project.

**Interfaces:** Produce `ensureUser(userId: UserId): Promise<UserRecord>` and `stopUser(userId: UserId): Promise<void>`. `UserRecord` contains only derived account name, private storage paths, and lifecycle state; no caller-supplied path enters it.

- [ ] **Step 1: Write failing tests** for concurrent `ensureUser`, interrupted setup and retry, wrong existing directory owner, suspended users, and capacity refusal without a new account.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- provisioning.spec.ts`; expect failure.
- [ ] **Step 3: Implement** per-user locking, durable lifecycle records, derived account names, restrictive directory creation, ownership checks, and rollback of unpublished partial work.
- [ ] **Step 4: Run** the focused test; expect pass, then commit the provisioning state machine.

### Task 4: Confined Container and Web Endpoint

**Files:** Create `packages/provisioner-client/src/index.ts`, `packages/provisioner/src/runtime.ts`, `limits.ts`, `token-channel.ts`, `tests/runtime.spec.ts`, and Linux integration fixtures; reuse the Web token bundle created in Task 2.

**Interfaces:** Produce `Runtime.start(record: UserRecord): Promise<InstanceEndpoint>`, `Runtime.stop(record): Promise<void>`, and `launchGrant(userId)` from Task 1. The production `InstanceManager` provider calls this runtime through `ProvisionerClient`. The Web token plugin reads `ctx.connection.authenticatedUrl()` and sends the launch token only through a private supervisor channel; normal token URL printing is disabled.

- [ ] **Step 1: Write failing tests** for absent gVisor, each missing limit, forbidden mounts, blocked access to peer containers and host-private addresses, unavailable quota proxy, token-channel secrecy, readiness timeout, and the exact Web-profile launch argv.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- runtime.spec.ts`; expect failure.
- [ ] **Step 3: Implement** rootless Podman with `runsc`, per-account execution, private network and bounded egress, host socket forwarder, health check, token channel, and fail-closed limit validation; stop the task if this runtime combination cannot enforce the spec on Linux.
- [ ] **Step 4: Run** the focused test; expect pass. On a Linux host run the integration fixture with a real `dsh --profile web`, shell tool, terminal, and Git workspace; commit only after that result is recorded.

### Task 5: Suspend, Restart, and Recovery

**Files:** Create `packages/provisioner/src/reconcile.ts`, `tests/reconcile.spec.ts`, and the systemd unit and backup/restore runbook under `deploy/`.

**Interfaces:** `reconcile(): Promise<void>` restores only validated records; `suspend(userId): Promise<void>` stops the container and revokes its routing socket. Deletion is a separate, recovery-period-gated operation.

- [ ] **Step 1: Write failing tests** for host reboot, stale socket, idle wake, suspension, reactivation, and deletion before the configured recovery period.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- reconcile.spec.ts`; expect failure.
- [ ] **Step 3: Implement** reconciliation, socket revocation, stop/wake behavior, and delayed deletion; keep account data after ordinary stop.
- [ ] **Step 4: Run** the focused test and Linux reboot/backup restore exercise; expect correct user isolation, then commit.
