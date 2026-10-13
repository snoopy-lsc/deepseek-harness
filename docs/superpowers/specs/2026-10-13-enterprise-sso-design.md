# Enterprise on-prem identity design

English | [中文](2026-10-13-enterprise-sso-design.zh.md)

## Summary

This is a design specification for review. It extends the identity service of the [native public Harness deployment](2026-10-11-public-harness-native-design.md) with enterprise on-prem authentication. The intended customer runs Harness on one or a few dedicated Linux hosts inside a corporate network. Employees sign in with WeCom (企业微信) QR login, DingTalk (钉钉) QR login, OIDC, SAML 2.0, or LDAP/AD, rather than through public self-registration on the internet.

The design follows the pluggable CAPTCHA and mail pattern already shipped in [cn-providers](../../../integrations/public-harness/packages/identity/README.md): each protocol is an identity-service provider, secrets come only from environment variables, and an unknown or incomplete configuration refuses to start. Better Auth still owns sessions, cookies, and the private session lookup. An enterprise principal maps to an immutable Harness `UserId`. This document does not contain implementation code and does not change public registration, Turnstile / Alibaba / Tencent CAPTCHA, or SMTP delivery. Enterprise mode is a deployment choice; how it combines with the public path is left to the decision checklist.

## Contents

- [Goals and non-goals](#goals-and-non-goals)
- [Provider interface and configuration](#provider-interface-and-config)
- [Per-provider flow outlines](#per-provider-flows)
- [Integration with Better Auth and existing identity](#better-auth-integration)
- [Security requirements](#security)
- [Mainland China reachability](#mainland-china-reachability)
- [Phased rollout and test strategy](#phased-rollout-and-tests)
- [Decision points for the user](#decision-points)
- [Sources](#sources)

<a id="goals-and-non-goals"></a>
## Goals and non-goals

### Goals

- Add a pluggable enterprise login provider on `@public-harness/identity`, selected at deploy time through environment variables (one provider by default; more only if a decision point allows it).
- After a successful enterprise sign-in, issue a Better Auth session with the same shape as email/password login so the router keeps verifying sessions over the private Unix socket.
- Map a stable enterprise subject to an immutable Harness user ID; instance creation, quotas, and storage stay keyed by that ID.
- Provide an admin emergency password path: few operators, strong gating, auditable; everyday employees must not rely on a local password.
- Keep secrets and certificates in host environment variables or root-owned secret files; never in the repository, generated config, or rendered pages.
- Fail closed: an unknown provider, missing secret, failed certificate check, or unreachable IdP refuses startup or login; never degrade to anonymous access or public registration.

### Non-goals

- No public social login (consumer WeChat Open Platform, GitHub, Google, Apple, and similar).
- Never store enterprise directory passwords in cleartext or reversible form; LDAP bind passwords are discarded after use.
- Password login is not a day-to-day path; ordinary employees have no local password or have password auth disabled.
- This design does not implement multi-tenant SaaS (many unrelated enterprises sharing one identity database with tenant isolation). The default assumption is **one enterprise, one deployment** (see decision point D1).
- Do not replace Better Auth, move session authority to the IdP, or let the router trust IdP assertions directly.
- Do not implement WeCom/DingTalk in-app silent login for mini programs or embedded H5; this design covers **website QR login** and standard federation. In-app silent login can be a later extension.
- Do not change the public CAPTCHA (`turnstile` / `aliyun` / `tencent` / `none`) or mail (`sendmail` / `smtp`) provider interfaces. Enterprise deployments typically set `DSH_CAPTCHA_PROVIDER=none` with `enrollmentOpen=false`, or hide public registration entirely.

<a id="provider-interface-and-config"></a>
## Provider interface and configuration

### Deployment model

Same split as CAPTCHA and mail:

| Layer | Responsibility |
| --- | --- |
| Identity JSON config file | Topology and limits: `publicOrigin`, sockets, database path, `secretFile`, limits, `enrollmentOpen`, and so on. **No** `sso`, `ldap`, or enterprise secret fields. |
| Environment (`EnvironmentFile=`) | `DSH_SSO_PROVIDER` plus per-provider secrets, endpoints, and mapping rules. Unknown values or missing required variables → `IdentityConfigError`, refuse start. |
| Runtime provider | Shared port: start login, finish callback, resolve a stable principal, optionally load groups. Failures throw `IdentityUnavailableError` or return an explicit deny; never treat them as authenticated. |

Suggested prefix: `DSH_SSO_*`, loaded from the same `identity.env` as `DSH_CAPTCHA_*`, `DSH_MAIL_*`, and `DSH_SMTP_*`.

### Suggested provider enum

| `DSH_SSO_PROVIDER` | Meaning | Typical variables (illustrative) |
| --- | --- | --- |
| `off` (default) | Enterprise login disabled; keep email / invite behaviour | none |
| `wecom` | WeCom website QR login | `DSH_WECOM_CORP_ID`, `DSH_WECOM_AGENT_ID`, `DSH_WECOM_SECRET` |
| `dingtalk` | DingTalk website QR login | `DSH_DINGTALK_APP_KEY`, `DSH_DINGTALK_APP_SECRET` |
| `oidc` | OpenID Connect Authorization Code + PKCE | `DSH_OIDC_ISSUER`, `DSH_OIDC_CLIENT_ID`, `DSH_OIDC_CLIENT_SECRET` (if required), `DSH_OIDC_SCOPES` |
| `saml` | SAML 2.0 Service Provider | `DSH_SAML_SP_ENTITY_ID`, `DSH_SAML_IDP_METADATA_URL` or metadata file path, `DSH_SAML_SP_CERT_FILE`, `DSH_SAML_SP_KEY_FILE` |
| `ldap` | LDAP / Active Directory bind | `DSH_LDAP_URL`, bind DN template or search base, `DSH_LDAP_START_TLS`, optional `DSH_LDAP_GROUP_FILTER` |

Production refuses enterprise secrets in JSON. Local runs may use a mock provider (name TBD, e.g. `test`) that production mode must reject.

### Relation to CAPTCHA and mail

| Deployment shape | CAPTCHA | Mail | Registration | SSO |
| --- | --- | --- | --- | --- |
| Public internet | turnstile / aliyun / tencent, or none+invite | sendmail / smtp | may open via `enrollmentOpen` | `off` |
| Enterprise on-prem | prefer `none`; public `/account/register` closed | still usable for emergency password-reset mail if that path is on | `enrollmentOpen=false`; accounts via JIT on first SSO or operator pre-provision | `wecom` / `dingtalk` / `oidc` / `saml` / `ldap` |

Whether invite codes (`DSH_CAPTCHA_PROVIDER=none` mint CLI) remain for contractors without SSO is decision point D3.

### Suggested shared port (design-level, not code)

```text
EnterpriseAuthProvider
  kind: wecom | dingtalk | oidc | saml | ldap
  startLogin(request) -> Redirect | ChallengePage   // state/nonce/PKCE in short-lived server storage
  finishLogin(callback) -> EnterprisePrincipal      // validated stable principal
  optional refreshGroups(principal) -> string[]
  optional healthCheck() -> ok | unavailable
```

An `EnterprisePrincipal` includes at least `provider`, `subject` (stable unique key inside the IdP), optional `email` / `displayName`, and optional `groups`. The Harness user ID is **not** the email or display name; it is derived from `(provider, subject)` or allocated on first insert into the same immutable ID space as today’s Better Auth `user.id` / branded `UserId`.

<a id="per-provider-flows"></a>
## Per-provider flow outlines

### WeCom QR login (`wecom`)

Per WeCom docs on [building the QR login link](https://developer.work.weixin.qq.com/document/path/91022) and [fetching the visitor identity](https://developer.work.weixin.qq.com/document/path/91023):

1. The account page starts login; the service stores an unguessable `state` (bound to expiry and optionally client IP) and redirects to `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=CORPID&agentid=AGENTID&redirect_uri=...&state=STATE`.
2. After the user scans and confirms, WeCom redirects to `redirect_uri` with `code` and `state` (domain must match the app trusted domain exactly).
3. The service consumes `state` once; obtains `access_token` with `corpid` + `corpsecret` ([gettoken](https://developer.work.weixin.qq.com/document/path/91039), must be cached; never return the token to the browser).
4. Exchange `code` via `auth/getuserinfo` for corporate `userid`; optionally load member details. Non-members (openid only) are denied by default unless a decision point allows external contacts.
5. Use `userid` (normalize interconnected `CorpId/userid` forms) as `subject`, then link accounts and issue a session.

Embedded `WwLogin` JS is an optional same-origin UI; it still uses the same callback and `state` checks.

### DingTalk QR login (`dingtalk`)

Per [scan QR to log on to third-party websites](https://open.dingtalk.com/document/orgapp/scan-qr-code-to-log-on-to-third-party-websites) and [get user info by sns temporary code](https://open.dingtalk.com/document/orgapp/obtain-the-user-information-based-on-the-sns-temporary-authorization):

1. Redirect to `https://oapi.dingtalk.com/connect/qrconnect?appid=APPID&response_type=code&scope=snsapi_login&state=STATE&redirect_uri=...`.
2. On callback, validate `state`, then call `https://oapi.dingtalk.com/sns/getuserinfo_bycode` with `accessKey`, timestamp, and HMAC signature to obtain `unionid` / `openid`.
3. If a corporate `userid` is required, call `topapi/user/getbyunionid` (and related APIs) with the enterprise app token; **prefer the stable corporate userid documented by DingTalk as `subject`**, not a mutable nickname.
4. Keep AppSecret only in the environment; honour the documented timestamp skew limits.

### OIDC (`oidc`)

Authorization Code Flow + PKCE ([RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749), [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)):

1. Discover `{issuer}/.well-known/openid-configuration` (HTTPS issuer; plaintext forbidden in production).
2. Authorization request carries `state`, `nonce`, and S256 `code_challenge`; store the verifier server-side.
3. Callback validates `state`; exchange `code` + verifier (and client secret for confidential clients) at the token endpoint.
4. Validate `id_token`: JWKS signature, `iss`, `aud`, `exp`, `nonce`; use `sub` as `subject`.
5. Optional UserInfo / group claims; group → role mapping is deny-by-default for admin powers (see Security).

Works with public or customer-hosted IdPs (Keycloak, Authing private cloud, cloud IDaaS, and similar).

### SAML 2.0 SP (`saml`)

Identity service as Service Provider ([SAML 2.0](http://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html)):

1. At startup, load IdP metadata (HTTPS URL with certificate checks, or a root-owned read-only file); configure SP entityID and ACS (e.g. `https://<publicOrigin>/api/auth/sso/saml/acs`).
2. Login: emit AuthnRequest with `RelayState` bound to short-lived server storage (CSRF defence); redirect to IdP SSO URL.
3. ACS: verify signature, expiry, Audience, Recipient, InResponseTo; reject unsigned or mismatched assertions.
4. NameID or a configured Attribute becomes `subject`; optional attribute → group mapping.
5. SP signing cert/key only from `*_CERT_FILE` / `*_KEY_FILE` (mode 0600), never from the repo.

### LDAP / AD (`ldap`)

1. Collect username on the login page (passwords must not enter front-end logs); open `DSH_LDAP_URL` with StartTLS or LDAPS and verify certificates.
2. Resolve the user DN (search account or DN template), then bind as that DN with the supplied password; success authenticates; **password never hits disk or logs**.
3. Optionally read `memberOf` / group filters for read-only mapping.
4. Fix one `subject` strategy at deploy time (`objectGUID`, `entryUUID`, or stable `sAMAccountName@domain`); do not drift.
5. Do not sync LDAP passwords into Better Auth password hashes except via the explicit emergency path, which is independent of the directory.

<a id="better-auth-integration"></a>
## Integration with Better Auth and existing identity

### Sessions and router

- On successful enterprise login, ensure a user row exists and issue the same Better Auth session cookie as email login (`dsh-account` prefix, `Secure` in production, cookie cache off).
- The router keeps calling `POST /internal/session`; it **must not** parse SAML/OIDC tokens or trust enterprise headers from the browser.
- Sign-out revokes the Better Auth session; optional IdP SLO is decision point D5.

### Account linking and immutable UserId

Recommended policy (confirm in D2):

1. **First successful SSO**: create a Better Auth user whose `id` is a service-allocated immutable identifier (same ID space as today’s registration); store `(provider, subject) → userId` with a uniqueness constraint.
2. **Later logins**: look up only by `(provider, subject)` and refresh the session. Do not auto-merge by email unless an audited operator linking command says so.
3. **Email**: if the IdP supplies a verified email, store it as contact data; enterprise mode may skip the email-verification link because trust sits at the IdP (D4). Public email registration keeps `requireEmailVerification`.

### JIT provisioning vs allow-list

- **JIT (recommended default)**: SSO success creates the website account; it still does **not** create a Linux instance or model grant (same separation as today). First Harness entry still goes through router / provisioner admission.
- **Pre-provision**: operators import allowed `subject` values; SSO that is not on the list gets no session (stricter regulated deployments).

### Disable and offboarding

When an employee is disabled or removed in the IdP:

| Mechanism | Behaviour |
| --- | --- |
| Login-time probe (required) | On each SSO or on a schedule (OIDC UserInfo / WeCom member read / LDAP search), absence or disable → refuse new sessions and revoke all Better Auth sessions for that user. |
| Directory webhook / SCIM (later) | On disable events, revoke sessions and mark the account disabled. |
| Router | Next HTTP request or WebSocket reconnect returns 401; open sockets still obey the existing max lifetime. |
| Data | Workspaces stay until the operator’s confirmed deletion flow (same suspend vs delete split as the native design); SSO disable is not an immediate purge. |

### Coexistence with invites and public registration

| Mode | Behaviour |
| --- | --- |
| SSO only (recommended enterprise default) | `DSH_SSO_PROVIDER≠off`, `enrollmentOpen=false`, register page hidden or redirected to SSO; `DSH_CAPTCHA_PROVIDER=none` without public invites (or invite CLI only on an ops network). |
| SSO + invited contractors | Employees use SSO; contractors without an enterprise identity register with invite codes. Same userId space, different account-link rows. Prevent invite users from forging an enterprise `subject` (D3). |
| SSO + emergency password | See below; not a second everyday password login. |

### Admin emergency password path

- **Who**: only principals on an allow-list (`DSH_SSO_EMERGENCY_USER_IDS` or a break-glass table); empty means disabled.
- **Gating**: separate URL (e.g. `/account/emergency`), not linked from the normal login page; optional second factor (TOTP / hardware key, D6); full audit (who, when, source IP, success/failure).
- **Storage**: Better Auth password hashes only; unrelated to the enterprise directory. Never sync LDAP passwords into this path.
- **Purpose**: recover platform operations when the IdP is down; after recovery, force SSO again and rotate the emergency password.
- **Audit**: append-only identity DB rows or host journal; retention is a deployment policy; never log the password.

<a id="security"></a>
## Security requirements

- **CSRF / state / nonce**: every browser-redirect provider (wecom, dingtalk, oidc, saml) uses server-stored one-time `state` (plus OIDC `nonce` and PKCE verifier). Bind expiry and optional client fingerprint; missing or mismatched callback → 400.
- **Callback validation**: `redirect_uri` / ACS are fixed paths under the configured `publicOrigin`; no open redirects. Keep today’s Host / Origin checks (`checkRequestOrigin`).
- **TLS**: outbound IdP / enterprise API calls use TLS with verification on. Production rejects cleartext LDAP bind (`ldap://` without StartTLS).
- **Certificates and secrets**: SAML SP keys, OIDC client secrets, WeCom/DingTalk secrets live only in the environment or 0600 files; errors name the variable, never the value.
- **Group-mapping privilege boundary**: IdP groups map to “may sign in as a normal user” by default. Mapping to provisioner-admin or emergency-password-admin roles requires an explicit allow-list (default empty). An IdP admin group must never become host root.
- **Clock skew**: SAML/OIDC assertion checks allow a small skew; hosts need NTP.
- **Sessions**: do not give the browser long-lived IdP tokens; the browser holds only the Better Auth cookie.
- **Failure semantics**: IdP timeout / 5xx → 503 (same as CAPTCHA outage); auth reject → 401/403; never admit on failure.

<a id="mainland-china-reachability"></a>
## Mainland China reachability

| Provider | Typical network place | Notes |
| --- | --- | --- |
| WeCom | Public APIs (`qyapi.weixin.qq.com`, `open.work.weixin.qq.com`); phone completes the scan | Identity host must reach WeCom APIs; phones need WeCom. Private/gov editions may need allow-listed base URL overrides. |
| DingTalk | Public `oapi.dingtalk.com` and related hosts | Same pattern; some gov/private DingTalk deployments need alternate endpoints. |
| OIDC / SAML | Often customer DC or private-cloud IdP | Bidirectional reachability between identity and IdP; may be intranet-only with Caddy limited to the office network. |
| LDAP / AD | Almost always intranet | Co-locate identity with domain controllers or a private link; never expose LDAP to the public internet. |

Public CAPTCHA (Turnstile) is often unreachable from enterprise networks, so prefer `DSH_CAPTCHA_PROVIDER=none`. Mail can use intranet SMTP or the existing `smtp` provider pointed at corporate DirectMail/SES.

<a id="phased-rollout-and-tests"></a>
## Phased rollout and test strategy

### Suggested phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| P0 Design freeze | Confirm this document’s decisions | User checks D1–D8 |
| P1 Framework | `DSH_SSO_PROVIDER` parsing, fail-closed, account-link table, login entry, emergency skeleton | Unit tests: unknown provider refuses start; `off` unchanged |
| P2 OIDC + PKCE | Most portable federation; easy Keycloak mock | Known-answer JWT/state tests; live Keycloak checklist |
| P3 WeCom QR | High demand in mainland deployments | Mock WeCom HTTP; sandbox corp live QR checklist |
| P4 DingTalk QR | Same | Mock + live app checklist |
| P5 SAML SP | Classic ADFS / cloud IdPs | XML signature fixtures; live IdP checklist |
| P6 LDAP/AD | Directories without federation | OpenLDAP in a test container only; no destructive tests against production directories |
| P7 Hardening | SLO, SCIM/disable webhooks, group mapping, audit export | Security review |

### Test strategy

- **Unit / integration**: mock IdP HTTP and LDAP; state single-use; assertion failures; timeout → 503; unique account links; emergency allow-list.
- **No real enterprise secrets in CI** (same rule as cn-providers).
- **Live IdP checklist** (per provider): register the app / trust domain, first JIT login, second login, disabled user loses sessions, wrong secret refuses start or login, CSP / callback URLs match docs.
- **Regression**: with `DSH_SSO_PROVIDER=off`, existing registration, CAPTCHA, invites, SMTP, and account E2E must stay green.

<a id="decision-points"></a>
## Decision points for the user

Check or annotate each item before an implementation plan:

- [ ] **D1 Tenancy model**: Confirm the default of **one enterprise, one deployment** (one identity DB, one `DSH_SSO_PROVIDER`). Multi-enterprise sharing needs a separate multi-tenant design (separate DBs or a mandatory `tenant` claim).
- [ ] **D2 UserId mapping**: Confirm first SSO allocates an immutable `user.id` in the identity service, uniquely linked by `(provider, subject)`; reject auto-merge by email alone.
- [ ] **D3 Coexistence with invites**: Enterprise default **SSO only**, or allow **SSO + invited contractors**? If allowed, may an invite user later link to an enterprise `subject`?
- [ ] **D4 Email verification**: Do enterprise SSO users **skip** Better Auth email verification (trust the IdP)? Do emergency-password users still require a verified email?
- [ ] **D5 Logout scope**: Revoke only the Harness session, or also start SAML/OIDC single logout?
- [ ] **D6 Emergency password**: Enable break-glass? If yes: allow-list source, mandatory second factor or not, audit retention period?
- [ ] **D7 JIT vs allow-list**: Does a new employee’s first SSO create the website account automatically, or must the `subject` appear on an allow-list first?
- [ ] **D8 Provider priority**: Agree the implementation order **P2 OIDC → P3 WeCom → P4 DingTalk → P5 SAML → P6 LDAP**? If a customer needs only LDAP, may that jump the queue?

<a id="sources"></a>
## Sources

- Existing identity and pluggable CAPTCHA/mail: [identity README](../../../integrations/public-harness/packages/identity/README.md), native design [Identity and registration](2026-10-11-public-harness-native-design.md#identity-and-registration)
- WeCom: QR login and OAuth docs ([build QR link](https://developer.work.weixin.qq.com/document/path/91022), [get visitor identity](https://developer.work.weixin.qq.com/document/path/91023), [gettoken](https://developer.work.weixin.qq.com/document/path/91039))
- DingTalk: [QR login to third-party sites](https://open.dingtalk.com/document/orgapp/scan-qr-code-to-log-on-to-third-party-websites), [sns/getuserinfo_bycode](https://open.dingtalk.com/document/orgapp/obtain-the-user-information-based-on-the-sns-temporary-authorization)
- OIDC / OAuth: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [RFC 7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- SAML: [OASIS SAML 2.0 technical overview](http://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html)
- LDAP: LDAPS / StartTLS on the deployment side; attribute mapping is customer-specific
