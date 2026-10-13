---
description: "Better Auth registration, verified email sessions and account pages for native public Harness, with pluggable mainland-China-ready CAPTCHA and mail providers, invite-only mode, enterprise OIDC sign-in with an administrator emergency path, and a private session socket for the router."
kind: "package-library"
---

# @public-harness/identity

English | [中文](README.zh.md)

## Summary

Run public registration and browser sessions for a native Harness deployment. Better Auth stores accounts and sessions in a private SQLite file. Email verification is required before sign-in, and verification and reset links are single-use. Admission limits persist in the database. The router checks the live session on every request and WebSocket handshake through a private Unix socket. Human verification and mail are pluggable providers chosen by environment variables: Alibaba Cloud Captcha 2.0, Tencent Cloud TianYu Captcha, Cloudflare Turnstile, or invite-only registration, and sendmail or an authenticated TLS SMTP relay such as Alibaba Cloud DirectMail or Tencent Cloud SES. Website signup alone creates no Linux account, instance or model grant, and public enrollment is closed unless an operator opens it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`parseIdentityConfig(file, env)` takes the JSON file and the process environment. The file holds `mode` (`production` or `local`), the exact `publicOrigin`, two Unix sockets (`publicSocket` for the HTTPS proxy, `sessionSocket` for the router, with `sessionSocketGid`), `databaseFile`, `secretFile`, `limits`, session and verification lifetimes, the trusted proxy's `clientIpHeader`, and optional `enrollmentOpen` (default false). Mail and CAPTCHA settings come only from the environment, and the file refuses `mail` or `captcha` keys. Production requires an HTTPS origin and refuses the `mailbox` mail provider and the `test` CAPTCHA, which exist only for loopback local runs. `startIdentity(config)` opens or creates the database with mode 0600, applies the Better Auth schema migration, and listens on both sockets. The Cordis `apply` reads the JSON from `configFile` and the providers from `process.env`. On the native host, systemd loads them from the operator-created `/etc/dsh-public/identity-secrets/identity.env` (root, 0600); see [identity.env.example](../../deploy/native/config/identity.env.example).

### Providers

An unknown provider, a missing or malformed variable, or a mismatched endpoint refuses startup. The error names the variable and never its value. Secrets never appear in the repository, the configuration file or the rendered pages.

| `DSH_CAPTCHA_PROVIDER` | Variables | Server check |
| --- | --- | --- |
| `aliyun` | `DSH_ALIYUN_CAPTCHA_ACCESS_KEY_ID`, `DSH_ALIYUN_CAPTCHA_ACCESS_KEY_SECRET`, `DSH_ALIYUN_CAPTCHA_SCENE_ID`, `DSH_ALIYUN_CAPTCHA_PREFIX` (instance identity), optional `DSH_ALIYUN_CAPTCHA_REGION` (`cn` default, or `sgp`) and `DSH_ALIYUN_CAPTCHA_ENDPOINT` (the region's IPv4, dual-stack or VPC host) | [`VerifyIntelligentCaptcha`](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access) 2023-03-05, form body `CaptchaVerifyParam` + `SceneId`, signed with [ACS3-HMAC-SHA256](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature); passes only on `Result.VerifyResult === true` |
| `tencent` | `DSH_TENCENT_CAPTCHA_SECRET_ID`, `DSH_TENCENT_CAPTCHA_SECRET_KEY` (CAM API key), `DSH_TENCENT_CAPTCHA_APP_ID`, `DSH_TENCENT_CAPTCHA_APP_SECRET_KEY` | [`DescribeCaptchaResult`](https://cloud.tencent.com/document/product/1110/36926) 2019-07-22 at `captcha.tencentcloudapi.com`, `CaptchaType` 9 with ticket, randstr and client address, signed with [TC3-HMAC-SHA256](https://www.tencentcloud.com/document/product/1080/38766); passes only on `CaptchaCode === 1` |
| `turnstile` | `DSH_TURNSTILE_SITE_KEY`, `DSH_TURNSTILE_SECRET_KEY` | [siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) |
| `none` | none | Invite-only: sign-up needs a valid invite code instead of a CAPTCHA |
| `test` | `DSH_CAPTCHA_TEST_TOKEN` | Local mode only |

`DSH_CAPTCHA_TIMEOUT_MS` (default 5000) bounds each verification call. A timeout, a transport failure, an HTTP error or an API-level error (bad signature, unpaid instance) answers 503 and admits nothing. A wrong, expired or reused ticket answers 400.

| `DSH_MAIL_PROVIDER` | Variables |
| --- | --- |
| `smtp` | `DSH_SMTP_HOST`, `DSH_SMTP_PORT`, `DSH_SMTP_SECURITY` (`tls` for implicit TLS or `starttls`; there is no plaintext mode), `DSH_SMTP_USER`, `DSH_SMTP_PASSWORD`, `DSH_MAIL_FROM`, optional `DSH_SMTP_TIMEOUT_MS` (default 15000) |
| `sendmail` | `DSH_SENDMAIL_COMMAND`, `DSH_MAIL_FROM` |
| `mailbox` | `DSH_MAILBOX_DIR`, `DSH_MAIL_FROM`; local mode only |

SMTP endpoints: [Alibaba Cloud DirectMail](https://help.aliyun.com/zh/direct-mail/smtp-endpoints) uses `smtpdm.aliyun.com` on 465 with `tls`, or 80/25 with `starttls`; the user is the sender address and the password is the SMTP password set in the console. [Tencent Cloud SES](https://cloud.tencent.com/document/product/1288/65750) uses `smtp.qcloudmail.com` (or `gz-smtp.qcloudmail.com`) on 465 with `tls`, or 25 with `starttls`. Cloud servers in both clouds block outbound port 25 by default.

### Invite-only registration

With `DSH_CAPTCHA_PROVIDER=none`, the register page asks for an invite code and sends it as `X-Invite-Code`. Registration is never public in this mode, so `enrollmentOpen` does not apply. Each code admits one account, and the per-address and daily signup limits still apply. Mint codes as the service account:

```sh
sudo -u dsh-identity node /opt/dsh-public/integration/packages/identity/lib/invite-cli.js --config /etc/dsh-public/identity.json mint --ttl-hours 72 --count 5 --note "wave 1"
sudo -u dsh-identity node …/invite-cli.js --config /etc/dsh-public/identity.json list
sudo -u dsh-identity node …/invite-cli.js --config /etc/dsh-public/identity.json revoke <id>
```

`mint` prints each code once. The database keeps only a SHA-256 hash, an ID, the expiry, the note and, after use, the time and the registering email. `list` never shows codes.

The proxy forwards `/api/auth/*` and `/account/*` to `publicSocket` and never exposes `sessionSocket`. The router selects this mode with `identity.kind: better-auth` in its production file; see [router native identity](../router/src/native-identity.ts).

### Enterprise SSO

`DSH_SSO_PROVIDER=oidc` turns on enterprise sign-in for a single-enterprise deployment; unset or `off` changes nothing. `DSH_OIDC_ISSUER` (HTTPS), `DSH_OIDC_CLIENT_ID`, `DSH_OIDC_CLIENT_SECRET` and a non-empty `DSH_SSO_ALLOWED_GROUPS` are required. `DSH_OIDC_SCOPES` (default `openid email profile`), `DSH_OIDC_GROUP_CLAIMS` (default `groups`, comma-separated claim names) and `DSH_OIDC_TIMEOUT_MS` are optional. Register `<publicOrigin>/api/auth/sso/callback` at the IdP as the redirect URI of a confidential client. The login page then shows "Sign in with your company account". The first sign-in of a member of an allowed group creates an account with a verified email, bound to the IdP `sub`; later sign-ins find it by that binding only. An email already held by another account refuses the sign-in instead of merging. Public sign-up is closed. With `DSH_CAPTCHA_PROVIDER=none`, invited contractors still register and sign in with a password, but their accounts can never be bound to an enterprise subject. Sign-out ends only the Harness session. See the [design](../../../../docs/superpowers/specs/2026-10-13-enterprise-sso-design.md) and the [plan](../../../../docs/superpowers/plans/2026-10-13-enterprise-sso.md).

#### WeCom

`DSH_SSO_PROVIDER=wecom` uses WeCom web login for a self-built app. `DSH_WECOM_CORP_ID`, `DSH_WECOM_AGENT_ID`, `DSH_WECOM_SECRET` and `DSH_SSO_ALLOWED_GROUPS` (department IDs) are required. Set the app's trusted domain to the public host. Sub-departments of an allowed department are admitted unless `DSH_WECOM_DEPARTMENT_RECURSIVE=false`. A private deployment sets `DSH_WECOM_API_BASE` and `DSH_WECOM_LOGIN_URL` to its HTTPS server. Accounts are bound to `CORPID:userid` (lower case). When the app cannot read the member's email, the account gets a unique `@sso.invalid` placeholder; registration refuses `.invalid` addresses. The access token stays in memory and is refetched once when WeCom revokes it. Timeouts and unexpected errors answer 503.

#### DingTalk

`DSH_SSO_PROVIDER=dingtalk` uses DingTalk's OAuth 2.0 web login for an internal app. `DSH_DINGTALK_CLIENT_ID` (AppKey), `DSH_DINGTALK_CLIENT_SECRET`, `DSH_DINGTALK_CORP_ID` and `DSH_SSO_ALLOWED_GROUPS` (department IDs) are required. Register `<publicOrigin>/api/auth/sso/callback` as the app's redirect URL and grant it member read permission. Only users who pick the configured organization on the consent page get in. Sub-departments are admitted unless `DSH_DINGTALK_DEPARTMENT_RECURSIVE=false`. Accounts are bound to `CORPID:unionId`. Email and the `@sso.invalid` placeholder follow the WeCom rule. Private deployments set `DSH_DINGTALK_LOGIN_URL`, `DSH_DINGTALK_API_BASE` and `DSH_DINGTALK_OAPI_BASE`, and `DSH_DINGTALK_EXCLUSIVE_LOGIN=true` opens the exclusive-account (专属账号) login page. Timeouts and unexpected errors answer 503.

#### SAML 2.0

`DSH_SSO_PROVIDER=saml` makes the service a SAML Service Provider. `DSH_SAML_SP_ENTITY_ID`, `DSH_SAML_IDP_ENTITY_ID`, `DSH_SAML_IDP_SSO_URL` (HTTPS), `DSH_SAML_IDP_CERT_FILE` (the IdP signing certificates in PEM, pinned) and `DSH_SSO_ALLOWED_GROUPS` are required. Give the IdP `<publicOrigin>/api/auth/sso/metadata`, or the entity ID and the ACS `<publicOrigin>/api/auth/sso/acs`. The IdP must sign the Response or the Assertion (`DSH_SAML_WANT_ASSERTIONS_SIGNED=true` requires the Assertion) and send a persistent NameID unless `DSH_SAML_NAMEID_FORMAT` says `emailAddress` or `unspecified`. Accounts are bound to `IDP_ENTITY_ID|NameID`. Groups come from `DSH_SAML_GROUP_ATTRIBUTE` (default `groups`), email from `DSH_SAML_EMAIL_ATTRIBUTE` (default `email`) with the `@sso.invalid` placeholder otherwise, and the name from `DSH_SAML_NAME_ATTRIBUTE`. Only SP-initiated sign-in works; `DSH_SAML_CLOCK_SKEW_MS` (default 60000) sets the allowed clock skew. When the IdP requires signed AuthnRequests, set `DSH_SAML_SIGN_REQUESTS=true` with `DSH_SAML_SP_SIGNING_KEY_FILE` (or `DSH_SAML_SP_SIGNING_KEY`) and `DSH_SAML_SP_SIGNING_CERT_FILE` (or `DSH_SAML_SP_SIGNING_CERT`). When it encrypts assertions, set `DSH_SAML_ENCRYPTED_ASSERTIONS=true` with `DSH_SAML_SP_DECRYPTION_KEY_FILE` and `DSH_SAML_SP_DECRYPTION_CERT_FILE`; plain assertions are then refused. Key files must be owned by the service user, not symlinks, and closed to group and others (`chmod 600`); keys are RSA, 2048 bits or more, and must match their certificates. Metadata publishes both certificates.

#### LDAP / Active Directory

`DSH_SSO_PROVIDER=ldap` replaces the start link with a username and password form that posts to `/api/auth/sso/ldap/sign-in`. `DSH_LDAP_URL` (`ldaps://`, or `ldap://` with `DSH_LDAP_STARTTLS=true`), `DSH_LDAP_BIND_DN`, `DSH_LDAP_BIND_PASSWORD`, `DSH_LDAP_BASE_DN` and `DSH_SSO_ALLOWED_GROUPS` (group DNs separated by `;`) are required. Plain `ldap://` starts only in local mode against a loopback host. `DSH_LDAP_CA_FILE` pins the directory's CA. `DSH_LDAP_SCHEMA` is `ad` (default) or `openldap` and picks defaults for the user filter, username attribute (`sAMAccountName` or `uid`), immutable ID (`objectGUID` or `entryUUID`) and group class; each has its own `DSH_LDAP_*` override. The service account finds exactly one user, then the service binds as that user with one connection per login. Accounts are bound to `SERVER_ID|immutable id`. Groups come from `memberOf`, from nested membership in AD (`DSH_LDAP_GROUP_MODE=nested`) or from a group search (`search`). Disabled AD accounts are refused, empty passwords never reach the server, and every credential failure gets the same message. Email follows the `@sso.invalid` placeholder rule. Repeated failures lock the username for 15 minutes, counted in the identity database so restarts and other processes share them; timeouts (`DSH_LDAP_TIMEOUT_MS`, default 5000) and directory errors answer 503.

#### Deprovisioning and lockouts

Every `DSH_SSO_RECONCILE_INTERVAL_MINUTES` (default 60; 0 turns it off) the service checks every SSO-bound account. LDAP/AD, WeCom and DingTalk accounts are looked up in the directory: a deleted, disabled or resigned user, or one outside every allowed group or department, is disabled. With `DSH_SSO_MAX_INACTIVE_DAYS` set, accounts of any provider that have not signed in for that many days are disabled too; for OIDC and SAML this is the only automatic check. Disabling deletes the user's sessions at once, blocks new sign-ins and writes an audit row. A lookup error or an unreachable directory never disables anyone, and a run that would disable more than `DSH_SSO_RECONCILE_MAX_DISABLE` (default 10) users from directory answers disables none and is audited as aborted. Operators use `dsh-identity-sso --config <identity.json> disable --email ADDRESS [--reason TEXT]`, `enable --email ADDRESS` and `list-disabled`; re-enabling is never automatic.

LDAP lockouts (5 failures per username and IP, 20 per username, in 15 minutes) and the emergency path lockout (5 failures per account in 15 minutes, counted only from allowed addresses) are kept in the identity database with hashed keys, so they survive restarts. Expired rows are deleted every ten minutes.

`DSH_SSO_EMERGENCY_ALLOWED_IPS` (IPs or CIDR prefixes) enables `/account/emergency` for administrators when the IdP is down. Enrollment needs an existing password account with a verified email, for example an invited one, and prints a TOTP URI once:

```sh
sudo -u dsh-identity node /opt/dsh-public/integration/packages/identity/lib/emergency-cli.js --config /etc/dsh-public/identity.json enroll --email admin@corp.example
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json list
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json audit --days 30
sudo -u dsh-identity node …/emergency-cli.js --config /etc/dsh-public/identity.json revoke --email admin@corp.example
```

`DSH_ADMIN_EMAILS` lists administrator addresses, comma-separated; emergency accounts are administrators as well. A malformed entry refuses startup. `GET /account/api/me` answers the signed-in user's `{ id, email, name, role }` with `role` `admin` or `member`; Harness Web reads it to show the administration entry, and administrator APIs re-check the role on the server.

An emergency sign-in needs an allowed source address, the password and a fresh authenticator code; each code works once. The ordinary password form refuses enrolled administrators. Every SSO and emergency attempt is audited, and rows older than 365 days are deleted.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Before Better Auth sees a request, the public listener checks that Host equals the configured origin, rejects a foreign `X-Forwarded-Host` or any `Forwarded` header, refuses more than one session cookie, and requires the exact Origin on every state-changing request. Signup checks the enrollment switch and the CAPTCHA response, or in invite mode the invite code, and two persistent fixed-window counters (per client address and per day). An invite is claimed with one conditional `UPDATE` (unused, unrevoked, unexpired), so concurrent signups cannot share a code. It is released when Better Auth rejects the registration, the same way a used verification link is released when its request fails. Sign-in and reset requests have their own counters. Counters use `BEGIN IMMEDIATE`, so two service processes cannot both take the last unit. Verification links are signed and stateless in Better Auth, so the service records a hash of each one used and refuses a replay. Reset tokens are deleted on use, and a reset revokes the account's sessions.

Sessions are database rows with cookie caching disabled, so sign-out and revocation apply on the next lookup. `POST /internal/session` takes `{ cookie }` (at most 8 KiB) and answers `{ userId, sessionId, expiresAt }` only for a live session of a verified user. It answers 401 for anything else and 503 when the store fails. Telemetry is disabled, and startup refuses `BETTER_AUTH_TELEMETRY`, because that variable would override the option. Account pages are server-rendered with an escaped English/Chinese dictionary and one nonce-bound script under a strict Content-Security-Policy. The script loads the configured provider's SDK and sends its result as `X-Captcha-Response`: the Turnstile token, the Alibaba Cloud `captchaVerifyParam` unchanged, or Tencent's `{ticket, randstr}` as JSON. Tencent disaster-recovery tickets (`trerror…`) are not sent, and the server would refuse them. The page embeds only public widget parameters. The CSP adds exactly the SDK, frame, connect and image sources of that provider. Alibaba's API hosts are derived from the instance identity per the [allowlist](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/captcha-2-0-client-access-faq), and the [Tencent](https://cloud.tencent.com/document/product/1110/36828) SDK host is `turing.captcha.qcloud.com`. The Alibaba and Tencent SDKs inject inline styles, so those pages allow `'unsafe-inline'` styles and drop the style nonce. Scripts stay nonce-bound. After sign-in they link only to the user's own `/u/<id>/` route; see `safeReturnPath`.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [native deployment design](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.md), the [identity plan](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-identity.md) and [Better Auth](https://www.better-auth.com/docs).

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Account pages are server-rendered HTML rather than a React bundle. They contribute no Harness UI changes.
- No provider has been exercised against a real account. Tests mock provider HTTP and use a local TLS SMTP relay. The signing code matches the providers' published known-answer examples. The live API responses, the widget SDKs and the CSP source lists still need verification on a real host.
- With `none`, signing up with an already registered email address can consume an invite if Better Auth answers success to avoid revealing the account.
- SAML has been exercised only against the local mock IdP; real IdPs (Azure AD, Okta, ADFS), with signed AuthnRequests and encrypted assertions, still need a check. Single logout, metadata import and key rollover without a restart are not supported.
- LDAP has been exercised only against the local mock directory; a real AD or OpenLDAP still needs a check. The RFC 4514 DN escaper is unused because DNs come from search results.
- Deprovisioning polls the directory; there are no webhooks or SCIM. Real directories, large directories (one lookup per user per run) and WeCom or DingTalk API quotas still need a check. A disabled account is re-enabled only by an operator.
- DingTalk has been exercised only against the local mock; a real app, its redirect URL and private or exclusive deployments still need a check.
- WeCom has been exercised only against the local mock; a real corp, its trusted domain and private deployments still need a check. WeCom members without a readable email see the `@sso.invalid` placeholder on the account page.
- OIDC has been exercised only against the local mock IdP. Keycloak, Authing or Azure AD still need a real-host check. Group membership is checked at sign-in, so removing a user from a group stops new sessions but not a live one. Accounts created by public registration before SSO was enabled cannot sign in with a password in SSO mode.
- `node:sqlite` is still marked experimental in Node 22 and prints a warning at startup.

<a id="dev-note"></a>
## Dev Note

`registration.spec.ts` runs the real service on temporary sockets. `providers.spec.ts` covers mocked Alibaba Cloud, Tencent Cloud and Turnstile calls, fail-closed parsing, timeouts and the page CSP. `signing.spec.ts` holds the signature known-answer tests. `smtp.spec.ts` uses a local TLS and STARTTLS relay with a throwaway certificate, and `invite.spec.ts` covers single use, expiry, revocation, concurrency and the CLI. When `PUBLIC_HARNESS_E2E_BROWSER` names a Chrome executable, `registration.e2e.ts` drives a real Chrome through register, verify, sign-in, Harness entry and sign-out. `widgets.e2e.ts` runs each widget's glue in Chrome against intercepted SDK stubs. `sso-config`, `sso-store`, `totp`, `jwt`, `oidc`, `sso-flow` and `emergency` specs cover enterprise SSO against a 127.0.0.1 mock IdP with throwaway keys (`mock-oidc.ts`), `wecom` and `wecom-flow` specs cover WeCom against `mock-wecom.ts`, `dingtalk` and `dingtalk-flow` specs cover DingTalk against `mock-dingtalk.ts`, `saml` and `saml-flow` specs cover SAML against `mock-saml.ts` (keys generated per run with openssl), `ldap` and `ldap-flow` specs cover LDAP against `mock-ldap.ts` (a 127.0.0.1 BER server with a CA generated per run), `auth-failure` covers the persistent lockout counters (including four racing processes), `deprovision` covers reconciliation, directory lookups, session revocation and `sso-cli.ts`, and `sso.e2e.ts` drives Chrome through the OIDC, WeCom, DingTalk, SAML and LDAP sign-ins.
