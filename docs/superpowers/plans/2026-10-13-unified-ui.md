# Unified Enterprise UI Implementation Plan

English | [中文](2026-10-13-unified-ui.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every team deployment one enterprise look and one entry point: the approved D4 theme (colours and macOS-style glass only, original Harness components untouched), sign-in that lands directly in the user's own chat, a personal entry for everyone and a 「系统管理」 entry for administrators, and finally real personal and administration pages.

**Architecture:** Everything ships from the integration packages under `integrations/public-harness/`; no Harness source is edited. `@public-harness/ui` gains a `team-enterprise` theme layer: colour overrides go through `ctx.theme.overrideTokens`, and glass rules live in one plugin-owned global stylesheet that selects only stable slot and data attributes (`[data-slot]`, `[data-composer-card]`, `[data-composer-seat]`, `[role=dialog]`). Navigation entries are `sidebar.panellist` registrations with matching `main` panels. The identity service answers `GET /account/api/me` with the signed-in user's profile and server-side role; the browser plugin reads it, and the server stays the only authority for administrator actions. Identity pages share the same token values through a nonce-bound stylesheet.

**Tech Stack:** TypeScript, React 18 client plugins on Cordis, esbuild client bundle, Better Auth on `node:sqlite`, Vitest, playwright-core with system Chrome.

**Design reference:** `/workspace/deepseek-harness-eval/design-2026-10-13/variant-D4/` (approved D4 mockups, `d4-theme.css`, `d4-identity.css`, `contrast.md`).

## Global Constraints

- No edits outside `integrations/public-harness/` and `docs/`; Harness components, icons, radii, sizes and layout stay as shipped.
- No selector may depend on build-generated class names; use slots, data attributes, roles or new tokens.
- No CSP bypass: Harness styles are plugin-owned `<style>` elements as ui-theme does; identity pages use the existing per-response nonce and local assets only.
- Text contrast meets WCAG 2.1 AA (4.5:1) on every translucent surface composited over the worst backdrop; `prefers-reduced-transparency: reduce` turns all glass solid.
- Roles come only from the server; the browser hides entries but never grants access. Administrator APIs re-check the role on every request.
- Secrets only through environment variables; the model key is never printed, logged or written. Services bind 127.0.0.1 or Unix sockets only.
- Builds and tests run serially with `NODE_OPTIONS=--max-old-space-size=3072`.

## Review Focus

- The theme cannot break when Harness rebuilds: Task 1.2 pins that the stylesheet contains no hashed class name.
- A member cannot reach administrator data by forging the client: Task 1.4 pins the server role, and Phase 2 pins every admin API.
- Sign-in never lands on a foreign or open-redirect target: Task 1.5 keeps `safeReturnPath`.
- Platform users never see a provider they cannot use: Task 1.6 pins the default model and the hidden official provider.

## File Structure

- `packages/ui/src/client/theme/tokens.ts`: the `team-enterprise` light/dark token pairs.
- `packages/ui/src/client/theme/glass.css`: the plugin-owned glass and backdrop stylesheet with the reduced-transparency fallback.
- `packages/ui/src/client/theme/index.ts`: registers the token layer and the stylesheet for the plugin lifetime.
- `packages/ui/src/client/nav.tsx`: personal and administration panel entries and their placeholder pages.
- `packages/ui/src/client/me.ts`: reads `/account/api/me`.
- `packages/ui/src/identity-theme.ts`: identity page stylesheet built from the same token values.
- `packages/contracts/src/web-rows.ts`: shared Web patch rows (default model, hidden official provider).
- Modified: `packages/identity/src/{config,server,pages}.ts`, `packages/team-dev/src/quota.ts`, `packages/provisioner/src/runtime.ts`, package READMEs.

## Phase 1: Theme Plugin and Unified Shell

### Task 1.1: Token layer

- [ ] Test: the client bundle registers `team-enterprise` overrides through `ctx.theme.overrideTokens` with a `{ light, dark }` pair for every token, and disposes them on unload.
- [ ] Implement `tokens.ts` from `d4-theme.css` section A; only `--dsw-*` names.
- [ ] Commit.

### Task 1.2: Glass stylesheet

- [ ] Test: the stylesheet is mounted as a `<style data-plugin>` element, removed on dispose, contains a `prefers-reduced-transparency` block, and matches no `[A-Za-z0-9-]{4,}_[A-Za-z]` hashed class pattern.
- [ ] Implement `glass.css` with stable selectors: `body` backdrop, `div:has(> [data-slot="sidebar"])` for the sidebar column and its frame, `[data-composer-card]`, `[data-composer-seat]`, `[role="dialog"][aria-modal="true"]`.
- [ ] Commit.

### Task 1.3: Contrast check

- [ ] Test: a unit test composites each translucent token over the worst desktop colour and asserts ≥ 4.5:1 for label tokens and ≥ 3:1 for the accent.
- [ ] Commit.

### Task 1.4: Server role and profile endpoint

- [ ] Test: `GET /account/api/me` answers 401 without a session and `{ id, email, name, role }` with one; `role` is `admin` for emergency accounts and addresses in `DSH_ADMIN_EMAILS`, otherwise `member`.
- [ ] Implement `DSH_ADMIN_EMAILS` parsing (environment only, fail closed on malformed addresses) and the endpoint with `cache-control: no-store`.
- [ ] Commit.

### Task 1.5: Unified routing and navigation

- [ ] Test: password and emergency sign-in go to `/u/<id>/` (or a safe `return`); the client registers a personal panel for everyone and an administration panel only when the role is `admin`.
- [ ] Implement entries with Harness icons (`IconUserOutlineRegular`, `IconShieldOutlineRegular`) and placeholder pages linking to `/account/`.
- [ ] Commit.

### Task 1.6: Identity pages and model defaults

- [ ] Test: identity pages carry the shared tokens in the nonce-bound `<style>` and load nothing remote; Web patches set `agent-default-model` to the platform route and disable `llm-deepseek` unless an official key is configured.
- [ ] Implement and commit.

### Task 1.7: Gates and screenshots

- [ ] Run unit, typecheck, e2e, doc-quick, jsdoc and i18n pairing serially; restart the local stack on this branch; capture light and dark login, admin chat, member chat and the personal entry.

## Phase 2: Personal Center

### Task 2.1: Account and sessions

- [x] Personal panel renders account facts, sign-in method and role with Harness settings rows; session list and "sign out other sessions" call identity APIs.
- [x] Endpoints under `/account/api/me`: `GET /security` (sign-in method, password-change eligibility, SSO bindings), `GET /sessions` (no tokens), `POST /sessions/revoke` (one other session), `POST /sessions/revoke-others`, `POST /password` (current password as re-authentication; password and emergency accounts only; other sessions are signed out). Every request needs a live session; writes need the configured Origin and a JSON body; password changes and revocations are audited.

### Task 2.2: Usage and quota

- [x] Read-only usage from the quota ledger through a per-user endpoint; show daily allowance and today's use.
- [ ] Production bridge from the identity service to the quota ledger (today the deployment passes a usage source to `startIdentity`; the team-dev stack does).

### Task 2.3: Preferences

- [x] Link the existing Harness settings for appearance and language; no duplicated settings state (the page runs Harness's own `settings.open` command).

## Phase 3: Administration

### Task 3.1: Admin API

- [x] `/api/admin/*` in the identity service: invites, users (search, role and its source, status, sign-in method, last sign-in), disable through the deprovisioning path (sessions revoked in the same transaction), enable, role grants in `dsh_role_grant`, audit log with filters and a cursor, redacted SSO view with the last reconciliation run, and allowances. Every endpoint checks the role on the server before reading the body; writes need Origin and JSON, are rate limited and audited.
- [x] Last-admin rule on disable and demotion; configured and emergency administrators cannot be demoted from the console; no self-disable.
- [x] Re-authentication (decided here): disable, role change and allowance change. Password administrators resend their password; SSO administrators need a session under 10 minutes old, otherwise 401 `reauth-required` with `method: 'sso'` and a fresh SSO sign-in. Enable and invite changes are audited only.
- [x] `admin.spec.ts` proves a member gets 403, and an anonymous caller 401, on every endpoint in `ADMIN_ENDPOINTS`.

### Task 3.2: Production usage source

- [x] The quota service opens a private account socket (`accountSocket`, `accountSocketGid`; `usage`, `limits`, `set-default`, `set-user`) and the ledger keeps per-user and default daily limits, capped by the site limit.
- [x] Identity reads `DSH_QUOTA_ACCOUNT_SOCKET`; `startIdentity` uses it for personal usage and the allowance editor when no override is passed. The native units give only `dsh-identity` access (`/run/dsh-public/quota-account`), and Caddy forwards `/api/admin/*`.

### Task 3.3: Administration UI

- [x] While administration is open its submenu shadows the session browser in the same sidebar (`sidebar.workspaces` at a lower priority) with a back row; members never get the entry.
- [x] Users, invites, audit log, SSO and quota sections built from Harness primitives and settings-row geometry, with a confirmation dialog for disable and a re-authentication dialog.
- [ ] CSV export of the audit log and an over-limit behaviour switch are deferred.

### Task 3.4: Gates and screenshots

- [x] Real-service screenshots in light and dark: submenu, every section, disable with SSO re-authentication, last-admin refusal, back to sessions, personal usage through the account socket, and a member without the entry (the member's API calls answer 403).
