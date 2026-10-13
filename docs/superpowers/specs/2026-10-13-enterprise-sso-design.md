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
| `dingtalk` | DingTalk website QR login | `DSH_DINGTALK_CLIENT_ID`, `DSH_DINGTALK_CLIENT_SECRET`, `DSH_DINGTALK_CORP_ID` |
| `oidc` | OpenID Connect Authorization Code + PKCE | `DSH_OIDC_ISSUER`, `DSH_OIDC_CLIENT_ID`, `DSH_OIDC_CLIENT_SECRET` (if required), `DSH_OIDC_SCOPES` |
| `saml` | SAML 2.0 Service Provider | `DSH_SAML_SP_ENTITY_ID`, `DSH_SAML_IDP_ENTITY_ID`, `DSH_SAML_IDP_SSO_URL`, `DSH_SAML_IDP_CERT_FILE` |
| `ldap` | LDAP / Active Directory bind | `DSH_LDAP_URL`, bind DN template or search base, `DSH_LDAP_START_TLS`, optional `DSH_LDAP_GROUP_FILTER` |

Production refuses enterprise secrets in JSON. Local runs may use a mock provider (name TBD, e.g. `test`) that production mode must reject.

### Relation to CAPTCHA and mail

| Deployment shape | CAPTCHA | Mail | Registration | SSO |
| --- | --- | --- | --- | --- |
| Public internet | turnstile / aliyun / tencent, or none+invite | sendmail / smtp | may open via `enrollmentOpen` | `off` |
| Enterprise on-prem | prefer `none`; public `/account/register` closed | still usable for emergency password-reset mail if that path is on | `enrollmentOpen=false`; accounts via JIT on first SSO or operator pre-provision | `wecom` / `dingtalk` / `oidc` / `saml` / `ldap` |

Whether invite codes (`DSH_CAPTCHA_PROVIDER=none` mint CLI) remain for contractors without SSO was decided in D3: invited contractors may coexist but never bind an enterprise subject.

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

Per the current WeCom docs on the [web login link](https://developer.work.weixin.qq.com/document/path/98152), [login identity](https://developer.work.weixin.qq.com/document/path/98176), [gettoken](https://developer.work.weixin.qq.com/document/path/91039), [read member](https://developer.work.weixin.qq.com/document/path/90196) and [sub-department IDs](https://developer.work.weixin.qq.com/document/path/95350):

1. `/api/auth/sso/start` stores a single-use, browser-bound `state` and redirects to `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=CORPID&agentid=AGENTID&redirect_uri=...&state=STATE`. The older `open.work.weixin.qq.com/wwopen/sso/qrConnect` link is replaced by this one.
2. After the member scans and confirms, WeCom redirects to `redirect_uri` with `code` and `state`; the callback domain must be the app's trusted domain.
3. The service consumes `state` once and gets an `access_token` with `corpid` + `corpsecret`. The token is cached in memory until five minutes before `expires_in`, fetched by one request at a time, refetched once on errcode 40001/40014/42001, and never sent to the browser.
4. `auth/getuserinfo` turns `code` into the member `userid`. A non-member (only `openid`) or an interconnected-corp ID (`CorpId/userid`) is refused. `user/get` must answer `status = 1` and gives the department IDs.
5. Implementation decisions:
   - **Subject**: `CORPID:userid` with `userid` lower-cased, because WeCom user IDs are case-insensitive. The corp prefix keeps `(wecom, subject)` unique if the deployment ever changes corp.
   - **Departments (D7)**: `DSH_SSO_ALLOWED_GROUPS` holds department IDs, never names. With `DSH_WECOM_DEPARTMENT_RECURSIVE=true` (default), a member of any sub-department of an allowed department is admitted; sub-departments come from `department/simplelist?id=ALLOWED` and are cached ten minutes. `false` requires a direct member.
   - **Email (D2/D4)**: apps created after 2022-06-20 do not receive email from `user/get`. The foundation needs a unique address, so the service uses `biz_mail` or `email` when returned and otherwise `wecom-<hash of subject>@sso.invalid`. Accounts are still found only by subject, an address already in use still refuses the sign-in, and registration refuses `.invalid` addresses so nobody can squat a placeholder.
   - **Private deployment (私有化)**: `DSH_WECOM_API_BASE` and `DSH_WECOM_LOGIN_URL` point at the intranet server; both must be HTTPS.
   - **Failures**: timeouts, HTTP errors, unexpected errcodes and department lookup failures answer 503; an invalid code, a non-member, an inactive member or a member outside the app's visibility answers a login-page error.

The embedded `ww.createWWLoginPanel` component is not used: the plain redirect needs no third-party script in the page CSP.

### DingTalk QR login (`dingtalk`)

Per the current DingTalk docs on the [authorize link](https://open.dingtalk.com/document/development/obtain-identity-credentials), [user token](https://open.dingtalk.com/document/development/obtain-user-token), [current user](https://open.dingtalk.com/document/development/dingtalk-retrieve-user-information), [app token](https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app), [unionId to userid](https://open.dingtalk.com/document/development/query-a-user-by-the-union-id), [member details](https://open.dingtalk.com/document/development/query-user-details) and [sub-department IDs](https://open.dingtalk.com/document/development/obtain-a-sub-department-id-list-v2):

1. `/api/auth/sso/start` stores a single-use, browser-bound `state` and redirects to `https://login.dingtalk.com/oauth2/auth?redirect_uri=...&response_type=code&client_id=APPKEY&scope=openid%20corpid&prompt=consent&corpId=CORPID&state=STATE`. The older `oapi.dingtalk.com/connect/qrconnect` link with signed `sns/getuserinfo_bycode` is not used.
2. After the user scans and consents, DingTalk redirects to `redirect_uri` with `authCode` and `state`; the callback accepts `authCode` as the code. The redirect URL must be registered in the app's security settings.
3. The service consumes `state` once and posts the code to `v1.0/oauth2/userAccessToken`. A 4xx answer is a refused code. The returned `corpId` must equal `DSH_DINGTALK_CORP_ID`, because the consent page lets the user pick another organization.
4. `v1.0/contact/users/me` with the user token gives the `unionId`. The app token from `v1.0/oauth2/accessToken` is cached in memory until five minutes before `expireIn`, fetched by one request at a time and refetched once on errcode 40001/40014/42001. `topapi/user/getbyunionid` gives the `userid` (60121 or an external contact is refused) and `topapi/v2/user/get` must answer `active = true` and gives `dept_id_list`.
5. Implementation decisions:
   - **Subject**: `CORPID:unionId`. DingTalk documents `unionId` as system-generated and unchanging within the developer organization, while `userid` can be chosen by the administrator. The corp prefix keeps `(dingtalk, subject)` unique per organization.
   - **CSRF**: DingTalk documents neither PKCE nor a nonce for this flow, so the single-use browser-bound `state` is the defense; the provider generates the unused nonce and verifier only to fill the shared store.
   - **Departments (D7)**: `DSH_SSO_ALLOWED_GROUPS` holds department IDs. With `DSH_DINGTALK_DEPARTMENT_RECURSIVE=true` (default) members of sub-departments are admitted. `listsubid` returns direct children only, so the service walks the tree from each allowed department (at most 5000 departments) and caches the result ten minutes.
   - **Email (D2/D4)**: `org_email`, then `email`, when the app may read them; otherwise `dingtalk-<hash of subject>@sso.invalid`, under the same rules as WeCom. Email never merges accounts.
   - **Private or exclusive deployment**: `DSH_DINGTALK_LOGIN_URL`, `DSH_DINGTALK_API_BASE` and `DSH_DINGTALK_OAPI_BASE` point at other HTTPS hosts. `DSH_DINGTALK_EXCLUSIVE_LOGIN=true` adds `exclusiveLogin=true&exclusiveCorpId=CORPID` for exclusive (专属) accounts.
   - **Failures**: timeouts, 5xx, unexpected errcodes and department lookup failures answer 503; a refused code, another organization, a non-member, an external contact or an inactive member answers a login-page error.

The embedded `DTFrameLogin` QR component is not used: the plain redirect needs no third-party script in the page CSP.

### OIDC (`oidc`)

Authorization Code Flow + PKCE ([RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749), [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)):

1. Discover `{issuer}/.well-known/openid-configuration` (HTTPS issuer; plaintext forbidden in production).
2. Authorization request carries `state`, `nonce`, and S256 `code_challenge`; store the verifier server-side.
3. Callback validates `state`; exchange `code` + verifier (and client secret for confidential clients) at the token endpoint.
4. Validate `id_token`: JWKS signature, `iss`, `aud`, `exp`, `nonce`; use `sub` as `subject`.
5. Optional UserInfo / group claims; group → role mapping is deny-by-default for admin powers (see Security).

Works with public or customer-hosted IdPs (Keycloak, Authing private cloud, cloud IDaaS, and similar).

### SAML 2.0 SP (`saml`)

The identity service is a Service Provider per [SAML 2.0 Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf), [Bindings](https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf) and the Web Browser SSO profile in [Profiles](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf) §4.1. It uses [@node-saml/node-saml](https://github.com/node-saml/node-saml) 5.1.0, pinned exactly; the library is maintained, has no native code, verifies only the signed XML it returns and refuses responses with more than one assertion. The service adds the profile checks the library leaves out.

1. `/api/auth/sso/start` stores a single-use, browser-bound `state` and the AuthnRequest ID, then redirects to `DSH_SAML_IDP_SSO_URL` with a deflated, unsigned AuthnRequest (HTTP-Redirect binding), `RelayState=state`, the ACS URL and the configured NameID format.
2. The IdP posts `SAMLResponse` and `RelayState` to `/api/auth/sso/acs` (HTTP-POST binding). That post is cross-site, so the SameSite=Lax binding cookie is missing. The service verifies nothing yet and answers a small page (nonce CSP, `form-action 'self'`) that re-posts the same fields from its own origin, where the cookie is sent. A re-post that still arrives cross-origin answers 403.
3. The same-origin post goes through the shared callback: the state is consumed once with its browser cookie, then:
   - **Signature**: the IdP certificates are pinned from `DSH_SAML_IDP_CERT_FILE` (one or more PEM certificates; a private key in that file refuses start). Either the Response or the Assertion must be signed; `DSH_SAML_WANT_ASSERTIONS_SIGNED=true` requires the Assertion. Unsigned, wrongly signed and wrapped responses (a signed assertion moved aside and a forged one put in its place) are refused. Metadata is never fetched at runtime.
   - **Profile checks**: Issuer equals `DSH_SAML_IDP_ENTITY_ID`; Audience equals `DSH_SAML_SP_ENTITY_ID`; a bearer SubjectConfirmation has Recipient equal to the ACS URL and InResponseTo equal to the stored request ID; a Response Destination, when present, equals the ACS URL; Status is Success; NotBefore and NotOnOrAfter hold within `DSH_SAML_CLOCK_SKEW_MS` (default 60 s, at most 300 s).
   - **Replay**: each Assertion ID is recorded in `dsh_sso_assertion` until it expires, and a second use is refused.
4. Implementation decisions:
   - **Subject**: `IDP_ENTITY_ID|NameID`, case kept. `DSH_SAML_NAMEID_FORMAT` is `persistent` (default), `emailAddress` or `unspecified`, and the received format must equal it. Transient IDs are always refused because they change on every login.
   - **Groups (D7)**: values of `DSH_SAML_GROUP_ATTRIBUTE` (default `groups`; Azure AD sends `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` with object IDs).
   - **Email (D2/D4)**: `DSH_SAML_EMAIL_ATTRIBUTE` (default `email`), otherwise `saml-<hash of subject>@sso.invalid` as for WeCom and DingTalk. Email never merges accounts.
   - **IdP-initiated SSO**: refused, because an unsolicited response has no RelayState or InResponseTo to bind to a browser.
   - **SP metadata**: `/api/auth/sso/metadata` publishes the entity ID, the HTTP-POST ACS and the NameID format.
   - **Failures**: every invalid response answers a login-page error, and only store failures answer 503; the IdP is never contacted by the server, so there is no network timeout.

### LDAP / AD (`ldap`)

The service binds to the directory per [RFC 4511](https://datatracker.ietf.org/doc/html/rfc4511) and [RFC 4513](https://datatracker.ietf.org/doc/html/rfc4513) through [ldapts](https://github.com/ldapts/ldapts) 9.2.0, pinned. Sign-in is a form on the login page that posts `{ username, password }` to `/api/auth/sso/ldap/sign-in`; there is no redirect.

1. **Transport**: `DSH_LDAP_URL` is `ldaps://`, or `ldap://` with `DSH_LDAP_STARTTLS=true` ([RFC 4511 §4.14](https://datatracker.ietf.org/doc/html/rfc4511#section-4.14)). Plain `ldap://` starts only in local mode against a loopback host. TLS 1.2 or later; `DSH_LDAP_CA_FILE` pins the trusted CA (PEM certificates only; a private key refuses start), otherwise the system store applies. Hostnames are verified.
2. **Search then bind**: one connection per login, never pooled, so a user's bind cannot leak into another login. The service account (`DSH_LDAP_BIND_DN`, `DSH_LDAP_BIND_PASSWORD` from the environment) searches `DSH_LDAP_BASE_DN` with `(&<DSH_LDAP_USER_FILTER>(<username attribute>=<escaped>))`, values escaped per [RFC 4515](https://datatracker.ietf.org/doc/html/rfc4515) §3; exactly one entry must match. The service then binds with that entry's DN and the supplied password. The DN comes from the server, so no DN is built from input (an RFC 4514 escaper exists for later use). The connection is unbound in every case.
3. **Empty passwords** are refused before any network call: [RFC 4513 §5.1.2](https://datatracker.ietf.org/doc/html/rfc4513#section-5.1.2) makes a bind with a DN and an empty password an unauthenticated bind that many servers accept.
4. **Subject**: `<DSH_LDAP_SERVER_ID>|<immutable id>`. The id is `objectGUID` for AD ([objectGUID](https://learn.microsoft.com/en-us/windows/win32/adschema/a-objectguid), formatted as a GUID string) or `entryUUID` ([RFC 4530](https://datatracker.ietf.org/doc/html/rfc4530)) for OpenLDAP; `DSH_LDAP_ID_ATTRIBUTE` overrides it. Server ID defaults to the URL host and port. Renaming or moving the user keeps the account.
5. **Groups (D7)**: `DSH_LDAP_GROUP_MODE` is `memberOf` (direct groups), `nested` (AD only: `LDAP_MATCHING_RULE_IN_CHAIN`, [search filter syntax](https://learn.microsoft.com/en-us/windows/win32/adsi/search-filter-syntax)), or `search` (`(&(objectClass=<class>)(member=<user DN>))` under `DSH_LDAP_GROUP_BASE_DN`). `DSH_SSO_ALLOWED_GROUPS` lists group DNs separated by `;`, compared after normalizing case and spaces.
6. **Disabled accounts (AD)**: `userAccountControl` with `ACCOUNTDISABLE` (0x2) is rejected ([userAccountControl](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/useraccountcontrol-manipulate-account-properties)). AD also refuses the bind for disabled, expired or locked accounts.
7. **Email (D2/D4)**: `DSH_LDAP_EMAIL_ATTRIBUTE` (default `mail`), otherwise `ldap-<hash of subject>@sso.invalid`.
8. **No enumeration**: wrong password, unknown user, several matches and disabled account all answer the same 401 after a 300 ms floor. Five failures per username and IP, or twenty per username, within 15 minutes answer 429 until the window passes (in memory, reset on restart). Group refusal answers 403 only after a correct password.
9. **Outages**: a failed service bind, a timeout (`DSH_LDAP_TIMEOUT_MS`, default 5000) or any unexpected error answers 503. Passwords are never logged or stored, and LDAP passwords are never copied into Better Auth hashes.

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
- **Gating**: separate URL (e.g. `/account/emergency`), not linked from the normal login page; mandatory second factor (TOTP, decided in D6); full audit (who, when, source IP, success/failure).
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

Status: **Decided** (2026-10-13). These decisions replace the earlier open checklist and bind the implementation plan `docs/superpowers/plans/2026-10-13-enterprise-sso.md`.

- **D1 Tenancy model (decided)**: One enterprise, one deployment: one identity database and one `DSH_SSO_PROVIDER`. Multi-tenant sharing is a separate design.
- **D2 UserId mapping (decided)**: The first SSO sign-in allocates an immutable `user.id`. The link is unique by `(provider, subject)`. The service never merges accounts by email alone; an email already held by another account refuses the sign-in.
- **D3 Coexistence with invites (decided)**: Enterprise default is SSO only. Invited contractor accounts may coexist, but an invite-created account can never later be bound to an enterprise `subject`.
- **D4 Email verification (decided)**: SSO users skip Better Auth email verification because the IdP is trusted. Emergency-password accounts still require a verified email.
- **D5 Logout scope (decided)**: Sign-out revokes only the Harness session. SAML/OIDC single logout is out of scope for now.
- **D6 Emergency password (decided)**: Kept, for administrators only. It requires a source-IP allow-list and a mandatory second factor, and its audit log is retained for one year.
- **D7 JIT vs allow-list (decided)**: Accounts are created just in time on first sign-in, but only for configured departments or groups.
- **D8 Provider priority (decided)**: OIDC → WeCom → DingTalk → SAML → LDAP. LDAP may move ahead when a customer needs it.

<a id="sources"></a>
## Sources

- Existing identity and pluggable CAPTCHA/mail: [identity README](../../../integrations/public-harness/packages/identity/README.md), native design [Identity and registration](2026-10-11-public-harness-native-design.md#identity-and-registration)
- WeCom: [web login link](https://developer.work.weixin.qq.com/document/path/98152), [login identity](https://developer.work.weixin.qq.com/document/path/98176), [gettoken](https://developer.work.weixin.qq.com/document/path/91039), [read member](https://developer.work.weixin.qq.com/document/path/90196), [sub-department IDs](https://developer.work.weixin.qq.com/document/path/95350)
- DingTalk: [authorize link](https://open.dingtalk.com/document/development/obtain-identity-credentials), [user token](https://open.dingtalk.com/document/development/obtain-user-token), [current user](https://open.dingtalk.com/document/development/dingtalk-retrieve-user-information), [app token](https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app), [unionId to userid](https://open.dingtalk.com/document/development/query-a-user-by-the-union-id), [member details](https://open.dingtalk.com/document/development/query-user-details), [sub-department IDs](https://open.dingtalk.com/document/development/obtain-a-sub-department-id-list-v2)
- OIDC / OAuth: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [RFC 7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- SAML: [OASIS SAML 2.0 technical overview](http://docs.oasis-open.org/security/saml/Post2.0/sstc-saml-tech-overview-2.0.html), [Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf), [Bindings](https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf), [Profiles](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf), [@node-saml/node-saml](https://github.com/node-saml/node-saml)
- LDAP: [RFC 4511](https://datatracker.ietf.org/doc/html/rfc4511), [RFC 4513](https://datatracker.ietf.org/doc/html/rfc4513), [RFC 4514](https://datatracker.ietf.org/doc/html/rfc4514), [RFC 4515](https://datatracker.ietf.org/doc/html/rfc4515), [RFC 4530](https://datatracker.ietf.org/doc/html/rfc4530), [AD search filter syntax](https://learn.microsoft.com/en-us/windows/win32/adsi/search-filter-syntax), [objectGUID](https://learn.microsoft.com/en-us/windows/win32/adschema/a-objectguid), [userAccountControl](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/useraccountcontrol-manipulate-account-properties), [ldapts](https://github.com/ldapts/ldapts)
