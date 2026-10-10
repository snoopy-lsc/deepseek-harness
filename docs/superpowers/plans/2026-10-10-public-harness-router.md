# Public Harness Router Implementation Plan

English | [中文](2026-10-10-public-harness-router.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each authenticated browser to only its own Harness Web instance through one HTTPS address.

**Architecture:** Caddy performs TLS and authentik forward authentication for each request and WebSocket handshake, then sends traffic through a permission-protected Unix socket. A non-root Cordis router validates authentik's signed identity against configured issuer, audience, and signing keys, asks the provisioner for that user's endpoint, and strips the `/u/<id>/` prefix. It exchanges the Harness launch token server-side, scopes the returned cookie to that prefix, and never places the token in a browser URL.

**Tech Stack:** TypeScript, Node 22.19+ or 24+, Cordis, Caddy, authentik, signed JWT validation, HTTP/WebSocket proxying, Vitest.

**Spec:** [Public multi-user Harness design](../specs/2026-10-10-public-team-harness-design.md).

**Prerequisite:** Complete the [runtime plan](2026-10-10-public-harness-runtime.md) and [quota plan](2026-10-10-public-harness-quota.md); router unit tests may use protocol fakes before Linux integration.

## Global Constraints

- Router code lives in `integrations/public-harness/packages/router/` as an independently versioned Cordis bundle launched by `dsh --profile team-router`; it does not run as root.
- Only the Caddy service account can open the router Unix socket. Caddy removes client-supplied identity headers and copies authenticated values from the authentik forward-auth result.
- The router validates one signed identity with fixed issuer, audience, key source, expiry, and `sub`/UID agreement on every HTTP request and upgrade. Malformed, duplicate, missing, or revoked identities fail closed.
- Paths are `/u/<opaque-id>/...`; the router strips only the exact owner's prefix, preserves public Host and Origin, and forwards only to that user's provisioner endpoint.
- Harness cookies are host-only, `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, and `Path=/u/<id>/`. Each open WebSocket ends within 60 seconds and must reauthenticate on reconnect.
- Paths in task file lists are relative to `integrations/public-harness/` unless they include that prefix.

## Review Focus

- Encoded slashes, dot segments, or a prefix collision cannot select another user's backend; Task 2 pins path normalization.
- Duplicate identity headers or a valid JWT for a different audience cannot authenticate; Task 1 pins denial.
- A restart between token retrieval and cookie exchange cannot reveal a token or mix users; Task 3 pins retry behavior.
- WebSocket upgrade and reconnect must perform the same identity and owner checks as HTTP; Task 4 pins them.
- A suspended user or full server must receive a bounded response without creating a container; Task 2 pins both states.

---

### Task 1: Authenticated Identity

**Files:** Create `integrations/public-harness/packages/router/src/identity.ts`, `config.ts`, `tests/identity.spec.ts`, and package README pair and manifest.

**Interfaces:** `verifyIdentity(headers: IncomingHttpHeaders): Promise<UserId>` validates the configured authentik signature, issuer, audience, expiry, and exact UID match. The key source is configured server-side, never taken from request metadata. `UserId` comes from the runtime plan's contracts package.

- [ ] **Step 1: Write failing tests** for valid JWT, forged/missing/duplicate UID or JWT, expired JWT, wrong audience or issuer, signing-key rotation, and disabled users.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- identity.spec.ts`; expect failure.
- [ ] **Step 3: Implement** bounded header parsing, signed JWT validation, user-ID parsing, and revocation lookup with a fail-closed authentik availability policy.
- [ ] **Step 4: Run** the focused test; expect pass, then commit identity handling and README pair.

### Task 2: Owner Routing and Capacity

**Files:** Create `packages/router/src/routes.ts`, `admission.ts`, `tests/routes.spec.ts`; add the Caddy and authentik deployment configuration under `deploy/`.

**Interfaces:** `route(request, userId): Promise<{ socketPath; upstreamPath } | Rejection>` only returns the endpoint from `ProvisionerClient.ensure(userId)` for the exact `/u/${userId}/` path. Root redirects to the signed-in user's path; unknown paths, cross-user paths, and excess capacity are rejected.

- [ ] **Step 1: Write failing tests** for root redirect, canonical path, cross-user path, encoded separators, dot segments, path-prefix collision, malformed user ID, suspended account, and capacity ceiling.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- routes.spec.ts`; expect failure.
- [ ] **Step 3: Implement** path canonicalization, owner matching, one per-user first-access lock, bounded waiting, provisioner calls, and ready/denied responses. Configure Caddy to replace identity headers and authenticate upgrades.
- [ ] **Step 4: Run** the focused test and `caddy validate` on the deployment config; expect pass, then commit.

### Task 3: Server-side Harness Cookie Exchange

**Files:** Create `packages/router/src/launch.ts`, `cookies.ts`, `tests/launch.spec.ts`.

**Interfaces:** `openBrowserSession(userId, endpoint): Promise<SetCookie>` obtains `ProvisionerClient.launchGrant(userId)`, requests the backend root privately, accepts only the expected 303 plus one Harness cookie, and rewrites its path and `Secure` attribute. The token is never returned as a URL or logged.

- [ ] **Step 1: Write failing tests** for fresh browser, existing signed cookie, stale launch grant, instance restart, malformed `Set-Cookie`, cross-user cookie, and token redaction.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- launch.spec.ts`; expect failure.
- [ ] **Step 3: Implement** private exchange, strict response parsing, one retry after a stale grant, scoped cookie rewriting, and clean redirect.
- [ ] **Step 4: Run** the focused test; expect pass, then commit.

### Task 4: HTTP and WebSocket Forwarding

**Files:** Create `packages/router/src/server.ts`, `proxy.ts`, `tests/proxy.spec.ts`, and a two-real-Web-process e2e fixture.

**Interfaces:** The Cordis bundle owns a private HTTP server. Every normal request and `upgrade` calls `verifyIdentity` and `route`; the forwarding layer preserves streaming backpressure and public Host/Origin, strips the mount prefix, rewrites cookie paths, and closes WebSockets at 60 seconds.

- [ ] **Step 1: Write failing tests** for HTTP streaming, cancellation, all upgrade paths, old socket closure, identity switch, cookie path isolation, and rejected unauthenticated upgrade.
- [ ] **Step 2: Run** `pnpm --dir integrations/public-harness test -- proxy.spec.ts`; expect failure.
- [ ] **Step 3: Implement** the server and forwarding layer with one HTTP and upgrade authorization path, bounded headers/body, and response-header rewriting.
- [ ] **Step 4: Run** the focused test and two-real-Web-process e2e, then test Caddy/authentik with a forged header and a revoked account on Linux; record results and commit.
