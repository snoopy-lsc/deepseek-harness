# Public Harness Model Quota Implementation Plan

English | [中文](2026-10-10-public-harness-quota.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each public user a bounded share of the platform's model API without placing the platform key in a Harness container.

**Architecture:** A separate quota service terminates per-user credentials, reserves personal and site token capacity in a durable single-server ledger, and forwards only approved DeepSeek Messages operations to a pinned upstream. A Web-profile Cordis provider reads a rotated per-user credential from a private file on each model call. The provisioner delivers that file and never sees the platform key.

**Tech Stack:** TypeScript, Node 22.19+ or 24+, SQLite transactions, DeepSeek Messages API, Cordis LLM registration, Vitest.

**Spec:** [Public multi-user Harness design](../specs/2026-10-10-public-team-harness-design.md).

**Prerequisite:** Runtime plan Tasks 1–2 provide the shared user-ID type and the provisioner control socket. [Runtime plan](2026-10-10-public-harness-runtime.md).

## Global Constraints

- Code lives in `integrations/public-harness/`; the quota service runs from its own `dsh` profile and the user-side provider is an installable Cordis bundle.
- The platform key is available only to the quota service. A container gets a user- and instance-bound credential valid for at most 15 minutes; a private mounted file is rotated before expiry.
- Positive configurable personal and site daily token budgets and concurrency limits are required. Ledger failure, unknown request operations, and missing safe reservation bounds fail closed.
- Both successful and interrupted streams settle once; missing final usage consumes the reservation. No request forwards without durable reservation.
- The service accepts only the configured upstream origin and explicitly supported Messages and Files paths; redirects are rejected.
- Paths in task file lists are relative to `integrations/public-harness/` unless they include that prefix.

## Review Focus

- Concurrent users racing for the last site tokens cannot both reserve them; Task 1 pins atomic accounting.
- A malformed or oversized request cannot claim a tiny reservation then spend more; Task 2 pins bounded parsing and conservative admission.
- A client disconnect before final usage cannot release the full reservation; Task 3 pins cancellation settlement.
- A stale token, token for another instance, or unknown path cannot access the platform key; Task 2 pins denial.
- A user-supplied URL or upstream redirect cannot receive the platform key; Task 3 pins origin and redirect handling.

---

### Task 1: Durable Quota Ledger

**Files:** Create `integrations/public-harness/packages/quota/src/ledger.ts`, `config.ts`, `tests/ledger.spec.ts`, and its README pair and package manifest.

**Interfaces:** `reserve(userId: UserId, maximumTokens: number): Promise<Reservation>` atomically counts both daily ledgers and in-flight requests; `settle(id: ReservationId, actualTokens?: number): Promise<void>` charges actual usage when present and otherwise the reservation; `cancel` is `settle` without actual usage. `ReservationId` is opaque and settlement is idempotent.

- [ ] **Step 1: Write failing tests** for concurrent last-token admission, personal and site exhaustion, per-user and site concurrency, day rollover with pending calls, duplicate settlement, process restart, and storage failure.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- ledger.spec.ts`; expect failure.
- [ ] **Step 3: Implement** SQLite transaction-based reservations, positive configuration validation, durable in-flight records, and restart reconciliation that charges unresolved reservations.
- [ ] **Step 4: Run** the focused test; expect pass, then commit the ledger and README pair.

### Task 2: Private Credential and Request Admission

**Files:** Create `packages/quota/src/tokens.ts`, `admission.ts`, `tests/admission.spec.ts`, and `packages/quota-provider/src/index.ts` with its Web-profile bundle and tests.

**Interfaces:** The quota control socket exposes `issue(userId, instanceId): Promise<{ token: string; expiresAt: number }>` only to the provisioner. The user-side provider registers DeepSeek through the public `registerDeepSeekProvider` and resolves authentication from the private rotating file on each call. `admit(request): Promise<{ userId; reservation }>` validates token, operation, model, body limit, and reserves the configured model context-window maximum plus the requested `max_tokens`; models without a configured context window are rejected.

- [ ] **Step 1: Write failing tests** for expired/cross-instance tokens, wrong issuer or signature, body and image limits, missing `max_tokens`, unsupported model or endpoint, changed credential file, and a request without a safe bound.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- admission.spec.ts`; expect failure.
- [ ] **Step 3: Implement** token issuance and rotation, strict endpoint allowlist, bounded Messages parsing, model-specific conservative reservations, and Cordis provider wiring.
- [ ] **Step 4: Run** the focused tests; expect pass, then commit the admission and provider bundle.

### Task 3: Metered Messages and File Operations

**Files:** Create `packages/quota/src/messages.ts`, `files.ts`, `server.ts`, `tests/stream.spec.ts`, and `tests/files.spec.ts`.

**Interfaces:** `forwardMessages(request, reservation): Promise<Response>` streams provider bytes without buffering the full response, records provider usage, and settles once. File upload, list, and delete paths use per-user ownership records and explicit size/count limits; unsupported operations return an error before upstream access.

- [ ] **Step 1: Write failing tests** for final usage, missing usage, disconnect, upstream error, retry, malformed SSE, forged file IDs, upload limits, upstream redirects, and attempted arbitrary-origin forwarding.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- stream.spec.ts files.spec.ts`; expect failure.
- [ ] **Step 3: Implement** bounded streaming, once-only settlement, pinned-origin upstream access with platform authentication, file ownership, and fail-closed error paths.
- [ ] **Step 4: Run** the focused tests and a real-provider e2e with a test key when available; record the actual command and result, then commit.

### Task 4: Limits and Failure Visibility

**Files:** Create `packages/quota/src/health.ts`, `tests/health.spec.ts`, and deployment configuration under `deploy/`.

**Interfaces:** A private health/status endpoint reports ledger availability, aggregate capacity, and rejection category without user IDs, prompts, tokens, or credentials. Public model errors reveal only quota or service-unavailable categories.

- [ ] **Step 1: Write failing tests** for exhausted quota, failed ledger, unavailable upstream, secret redaction, and positive required deployment limits.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- health.spec.ts`; expect failure.
- [ ] **Step 3: Implement** status reporting, sanitized diagnostics, and startup configuration checks.
- [ ] **Step 4: Run** the focused test plus a built-profile smoke; expect pass, then commit.
