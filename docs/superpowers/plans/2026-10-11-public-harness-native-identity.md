# Native Harness Identity Implementation Plan

English | [中文](2026-10-11-public-harness-native-identity.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide public registration and revocable browser authentication using Better Auth.

**Architecture:** A separate Cordis service owns Better Auth, private SQLite and account pages. The router resolves the current session over a private Unix socket on every request and WebSocket handshake. Existing authentik and local development identities remain explicitly selectable.

**Tech Stack:** TypeScript, Node ^22.19 || >=24, Cordis, Better Auth, SQLite, React, Vitest.

**Spec:** [Approved native deployment design](../specs/2026-10-11-public-harness-native-design.md).

**Dependencies:** Develop independently of [runtime](2026-10-11-public-harness-native-runtime.md); both are required by [deployment](2026-10-11-public-harness-native-deployment.md).

## Global Constraints

- File paths below are relative to `integrations/public-harness/`; `docs/` paths are relative to the repository root. Changes stay in independent plugins and profiles; Harness Session formats and `InstanceManager` remain unchanged.

- Use strict TypeScript, branded opaque IDs, ESM, documented exports, validated configurable deployment values, and `ctx.effect()` for lifecycle ownership. Launch every Node service through a `dsh` profile.

- Commands and assertions in this plan describe planned checks and expected results, not completed deployment evidence. Focused commands run from the repository root; build the integration before testing built imports.

- Public admission requires email verification, CAPTCHA, persistent rate limits and platform model allowances. Secrets stay outside user accounts. Local development remains loopback-only and is not an isolation environment.

## Review Focus

- Forged origin/proxy headers or duplicate cookies: reject before authentication (Task 1).
- Verification/reset replay and exhausted registration limits: no duplicate account or unlimited retries (Task 1).
- Logout/revocation/suspension: subsequent requests deny immediately; existing channels close within a configured bound (Task 2).
- Identity database/socket failure: return unavailable and grant no user identity (Task 2).
- User-controlled return URLs or browser text: reject external redirects and render localized, escaped content (Task 3).

---

### Task 1: Better Auth service and verified registration

**Files:** Create `packages/identity/{package.json,tsconfig.build.json,build.ts,README.md,README.zh.md}`, `src/{index,config,auth,database,server}.ts`, `tests/registration.spec.ts`; modify integration lockfile, root `tsconfig.json` for TSX/DOM and integration build configuration.

**Interfaces:** Produce `parseIdentityConfig(value: unknown): IdentityConfig`, `startIdentity(config: IdentityConfig): Promise<{ close(): Promise<void> }>`, and Cordis `apply(ctx: Context, config: { configFile: string }): Promise<void>`. Config specifies public HTTPS origin, private socket/database, secret files, mail transport, CAPTCHA provider/secret, persistent rate policy, session/token lifetimes and trusted proxy policy. Pin maintained Better Auth/SQLite adapter versions after checking their current primary API documentation.

- [ ] **1. Write failing tests:** `unverified_user_cannot_enter_harness` asserts no session identity before email verification; `verification_and_reset_are_single_use` rejects token replay. `registration_limit_survives_restart` retains the counter across two service processes; `forged_origin_or_proxy_denied` and duplicate session cookies reject without creating users. CAPTCHA and mail failure leave enrollment unavailable, never silently verified.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- registration.spec.ts`; expect missing identity service or failed admission assertions.

- [ ] **3. Implement** the declared service with Better Auth Node handlers and owned schema migration, private database permissions, email/password signup, verification, reset, sign-in/out and session revocation. Validate HTTP inputs, require secure host cookies and exact origins, and use persistent atomic rate consumption. Use deterministic injected mail/CAPTCHA transports only in explicit test/local configs; production rejects them. Website signup alone allocates no Linux account, instance or model grant.

- [ ] **4. Verify** focused tests, build and `typecheck`; expect pass. Document database migrations, secret/mail requirements and unavailable states in README/JSDoc; commit `feat: add verified Better Auth registration service`.

### Task 2: Live session verification and revocation

**Files:** Create identity `src/session-wire.ts`, router `src/native-identity.ts`, identity `tests/session-wire.spec.ts`, router `tests/native-identity.spec.ts`; modify router `src/{config,server,proxy}.ts`, production `src/team-router.ts`, corresponding ingress tests and README pairs.

**Interfaces:** Produce `createNativeIdentity(options: { socketPath: string; timeoutMs: number; maxResponseBytes: number }): IdentityVerifier`, preserving `verify(headers: IncomingHttpHeaders): Promise<UserId>`. Internal `POST /internal/session`, unreachable through Caddy, accepts only a bounded cookie field and returns `{ userId: UserId; sessionId: SessionId; expiresAt: number }`; `SessionId` is branded and parsed in identity. Define `IdentityUnavailableError` in router config for lookup timeout, unavailable store/socket or invalid response; server maps it to 503 while invalid credentials stay 401. Active-user checks reuse provisioner status. Add server configuration `sessionRecheckMs` and close active HTTP/WS streams when revalidation denies or becomes unavailable.

- [ ] **1. Write failing tests:** `logout_denies_next_request` and `suspension_denies_next_handshake` assert no backend connection after revocation; `open_stream_is_closed_on_recheck` asserts closure within the configured interval. `identity_outage_never_reuses_positive_result` returns 503 and zero route starts after a previous successful lookup; spoofed browser identity headers and development cookies produce no production identity.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- session-wire.spec.ts native-identity.spec.ts ingress.spec.ts`; expect failure of new verification cases.

- [ ] **3. Implement** the private session lookup using Better Auth `getSession` with cookie caching disabled; map immutable database IDs through `parseUserId`. Authenticate every request/upgrade; bound and validate socket responses. Parse explicit identity tags `better-auth`, `authentik` or development mode; deny cross-mode configuration. Track streams with disposable recheck timers, preserving forwarding cookie/header filters and account capacity checks.

- [ ] **4. Verify** focused tests and existing authentik/development identity tests; expect pass. Extend the backend upgrade guide for identity selection and update README pairs; commit `feat: verify native browser sessions at the router`.

### Task 3: Unified account pages and browser flow

**Files:** Create identity `src/client/{index.tsx,locale.ts,account.tsx,styles.css}`, `tests/account.spec.ts`, `tests/registration.e2e.ts`; modify identity build/server, UI `src/client/index.tsx` only to reuse the account link/branding contribution, and `tests/deploy-config.spec.ts` for built assets.

**Interfaces:** Serve `/account/` and `/api/auth/*` from the identity service; after successful verification and login, redirect to the current user router path. Produce `safeReturnPath(value: string, userId: UserId): string`, allowing only that user route or `/account/`. Account pages use a typed English/Chinese dictionary and the shared product branding; Harness behavior is added only through its existing UI plugin.

- [ ] **1. Write failing tests:** `return_path_cannot_leave_owner_route` rejects external, encoded and foreign-user redirects; `account_copy_is_localized` checks both locales and escaped server errors. Browser `register_verify_login_logout` completes signup through the test mailbox, enters a real Harness, then confirms logout blocks its HTTP and WS access; include reset/revocation and loading/error states.

- [ ] **2. Run** `pnpm --dir integrations/public-harness test -- account.spec.ts deploy-config.spec.ts`; expect missing pages or redirect assertions to fail.

- [ ] **3. Implement** signup, verification, login, reset and account/session controls with locale-owned copy and existing visual tokens. Build React pages as identity assets rather than replacing upstream client code. Add declared browser-test dependencies/configuration; real browser tests use unique local origins, owned processes and explicit test CAPTCHA/mail settings.

- [ ] **4. Verify** focused tests, `pnpm --dir integrations/public-harness test:e2e -- registration.e2e.ts`, build/typecheck and the required user-output fixture at its owning package; expect pass. Follow client UI/reliability skills and record the real browser flow if a GUI PR is created. Commit `feat: add unified public Harness account pages`.
