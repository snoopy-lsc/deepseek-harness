---
description: "Better Auth registration, verified email sessions and account pages for native public Harness, with a private session socket for the router."
kind: "package-library"
---

# @public-harness/identity

English | [中文](README.zh.md)

## Summary

Run public registration and browser sessions for a native Harness deployment. Better Auth stores accounts and sessions in a private SQLite file. Email verification is required before sign-in, and verification and reset links are single-use. Admission limits persist in the database. The router checks the live session on every request and WebSocket handshake through a private Unix socket. Website signup alone creates no Linux account, instance or model grant, and public enrollment is closed unless an operator opens it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`parseIdentityConfig` takes `mode` (`production` or `local`), the exact `publicOrigin`, two Unix sockets (`publicSocket` for the HTTPS proxy, `sessionSocket` for the router, with `sessionSocketGid`), `databaseFile`, `secretFile`, `mail`, `captcha`, `limits`, session and verification lifetimes, the trusted proxy's `clientIpHeader`, and optional `enrollmentOpen` (default false). Production requires an HTTPS origin, `sendmail` delivery and Cloudflare Turnstile. It rejects the `mailbox` and `test` transports, which exist only for loopback local runs. `startIdentity(config)` opens or creates the database with mode 0600, applies the Better Auth schema migration, and listens on both sockets. The Cordis `apply` reads the same JSON from `configFile`.

The proxy forwards `/api/auth/*` and `/account/*` to `publicSocket` and never exposes `sessionSocket`. The router selects this mode with `identity.kind: better-auth` in its production file; see [router native identity](../router/src/native-identity.ts).

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Before Better Auth sees a request, the public listener checks that Host equals the configured origin, rejects a foreign `X-Forwarded-Host` or any `Forwarded` header, refuses more than one session cookie, and requires the exact Origin on every state-changing request. Signup checks the enrollment switch, the CAPTCHA response and two persistent fixed-window counters (per client address and per day). Sign-in and reset requests have their own counters. Counters use `BEGIN IMMEDIATE`, so two service processes cannot both take the last unit. Verification links are signed and stateless in Better Auth, so the service records a hash of each one used and refuses a replay. Reset tokens are deleted on use, and a reset revokes the account's sessions.

Sessions are database rows with cookie caching disabled, so sign-out and revocation apply on the next lookup. `POST /internal/session` takes `{ cookie }` (at most 8 KiB) and answers `{ userId, sessionId, expiresAt }` only for a live session of a verified user. It answers 401 for anything else and 503 when the store fails. Telemetry is disabled, and startup refuses `BETTER_AUTH_TELEMETRY`, because that variable would override the option. Account pages are server-rendered with an escaped English/Chinese dictionary and one nonce-bound script under a strict Content-Security-Policy. After sign-in they link only to the user's own `/u/<id>/` route; see `safeReturnPath`.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [native deployment design](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.md), the [identity plan](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-identity.md) and [Better Auth](https://www.better-auth.com/docs).

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Account pages are server-rendered HTML rather than a React bundle. They contribute no Harness UI changes.
- The `sendmail` transport and Turnstile verification have not been exercised against real providers. Local tests use the in-memory mailbox and the fixed test CAPTCHA.
- `node:sqlite` is still marked experimental in Node 22 and prints a warning at startup.

<a id="dev-note"></a>
## Dev Note

`registration.spec.ts` runs the real service on temporary sockets. `registration.e2e.ts` drives a real Chrome through register, verify, sign-in, Harness entry and sign-out when `PUBLIC_HARNESS_E2E_BROWSER` names a Chrome executable.
