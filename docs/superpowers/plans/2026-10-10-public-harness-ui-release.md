# Public Harness UI and Release Implementation Plan

English | [中文](2026-10-10-public-harness-ui-release.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one branded browser experience on macOS/Windows development servers and Linux production, then release public registration only after real Linux checks pass.

**Architecture:** An installable browser Cordis bundle fills the published brand and navigation slots in each user's Web profile. The `team-dev` profile combines loopback router, local identity, local runtime, and quota service on macOS and Windows; production uses authentik with matching branding. A deployment manifest pins bundle versions and keeps public enrollment disabled until a recorded Linux rehearsal passes.

**Tech Stack:** TypeScript, React, Cordis client slots, CSS tokens, authentik, Caddy, Playwright, Git, systemd.

**Spec:** [Public multi-user Harness design](../specs/2026-10-10-public-team-harness-design.md).

**Prerequisite:** The [runtime](2026-10-10-public-harness-runtime.md), [quota](2026-10-10-public-harness-quota.md), and [router](2026-10-10-public-harness-router.md) plans provide the shared local development path; all Linux tasks must pass before the final release check.

## Global Constraints

- UI code lives in `integrations/public-harness/packages/ui/` and installs through each user's Web profile; no Harness source patch is required for upstream upgrades.
- The macOS/Windows `team-dev` profile is loopback-only, uses fixed test identities and a mock model or developer key, and never exposes public registration.
- Product copy belongs to typed English and Chinese locale dictionaries. Reuse existing UI primitives, slots, and style tokens; verify light and dark themes.
- Production login and registration pages are authentik-owned; development uses a local test-user selector. The plugin supplies Harness branding and common navigation; hiding specific official controls remains a later UI change.
- Every user instance gets the same tested bundle versions. Session data and Git workspaces persist through upgrades.
- Public self-registration stays disabled until real Linux checks for full tool execution, isolation, quota, account lifecycle, TLS, mail/CAPTCHA, backup, and capacity all pass.
- Paths in task file lists are relative to `integrations/public-harness/` unless they include that prefix.

## Review Focus

- A user whose instance is still starting needs one clear waiting state, not a broken application shell; Task 1 pins it.
- A quota or capacity denial needs plain localized copy without leaking internal IDs; Task 1 pins it.
- Browser refresh and WebSocket reconnect must retain the correct user path and branding; Task 2 pins them.
- Upgrading Harness with an incompatible plugin interface must stop before changing user instances; Task 3 pins preflight.
- A failed registration, email verification, or backup restore must keep public enrollment closed; Task 4 pins the release condition.
- A development profile must remain available on macOS and Windows without Caddy, authentik, Linux accounts, or gVisor; Task 2 pins that path.

---

### Task 1: Shared Brand and Status UI

**Files:** Create `integrations/public-harness/packages/ui/src/index.ts`, `src/client/index.tsx`, `src/client/locales.ts`, `src/client/styles.css`, `tests/brand.client.spec.tsx`, plus package manifest and README pair.

**Interfaces:** The Cordis client plugin registers brand mark/name and navigation through published `dsh.client` slots. `renderStatusPage(status, locale): string` supplies the router with branded `starting`, `capacity-full`, and `service-unavailable` pages; the in-app quota error maps to localized `quota-exhausted` copy. Neither surface includes internal IDs or credentials.

- [ ] **Step 1: Write failing client tests** for brand slots, localized status, keyboard access, loading state, and readable light/dark colors.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- brand.client.spec.tsx`; expect failure.
- [ ] **Step 3: Implement** the slot occupants, shared status components, locale dictionaries, and CSS using existing UI primitives and tokens.
- [ ] **Step 4: Run** the focused tests; expect pass. Capture a browser GIF from the real server/model flow for the visible UI PR, then commit the UI and README pair.

### Task 2: Development and Production Profile Composition

**Files:** Create `deploy/profiles/web/cordis.patch.yml`, `deploy/profiles/team-dev/cordis.patch.yml`, `deploy/authentik/brand.yml`, `tests/profile.e2e.ts`, and `tests/team-dev.e2e.ts`; update the deployment README pair.

**Interfaces:** The Web profile installs the same pinned UI, quota-provider, and token-publisher bundles for each user. `team-dev` starts local router, signed test identity, local runtime, and quota service on loopback with no public enrollment. Production authentik requires email verification and CAPTCHA before an account may reach the router.

- [ ] **Step 1: Write failing e2e tests** for macOS/Windows local startup, two test identities, first login, refresh, clean URL, instance wait, WebSocket reconnect, account switch, non-loopback refusal, and consistent production login/application branding.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test:e2e -- team-dev.e2e.ts`; expect failure.
- [ ] **Step 3: Implement** the local profile and test-user selector, shared bundle installation, production authentik brand and enrollment configuration, and browser navigation.
- [ ] **Step 4: Run** `team-dev.e2e.ts` with two real Harness Web processes on macOS and Windows, then run `profile.e2e.ts` with real authentik/Caddy on Linux; record results and commit.

### Task 3: Versioned Upgrade and Rollback

**Files:** Create `deploy/release-manifest.json`, `deploy/upgrade.ts`, `tests/upgrade.spec.ts`, and an upgrade runbook pair.

**Interfaces:** `preflightUpgrade(manifest): Promise<CompatibilityReport>` starts a nonproduction profile with the candidate Harness and every pinned bundle, exercises login, model call, terminal, Session, and plugin loading, then permits staged user-instance upgrades. Rollback restores the previous code versions without moving or deleting released Session generations.

- [ ] **Step 1: Write failing tests** for an incompatible plugin API, failed Session migration, interrupted rollout, preserved `DSH_HOME`, and restored previous bundle versions.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- upgrade.spec.ts`; expect failure.
- [ ] **Step 3: Implement** manifest validation, canary preflight, staged update and stop-on-failure behavior, and code-only rollback instructions.
- [ ] **Step 4: Run** the focused tests and a real canary upgrade on Linux; record versions and results, then commit.

### Task 4: Public Enrollment Release Check

**Files:** Create `deploy/release-check.ts`, `tests/release-check.spec.ts`, and the operator release checklist pair.

**Interfaces:** `checkPublicEnrollment(evidence): Promise<ReleaseDecision>` returns `allow` only when machine-checked configuration and recorded real-Linux tests cover Caddy TLS and header stripping, authentik security version and email/CAPTCHA, two-user execution isolation, quota fail-closed behavior, restart and backup restore, and capacity. The enrollment switch defaults to closed.

- [ ] **Step 1: Write failing tests** for each missing prerequisite and for complete valid evidence; stale or wrong-host evidence is rejected.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- release-check.spec.ts`; expect failure.
- [ ] **Step 3: Implement** the release check and operator evidence format; keep secrets and user data out of evidence.
- [ ] **Step 4: Run** the focused test and full Linux rehearsal. Open public enrollment only after the release decision is `allow`, then commit the deployment record without secrets.
