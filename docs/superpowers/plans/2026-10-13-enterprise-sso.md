# Enterprise SSO Foundation and OIDC Implementation Plan

English | [中文](2026-10-13-enterprise-sso.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an on-premises enterprise deployment sign employees in through its own OpenID Connect identity provider, with just-in-time accounts limited to allowed groups and a gated administrator emergency password path.

**Architecture:** The identity service gains a provider-neutral SSO layer: environment-only `DSH_SSO_*` configuration, a store for `(provider, subject)` bindings, account origins, single-use login state and a one-year audit log, and a Better Auth plugin whose start and callback endpoints mint ordinary Better Auth sessions. OIDC is the first provider behind that layer; it uses discovery, Authorization Code with PKCE, state and nonce, and verifies ID tokens against the issuer's JWKS with `node:crypto`. The router keeps using the private session socket unchanged, because SSO sessions are ordinary verified Better Auth sessions.

**Tech Stack:** TypeScript, Node 22, Better Auth 1.7.7 on `node:sqlite`, `node:crypto` (JWK import, RS256/ES256 verification, HMAC-SHA1 TOTP), Vitest, playwright-core with system Chrome.

**Spec:** [Enterprise on-prem identity design](../specs/2026-10-13-enterprise-sso-design.md), decisions D1–D8.

## Global Constraints

- Secrets and provider settings come only from the service environment (`DSH_SSO_*`, `DSH_OIDC_*`); the JSON configuration file refuses SSO keys.
- Fail closed: an unknown provider, a missing or malformed variable, an empty group allow-list, or a non-HTTPS issuer in production refuses startup; errors name the variable, never its value.
- Unset `DSH_SSO_PROVIDER` or `off` keeps every existing registration, CAPTCHA, invite and mail behavior unchanged.
- No account is ever merged or bound by email alone (D2); an invite-created account can never be bound to an enterprise subject (D3).
- SSO users are created with a verified email (D4); emergency accounts still need a verified email.
- Sign-out revokes only the Harness session (D5).
- The emergency path is administrator-only, requires a source-IP allow-list and a TOTP second factor, and keeps audit rows for 365 days (D6).
- Just-in-time creation and every later sign-in require membership in `DSH_SSO_ALLOWED_GROUPS` (D7).
- IdP outages and timeouts answer 503 and admit nothing; invalid tokens, state or claims answer 403.
- Tests use only a local mock IdP on `127.0.0.1` with generated keys; no real IdP secret appears anywhere.
- Builds and test runs are serial with `NODE_OPTIONS=--max-old-space-size=3072`.
- Paths are relative to `integrations/public-harness/packages/identity/` unless stated otherwise.

## Review Focus

- A forged, replayed or cross-browser callback cannot sign anyone in; Task 4 pins single-use, browser-bound state, nonce, PKCE and signature checks.
- An IdP user whose email matches an existing local or invite account cannot take it over; Task 5 pins refusal instead of merge.
- A user outside the allowed groups gets no account and, once removed, no new session; Task 5 pins both.
- Password sign-in cannot bypass SSO, and an emergency administrator cannot use the ordinary password form; Tasks 5 and 6 pin the gates.
- The emergency path cannot be used from an unlisted address, without a fresh TOTP code, or with a replayed one; Task 6 pins it.

## File Structure

- `src/sso/config.ts`: `parseSsoEnv`, the `SsoConfig` and `EmergencyConfig` types.
- `src/sso/store.ts`: SQLite tables and the `SsoStore` interface (bindings, origins, login state, emergency enrollment, audit).
- `src/sso/provider.ts`: the provider-neutral `SsoProvider` port and its error types.
- `src/sso/jwt.ts`: compact JWS parsing and RS256/ES256 verification with JWKs.
- `src/sso/oidc.ts`: discovery, authorization URL, code exchange and ID token validation.
- `src/sso/totp.ts` and `src/sso/ip.ts`: RFC 6238 codes and address allow-lists.
- `src/sso/plugin.ts`: the Better Auth plugin with `/sso/start` and `/sso/callback`.
- `src/sso/emergency.ts`: the emergency sign-in gate.
- `src/emergency-cli.ts`: operator enrollment of emergency administrators.
- Modified: `src/config.ts`, `src/auth.ts`, `src/server.ts`, `src/pages.ts`, `src/index.ts`, `package.json`, the package README pair and `deploy/native/config/identity.env.example`.

## Shared Interfaces

```ts
export interface AuditEvent {
  event: 'sso-sign-in' | 'emergency-sign-in' | 'emergency-enroll' | 'emergency-revoke'
    | 'sso-disable' | 'sso-enable' | 'sso-reconcile'
  outcome: 'ok' | 'denied' | 'error'
  userId?: string; email?: string; ip?: string; detail?: string
}
export interface SsoIdentity { subject: string; email: string; name: string; groups: string[] }
export interface SsoProvider {
  readonly kind: 'oidc'
  begin(input: { redirectUri: string }): Promise<{ url: string; secrets: { state: string; nonce: string; verifier: string } }>
  finish(input: { code: string; redirectUri: string; nonce: string; verifier: string }): Promise<SsoIdentity>
}
export interface SsoStore {
  saveState(state: string, record: { browser: string; nonce: string; verifier: string; returnTo: string }, now: number): void
  takeState(state: string, browser: string, now: number): { nonce: string; verifier: string; returnTo: string } | undefined
  findSubject(provider: string, subject: string): string | undefined
  bindSubject(provider: string, subject: string, userId: string, now: number): void
  origin(userId: string): 'sso' | 'invite' | 'emergency' | undefined
  setOrigin(userId: string, origin: 'sso' | 'invite' | 'emergency'): void
  audit(event: AuditEvent, now: number): void
}
```

---

### Task 1: SSO Environment Configuration

**Files:** Create `src/sso/config.ts`, `tests/sso-config.spec.ts`; modify `src/config.ts` to add `sso` and `emergency` to `IdentityConfig`.

**Interfaces:** Produces `parseSsoEnv(env: ProviderEnv, mode: 'production' | 'local'): { sso: SsoConfig; emergency: EmergencyConfig }`, where `SsoConfig` is `{ kind: 'off' }` or `{ kind: 'oidc'; issuer; clientId; clientSecret; scopes; groupClaims; allowedGroups; timeoutMs }` and `EmergencyConfig` is `{ enabled: false }` or `{ enabled: true; allowedIps: readonly string[] }`.

- [ ] **Step 1: Write failing tests**: unset and `off` give `off`; an unknown provider, a missing client ID or secret, scopes without `openid`, an empty `DSH_SSO_ALLOWED_GROUPS`, an issuer with a query or fragment, an `http:` issuer in production and a non-loopback `http:` issuer in local mode all throw `IdentityConfigError` naming the variable; a malformed emergency address list throws; error messages never contain the secret.
- [ ] **Step 2: Run** `npx vitest run --config vitest.config.ts packages/identity/tests/sso-config.spec.ts` from `integrations/public-harness`; expect failure.
- [ ] **Step 3: Implement** `parseSsoEnv` with the same `need`/`optional` discipline as `parseProviderEnv`, and call it from `parseIdentityConfig`.
- [ ] **Step 4: Run** the focused test and the existing identity tests; expect pass; commit.

### Task 2: SSO Store, TOTP and Address Allow-List

**Files:** Create `src/sso/store.ts`, `src/sso/totp.ts`, `src/sso/ip.ts`, `tests/sso-store.spec.ts`, `tests/totp.spec.ts`; modify `src/database.ts` to expose the migrated store.

**Interfaces:** Produces `SsoStore` (above) plus `enrollEmergency(userId, secret, now)`, `emergencySecret(userId)`, `useTotpStep(userId, step): boolean` and `pruneAudit(now)`; `totp(secret: Buffer, step: number): string`, `verifyTotp(secret, code, now, window = 1): number | undefined`; `ipAllowed(ip: string, list: readonly string[]): boolean`. Audit rows older than 365 days are deleted on every write and at startup.

- [ ] **Step 1: Write failing tests**: state is single-use, expires after ten minutes and is bound to its browser value; `bindSubject` refuses a second subject for one user, a second user for one subject, and any user whose origin is `invite` or `emergency`; RFC 6238 SHA-1 vectors; a TOTP step cannot be used twice; IPv4, IPv6 and IPv4-mapped CIDR matching; audit pruning at the 365-day boundary.
- [ ] **Step 2: Run** the focused tests; expect failure.
- [ ] **Step 3: Implement** the tables `dsh_sso_link`, `dsh_user_origin`, `dsh_sso_state`, `dsh_emergency` and `dsh_audit`, storing only state hashes.
- [ ] **Step 4: Run** the focused tests; expect pass; commit.

### Task 3: Provider Port and JWT Verification

**Files:** Create `src/sso/provider.ts`, `src/sso/jwt.ts`, `tests/jwt.spec.ts`.

**Interfaces:** Produces `SsoProvider`, `SsoIdentity`, `SsoRejectedError(code)`; `verifyJws(token: string, keys: JsonWebKey[]): Record<string, unknown>` that accepts only RS256 and ES256 and matches `kid`.

- [ ] **Step 1: Write failing tests** with generated RSA and EC keys: valid tokens verify; `alg: none`, HS256, a wrong key, an unknown `kid`, a tampered payload and malformed segments are rejected.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** with `createPublicKey({ format: 'jwk' })` and `verify`. **Step 4: Run**; expect pass; commit.

### Task 4: OIDC Provider Against a Local Mock IdP

**Files:** Create `src/sso/oidc.ts`, `tests/mock-oidc.ts`, `tests/oidc.spec.ts`.

**Interfaces:** Consumes `SsoConfig` (oidc) and `verifyJws`. Produces `createOidcProvider(config, { fetch?, clock? }): SsoProvider`. The mock IdP listens on `127.0.0.1` with a generated key pair and serves discovery, JWKS, an authorization endpoint that redirects with a code, and a token endpoint that checks the client secret, redirect URI and PKCE verifier.

- [ ] **Step 1: Write failing tests**: discovery issuer mismatch, an authorization URL carrying `S256` challenge, state and nonce; a successful exchange returns subject, email, name and groups from the configured claims; wrong `iss`, `aud`, missing `azp` with several audiences, expired token, wrong nonce, missing email, `email_verified: false` and a bad signature are rejected with 403 codes; JWKS rotation refetches once; IdP timeout or 5xx raises `IdentityUnavailableError`.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** discovery and JWKS caching, `client_secret_basic` with `client_secret_post` fallback, and claim mapping. **Step 4: Run**; expect pass; commit.

### Task 5: Better Auth Plugin, JIT and Server Gates

**Files:** Create `src/sso/plugin.ts`, `tests/sso-flow.spec.ts`; modify `src/auth.ts`, `src/server.ts`, `src/index.ts`.

**Interfaces:** Consumes `SsoProvider`, `SsoStore`. Produces Better Auth routes `GET /api/auth/sso/start?return=` and `GET /api/auth/sso/callback`. The start route sets a short-lived host-only `dsh-sso` browser cookie bound to the stored state. The callback validates state, calls `finish`, requires an allowed group, then finds the bound user or creates one (`emailVerified: true`, origin `sso`), refuses an email already in use, creates a session with `setSessionCookie` and redirects to `/account/`. In SSO mode the public listener refuses public sign-up (invites still work), allows password sign-in only for invite-origin accounts, and answers password-reset requests for other accounts without sending mail.

- [ ] **Step 1: Write failing tests** driving the whole flow over the Unix socket against the mock IdP: first login creates one user and the session lookup returns it; a second login reuses the same `user.id`; a disallowed group creates nothing; a user removed from the group is refused; an email held by an invite account is refused and the invite account stays unbound; a replayed or cross-browser callback fails; password sign-in of an SSO user is refused while an invited contractor still signs in; sign-out revokes only the Harness session; `off` mode routes return 404.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** the plugin and gates, recording invite origins after successful invite sign-ups. **Step 4: Run** the focused and existing identity tests; expect pass; commit.

### Task 6: Administrator Emergency Password

**Files:** Create `src/sso/emergency.ts`, `src/emergency-cli.ts`, `tests/emergency.spec.ts`; modify `src/server.ts`, `package.json` (`dsh-identity-emergency` bin).

**Interfaces:** Produces `POST /api/auth/emergency/sign-in` with `{ email, password, code }` and the CLI `dsh-identity-emergency --config <file> (enroll --email <address> | revoke --email <address> | list | audit [--days N])`. Enrollment requires an existing password account with a verified email that is not SSO-bound, changes its origin to `emergency` and prints the `otpauth://` URI once.

- [ ] **Step 1: Write failing tests**: disabled when no address list is configured; an unlisted address, a missing, wrong or replayed TOTP code, a non-enrolled user and an unverified email are all refused and audited; the ordinary password form refuses the enrolled administrator; the emergency route signs the administrator in and the session lookup accepts it; audit rows older than 365 days disappear.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement**: allow-list, rate limit, TOTP with replay protection, then forward to Better Auth `/sign-in/email`. **Step 4: Run**; expect pass; commit.

### Task 7: Login Pages and Browser Test

**Files:** Modify `src/pages.ts`, `tests/account.spec.ts`; create `tests/sso.e2e.ts`.

**Interfaces:** In SSO mode `/account/login` shows a "Sign in with your company account" link to `/api/auth/sso/start`, keeps the password form only when invites are enabled, and `/account/register` is shown only in invite mode. `/account/emergency` renders the emergency form when it is enabled and is never linked from other pages.

- [ ] **Step 1: Write failing tests** for page content in both locales and modes, then an end-to-end test where Chrome opens the login page through the local front proxy, follows the mock IdP redirect and lands on `/account/` showing the employee email.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** copy, views and script changes. **Step 4: Run** unit and e2e suites; expect pass; commit.

### Task 8: Deployment Documentation and Gates

**Files:** Modify `deploy/native/config/identity.env.example`, `tests/deploy-config.spec.ts` (under `integrations/public-harness/`), and the identity README pair.

- [ ] **Step 1:** Document every `DSH_SSO_*` and `DSH_OIDC_*` variable, the redirect URI and the emergency CLI; keep secrets as placeholders.
- [ ] **Step 2:** Run the full unit suite, `pnpm run typecheck`, the e2e suite, `doc-quick` and `verify-export-jsdoc` serially; commit; push the branch.

### Task 9: WeCom Web Login Provider

**Files:** Create `src/sso/wecom.ts`, `tests/mock-wecom.ts`, `tests/wecom.spec.ts`, `tests/wecom-flow.spec.ts`; modify `src/sso/config.ts`, `src/sso/provider.ts`, `src/index.ts`, `src/server.ts`, `tests/sso-config.spec.ts`, `tests/sso.e2e.ts`, the env example and the README pair.

**Interfaces:** Consumes the Task 5 plugin unchanged. Produces `createWecomProvider(config, { fetch?, clock? }): SsoProvider` with `kind: 'wecom'`, `wecomPlaceholderEmail(subject): string`, and the `wecom` variant of `SsoConfig` (`corpId`, `agentId`, `secret`, `apiBase`, `loginUrl`, `allowedGroups` as department IDs, `recursiveDepartments`, `timeoutMs`). The subject is `CORPID:userid` with a lower-cased `userid`.

- [ ] **Step 1: Write failing tests**: environment parsing (required corp ID, agent ID, secret and numeric departments; HTTPS-only private-deployment URLs); the official login link parameters; token caching, expiry and one refetch on token errors; non-members, interconnected IDs, inactive members and invalid codes refused; sub-department admission with and without recursion; directory email preferred over the placeholder; 503 on timeouts, HTTP errors and unexpected errcodes; the whole flow through the listener; `.invalid` registrations refused; a Chrome run against the mock login page.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** the provider and wiring. **Step 4: Run** unit, typecheck, e2e and doc gates; commit; push.

### Task 10: DingTalk Web Login Provider

**Files:** Create `src/sso/dingtalk.ts`, `tests/mock-dingtalk.ts`, `tests/dingtalk.spec.ts`, `tests/dingtalk-flow.spec.ts`; modify `src/sso/config.ts`, `src/sso/provider.ts`, `src/sso/plugin.ts`, `src/index.ts`, `tests/sso-config.spec.ts`, `tests/sso.e2e.ts`, the env example and the README pair.

**Interfaces:** Consumes the Task 5 plugin, which also accepts DingTalk's `authCode` callback parameter. Produces `createDingtalkProvider(config, { fetch?, clock? }): SsoProvider` with `kind: 'dingtalk'`, `dingtalkPlaceholderEmail(subject): string`, and the `dingtalk` variant of `SsoConfig` (`clientId`, `clientSecret`, `corpId`, `apiBase`, `oapiBase`, `loginUrl`, `exclusiveLogin`, `allowedGroups` as department IDs, `recursiveDepartments`, `timeoutMs`). The subject is `CORPID:unionId`.

- [ ] **Step 1: Write failing tests**: environment parsing (required app key, secret, corp ID and numeric departments; HTTPS-only private URLs; exclusive login); the official authorize link parameters; app-token caching and one refetch when revoked; another organization, non-members, external contacts, inactive members and refused codes; sub-department walk with and without recursion; directory email preferred over the placeholder; 503 on timeouts, HTTP errors, unexpected errcodes and missing departments; the whole flow through the listener; a Chrome run against the mock authorize page.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** the provider and wiring. **Step 4: Run** unit, typecheck, e2e and doc gates; commit; push.

### Task 11: SAML 2.0 Service Provider

**Files:** Create `src/sso/saml.ts`, `tests/mock-saml.ts`, `tests/saml.spec.ts`, `tests/saml-flow.spec.ts`; modify `src/sso/config.ts`, `src/sso/provider.ts`, `src/sso/store.ts`, `src/server.ts`, `src/index.ts`, `tests/helpers.ts`, `tests/sso-config.spec.ts`, `tests/sso.e2e.ts`, `package.json` (exact `@node-saml/node-saml`, `@xmldom/xmldom`, `xpath`; `xml-crypto` for the mock only), the env example and the README pair.

**Interfaces:** Consumes the Task 5 plugin through the ACS: `/api/auth/sso/acs` re-posts the IdP's cross-site form from the service origin, then hands `SAMLResponse` and `RelayState` to the shared callback as `code` and `state`. Produces `createSamlProvider(config, { acsUrl, replay, clock? }): SsoProvider` with `kind: 'saml'` and `metadata()`, `samlPlaceholderEmail(subject): string`, `SsoStore.useAssertion(id, expiresAt, now)`, and the `saml` variant of `SsoConfig`. The subject is `IDP_ENTITY_ID|NameID`.

- [ ] **Step 1: Write failing tests** with keys generated per run by openssl: environment parsing (pinned certificate file, refused private key, NameID formats, skew bound); the Redirect-binding AuthnRequest; signed Response, signed Assertion and both; unsigned, foreign-key and wrapped responses; Issuer, Audience, Recipient, Destination and InResponseTo; the time window with skew; assertion replay, transient NameID and IdP error status; SP metadata; the cross-site post bounce, missing cookie, IdP-initiated post and the group allow-list through the listener; a Chrome run with the IdP on another site.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** the provider, ACS and wiring. **Step 4: Run** unit, typecheck, e2e and doc gates; commit; push.

### Task 12: LDAP / AD Provider

**Files:** Create `src/sso/ldap.ts`, `tests/mock-ldap.ts`, `tests/ldap.spec.ts`, `tests/ldap-flow.spec.ts`; modify `src/sso/config.ts`, `src/sso/provider.ts`, `src/sso/plugin.ts`, `src/pages.ts`, `src/index.ts`, `src/auth.ts`, `package.json`, `tests/sso-config.spec.ts`, `tests/sso.e2e.ts`, the README, the env example and the design.

**Interfaces:** Adds `PasswordSsoProvider` (`kind: 'ldap'`, `authenticate({ username, password })`) beside the redirect `SsoProvider`, and `POST /api/auth/sso/ldap/sign-in` to the Task 5 plugin, which feeds the same allow-list, binding and session step. Produces `createLdapProvider(config)`, `escapeFilterValue`, `escapeDnValue`, `formatObjectGuid`, `ldapPlaceholderEmail`, `normalizeDn` and the `ldap` variant of `SsoConfig`. The subject is `SERVER_ID|objectGUID` or `SERVER_ID|entryUUID`.

- [ ] **Step 1: Write failing tests** against a 127.0.0.1 mock LDAP server with a CA generated per run: environment parsing (TLS required, loopback-only plain LDAP, CA file, filter balance, AD-only nested mode); RFC 4515 and RFC 4514 escaping; LDAPS and StartTLS with the pinned CA; injection attempts; empty password; disabled AD account; memberOf, nested and search group modes; generic errors, lockout and 503 on timeout through the listener; a Chrome run of the login form.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** the provider, endpoint, form and wiring. **Step 4: Run** unit, typecheck, e2e and doc gates; commit; push.

### Task 13: SAML Signed Requests and Encrypted Assertions

**Files:** Modify `src/sso/config.ts`, `src/sso/saml.ts`, `tests/mock-saml.ts`, `tests/saml.spec.ts`, `tests/saml-flow.spec.ts`, `tests/sso-config.spec.ts`, `package.json` (dev: `xml-encryption`, `@types/xml-encryption`), the README, the env example and the design.

**Interfaces:** `SpKeyPair { key, cert }`; the `saml` variant of `SsoConfig` gains optional `signing` and `decryption`. Settings: `DSH_SAML_SIGN_REQUESTS`, `DSH_SAML_SP_SIGNING_KEY[_FILE]`, `DSH_SAML_SP_SIGNING_CERT[_FILE]`, `DSH_SAML_ENCRYPTED_ASSERTIONS`, `DSH_SAML_SP_DECRYPTION_KEY_FILE`, `DSH_SAML_SP_DECRYPTION_CERT_FILE`.

- [ ] **Step 1: Write failing tests** with keys generated per run: key file permission, symlink, owner and pairing checks; env-only signing key; decryption key refused from the environment; flags without keys and keys without flags; the mock IdP verifying the redirect signature and refusing unsigned or foreign-key requests; encrypted assertions with each signing mode; plain, foreign-key and unsigned encrypted assertions refused; metadata KeyDescriptors; the full flow through the listener.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement**. **Step 4: Run** unit, typecheck, e2e and doc gates; commit.

### Task 14: Persistent Sign-in Lockouts

**Files:** Modify `src/sso/store.ts`, `src/database.ts`, `src/sso/plugin.ts`, `src/server.ts`, `src/index.ts`; create `tests/auth-failure.spec.ts`; extend `tests/ldap-flow.spec.ts` and `tests/emergency.spec.ts`.

**Interfaces:** `SsoStore.reserveAttempt(limits, windowMs, now)`, `releaseAttempt(ids)`, `clearFailures(key)`, `failureCount(key, since)`, `pruneFailures(now, windowMs)`; `IdentityDatabase.prune(now, failureWindowMs)`; `EMERGENCY_LOCKOUT`. Table `dsh_auth_failure` holds hashed keys.

- [ ] **Step 1: Write failing tests**: per-key limits, release and clear, the sliding window, hashed keys; survival across reopen; pruning of failure and fixed-window rows; four processes racing for five slots; LDAP lockout across a service restart; emergency lockout across a restart, with outside addresses not counting.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement** reservation before the directory call, release on success or outage, and the ten-minute prune timer. **Step 4: Run** gates; commit.

### Task 15: Automatic Deprovisioning

**Files:** Create `src/sso/deprovision.ts`, `src/sso-cli.ts`, `tests/deprovision.spec.ts`; modify `src/sso/store.ts`, `src/sso/provider.ts`, `src/sso/ldap.ts`, `src/sso/wecom.ts`, `src/sso/dingtalk.ts`, `src/sso/plugin.ts`, `src/sso/config.ts`, `src/config.ts`, `src/server.ts`, `src/index.ts`, `package.json` (bin `dsh-identity-sso`), `tests/mock-ldap.ts`.

**Interfaces:** `DirectoryLookup.lookup(subject)` returning `DirectoryRecord` (`active` with groups, `disabled`, `missing`) or undefined for a foreign subject; `reconcileOnce(deps)` returning `ReconcileReport`; `SsoStore.listLinks`, `touchLogin`, `disabledAt`, `disableUser`, `enableUser`, `listDisabled`; `DeprovisionConfig` from `DSH_SSO_RECONCILE_INTERVAL_MINUTES`, `DSH_SSO_MAX_INACTIVE_DAYS`, `DSH_SSO_RECONCILE_MAX_DISABLE`; `sessionHandler(auth, disabled)`.

- [ ] **Step 1: Write failing tests**: missing, disabled and out-of-group answers disable, revoke sessions and audit; lookup errors and an unreachable directory disable nobody; a mass result aborts; the inactivity policy; the in-place column migration; LDAP lookups by objectGUID bytes and entryUUID; WeCom and DingTalk status and department changes; live session revoked through the listeners; sign-in refused until the CLI enables; the scheduler in the service; environment bounds.
- [ ] **Step 2: Run**; expect failure. **Step 3: Implement**. **Step 4: Run** gates; commit; push.
