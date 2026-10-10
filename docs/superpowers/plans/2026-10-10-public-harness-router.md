# Public Harness Router Implementation Plan

English | [中文](2026-10-10-public-harness-router.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each authenticated browser to only its own Harness Web instance through one browser entry; production serves it over HTTPS.

**Architecture:** Production Caddy performs TLS and authentik forward authentication for each request and WebSocket handshake, then sends traffic through a protected Unix socket. A non-root Cordis router validates the signed identity, asks the `InstanceManager` for that user's endpoint, and strips the `/u/<id>/` prefix. A separate local-only `team-dev` profile uses signed test-user cookies and loopback TCP endpoints with the same owner checks, token exchange, and HTTP/WebSocket forwarding.

**Tech Stack:** TypeScript, Node 22.19+ or 24+, Cordis, Caddy, authentik, signed JWT validation, HTTP/WebSocket proxying, Vitest.

**Spec:** [Public multi-user Harness design](../specs/2026-10-10-public-team-harness-design.md).

**Prerequisite:** Runtime plan Tasks 1–2 and the [quota plan](2026-10-10-public-harness-quota.md) enable local development; runtime Tasks 3–5 and real Linux services are required for production. [Runtime plan](2026-10-10-public-harness-runtime.md).

## Global Constraints

- Router code lives in `integrations/public-harness/packages/router/` as an independently versioned Cordis bundle launched by `dsh --profile team-router`; it does not run as root.
- The explicit `team-dev` profile runs the router with a development identity provider and binds only to loopback; it rejects public bind addresses and never enables authentik-free identity in production.
- Only the Caddy service account can open the router Unix socket. Caddy removes client-supplied identity headers and copies authenticated values from the authentik forward-auth result.
- The production router validates one signed identity with fixed issuer, audience, key source, expiry, and `sub`/UID agreement on every HTTP request and upgrade. Malformed, duplicate, missing, or revoked identities fail closed.
- Paths are `/u/<opaque-id>/...`; the router strips only the exact owner's prefix, preserves public Host and Origin, and forwards only to that user's `InstanceManager` endpoint, whether Unix socket or loopback TCP.
- Harness cookies are host-only, `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, and `Path=/u/<id>/`. Each open WebSocket ends within 60 seconds and must reauthenticate on reconnect.
- Paths in task file lists are relative to `integrations/public-harness/` unless they include that prefix.

## Review Focus

- Encoded slashes, dot segments, or a prefix collision cannot select another user's backend; Task 2 pins path normalization.
- Duplicate identity headers or a valid JWT for a different audience cannot authenticate; Task 1 pins denial.
- A restart between token retrieval and cookie exchange cannot reveal a token or mix users; Task 3 pins retry behavior.
- WebSocket upgrade and reconnect must perform the same identity and owner checks as HTTP; Task 4 pins them.
- A suspended user or full server must receive a bounded response without creating a container; Task 2 pins both states.
- A development cookie or local listener cannot activate outside the `team-dev` loopback profile; Task 1 pins that denial.

---

### Task 1: Authenticated Identity

**Files:** Create `integrations/public-harness/packages/router/src/identity.ts`, `dev-identity.ts`, `config.ts`, `tests/identity.spec.ts`, `tests/dev-identity.spec.ts`, and package README pair and manifest.

**Interfaces:** `IdentityVerifier.verify(headers: IncomingHttpHeaders): Promise<UserId>` has production and development implementations. Production validates authentik signature, issuer, audience, expiry, exact UID match, and revocation. Development accepts only signed cookies for fixed test IDs on loopback. Signing keys come from local configuration, never request metadata; `UserId` comes from the runtime contracts package.

- [ ] **Step 1: Write failing tests** for valid JWT, forged/missing/duplicate UID or JWT, expired JWT, wrong audience or issuer, signing-key rotation, disabled users, local test-user selection, invalid development cookies, and development identity in production mode.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- identity.spec.ts dev-identity.spec.ts`; expect failure.
- [ ] **Step 3: Implement** bounded header parsing, signed JWT validation, user-ID parsing, revocation lookup, and a separately configured development cookie issuer limited to fixed test users and loopback.
- [ ] **Step 4: Run** the focused test; expect pass, then commit identity handling and README pair.

### Task 2: Owner Routing and Capacity

**Files:** Create `packages/router/src/routes.ts`, `admission.ts`, `tests/routes.spec.ts`; add the Caddy and authentik deployment configuration under `deploy/`.

**Interfaces:** `route(request, userId): Promise<{ endpoint: InstanceEndpoint; upstreamPath: string } | Rejection>` only returns `InstanceManager.ensure(userId)` for the exact `/u/${userId}/` path. Root redirects to the signed-in user's path; unknown paths, cross-user paths, and excess capacity are rejected.

- [ ] **Step 1: Write failing tests** for root redirect, canonical path, cross-user path, encoded separators, dot segments, path-prefix collision, malformed user ID, suspended account, and capacity ceiling.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- routes.spec.ts`; expect failure.
- [ ] **Step 3: Implement** path canonicalization, owner matching, one per-user first-access lock, bounded waiting, instance-manager calls, and ready/denied responses. Configure production Caddy to replace identity headers and authenticate upgrades.
- [ ] **Step 4: Run** the focused test; on Linux, run `caddy validate` on the production deployment config. Expect pass, then commit.

### Task 3: Server-side Harness Cookie Exchange

**Files:** Create `packages/router/src/launch.ts`, `cookies.ts`, `tests/launch.spec.ts`.

**Interfaces:** `openBrowserSession(userId, endpoint): Promise<SetCookie>` obtains `InstanceManager.launchGrant(userId)`, requests the backend root privately, accepts only the expected 303 plus one Harness cookie, and rewrites its path and `Secure` attribute on HTTPS. The token is never returned as a URL or logged.

- [ ] **Step 1: Write failing tests** for fresh browser, existing signed cookie, stale launch grant, instance restart, malformed `Set-Cookie`, cross-user cookie, and token redaction.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- launch.spec.ts`; expect failure.
- [ ] **Step 3: Implement** private exchange, strict response parsing, one retry after a stale grant, scoped cookie rewriting, and clean redirect.
- [ ] **Step 4: Run** the focused test; expect pass, then commit.

### Task 4: HTTP and WebSocket Forwarding

**Files:** Create `packages/router/src/server.ts`, `proxy.ts`, `tests/proxy.spec.ts`, and a two-real-Web-process e2e fixture.

**Interfaces:** The Cordis bundle owns a private HTTP server. Every normal request and `upgrade` calls `IdentityVerifier.verify` and `route`; the forwarding layer handles Unix and loopback TCP endpoints, preserves streaming backpressure and public Host/Origin, strips the mount prefix, rewrites cookie paths, and closes WebSockets at 60 seconds.

- [ ] **Step 1: Write failing tests** for Unix/TCP forwarding, HTTP streaming, cancellation, all upgrade paths, old socket closure, identity switch, cookie path isolation, rejected unauthenticated upgrade, and non-loopback development bind.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- proxy.spec.ts`; expect failure.
- [ ] **Step 3: Implement** the server and forwarding layer with one HTTP and upgrade authorization path, bounded headers/body, and response-header rewriting.
- [ ] **Step 4: Run** the focused test and two-real-Web-process e2e on macOS and Windows, then test Caddy/authentik with a forged header and a revoked account on Linux; record results and commit.
