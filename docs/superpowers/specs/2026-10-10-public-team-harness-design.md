# Public multi-user Harness design

English | [中文](2026-10-10-public-team-harness-design.zh.md)

## Purpose and scope

This proposal turns one Linux server into a publicly registered Harness service with complete coding-agent tools, a platform-funded model allowance, private Sessions and workspaces, and one installable UI plugin shared by all user instances. macOS and Windows are also supported as local-only development hosts.

Public registration is available to any visitor who completes email verification and anti-automation checks. Registration does not promise immediate capacity: admission may refuse or queue an instance when the configured server limit is reached. Git is the supported way to share projects; Harness Sessions, credentials, and workspaces remain private to each user.

The existing Harness Web process remains a single-operator application. Each admitted identity receives its own Harness process and private runtime. The design does not add user authorization to the existing Session APIs or agent loop.

## Deployment and ownership

```text
Browser → Caddy HTTPS + authentik → team router → per-user isolated Harness
per-user isolated Harness → model quota proxy → platform model
```

authentik owns enrollment, email verification, CAPTCHA, login, account status, and the immutable user ID. Caddy owns TLS, forward authentication on every HTTP request and WebSocket handshake, and replacement of any client-supplied identity headers. Its only upstream for the application is the team router's permission-restricted Unix socket. The router refuses a missing, duplicated, malformed, or unauthorized identity even when a proxy configuration is wrong.

The team router is an out-of-tree Cordis bundle installed into a dedicated `dsh` profile. It owns identity-to-instance routing, Harness startup-token exchange, HTTP and WebSocket forwarding, cookie-path rewriting, capacity admission, and user-visible readiness or refusal responses. Its HTTP server is private to the bundle because the existing Web server registers only exact upgrade paths and cannot route an arbitrary per-user prefix. It has no model master credential and runs without root privileges.

A separate narrowly privileged provisioner owns host-account creation, private storage, and isolated runtime lifecycle. It accepts only an authenticated opaque user ID from the router, derives a safe account and unit name without using a display name or email, and makes concurrent requests idempotent. The router cannot submit shell commands, filesystem paths, images, or arbitrary systemd units to the provisioner.

Each user runtime has a distinct Linux service account and an OCI container using the gVisor runtime. The container holds one `dsh --profile web` process, a private `DSH_HOME`, one or more private Git workspaces, and a local forwarding sidecar because the Web CLI binds to loopback inside its network namespace. Only that runtime's storage is mounted writable. The container receives no host management socket, platform model key, or other user's volume. CPU, memory, process, disk, and network limits are required deployment configuration; startup refuses missing or unenforceable limits. A Linux proof must confirm the complete Web and tool flow under gVisor before public admission is enabled.

The model quota proxy lives outside user runtimes and holds the platform model credential. A runtime receives only a short-lived identity-scoped credential usable against this proxy. The proxy reserves an upper bound before each request, accounts for provider-reported usage afterward, and charges the reservation if actual usage is unavailable. Required positive configuration sets per-user and site-wide daily token allowances and concurrent-request limits. An exhausted allowance or an unavailable accounting store refuses new model requests; no request bypasses accounting.

The shared UI bundle uses the documented browser `dsh.client` and Slot interfaces and is installed in every user's Web profile. It owns product branding and common navigation; production login pages use authentik branding and the development test-user selector uses the same theme. Hiding particular official DeepSeek controls is a later UI change, as agreed, and does not weaken the identity or quota rules.

## Development hosts

An explicit `team-dev` profile runs the same router, quota logic, and UI on macOS or Windows. It binds the router and all development control endpoints to loopback, uses fixed local test identities selected through a signed development cookie, and does not offer public registration. Startup rejects a non-loopback bind. Development identity cannot be activated in the production profile.

The router consumes a Cordis instance-manager service with two providers. The Linux provider calls the privileged provisioner and returns a private Unix-socket endpoint. The development provider starts one real `dsh --profile web` child per test identity, each with its own `DSH_HOME` and Git workspace, and returns a loopback TCP endpoint. Development children have no Linux-account or gVisor isolation and must not be treated as a public execution service. The provisioner protocol is used only by the Linux provider; the router handles the two endpoint types through the same authorization and forwarding rules.

Development model calls use the same quota code with a mock provider or a separate developer-supplied API key; the platform production key is never copied into a development profile. The development profile exercises real Harness Sessions, terminal, shell, browser UI, HTTP, WebSocket, and per-user paths. Linux production tests still establish authentik/Caddy integration, resource limits, host-account isolation, and gVisor containment.

## Request and lifecycle rules

An authenticated request for `/` redirects to `/u/<opaque-id>/`. The router checks that the authenticated ID owns the path on every HTTP request and upgrade, strips `/u/<opaque-id>/` before forwarding, preserves the browser-facing Host and Origin, and forwards only to that user's instance endpoint. Unknown paths, missing identity, and cross-user paths fail closed.

A small Web-profile Cordis plugin obtains the Harness authenticated URL from `ctx.connection` and sends its launch token through a private supervisor channel while normal token-URL printing is disabled. The router exchanges that token against the matching instance; it never appears in a browser URL or routine log. The resulting Harness cookie is scoped to `/u/<opaque-id>/`, marked `Secure` on the HTTPS leg, and retains `HttpOnly` and `SameSite=Strict`. The router never substitutes one user's cookie or token for another's. Restart rotates the launch token, while an existing signed cookie may remain valid until expiry and still requires external authentication on every new request.

In production, after verified registration, the first authorized request provisions or wakes one instance under an identity-specific lock. Concurrent first requests join the same operation. Provisioning fails without leaving a routable half-created instance; retries reconcile completed account, directory, and runtime steps. Idle instances may stop while their data persists. Deactivation denies new requests and stops the runtime; a separately confirmed account-deletion operation purges stored workspaces and Sessions after the deployment's configured recovery period.

In production, Caddy authenticates each new request and WebSocket handshake; development verifies its signed local cookie instead. Existing WebSockets have a maximum lifetime of 60 seconds and must reconnect through authentication. Deactivation and logout deny the next request or reconnect, while an already-open socket can remain active until its 60-second limit. A switch of browser identity cannot open a new connection to the old user's path.

When the site-wide active-instance cap is reached, a new user receives a capacity response and no runtime is created. Per-user resource exhaustion stops the offending runtime without affecting another user's data. The router and quota proxy expose health and capacity signals without exposing identities, credentials, tokens, model prompts, or Session contents in public responses or routine logs.

## Packaging and upgrade behavior

The team router, quota proxy, Linux provisioner integration, development instance manager, Web-profile token publisher, and UI bundle are independently versioned deployment packages; the router and Web bundles use Cordis plugin APIs rather than patching the Harness agent loop or Session storage. Each user's profile installs the same tested bundle versions. A Harness upgrade first runs compatibility and migration checks against a non-production profile, then rolls through user instances while preserving their `DSH_HOME` and Git workspaces. A bundle interface change requires an explicit package update; unchanged interfaces need no source patch to Harness.

The implementation is divided into independently testable work: identity and routing; provisioning and isolated runtime; model accounting; shared UI and deployment integration. Public registration is enabled only after all four parts pass the Linux checks below. This order does not offer a publicly exposed partial service.

## Verification and release criteria

- A keyless local test launches two Web processes and proves cookie, HTTP, and WebSocket path isolation; the existing two-process probe provides initial evidence but is not a production authentication test.
- macOS and Windows development checks boot the `team-dev` profile, select two test identities, run their real Harness shell and terminal flows, and verify separate `DSH_HOME` and Git workspaces; a non-loopback bind is rejected.
- An identity test rejects forged, absent, duplicate, stale, and cross-user identity inputs at the Caddy-to-router interface, including upgrades and account switches.
- A Linux integration test completes public registration, email verification, first-login provisioning, concurrent first requests, process restart, idle wake, account deactivation, and host reboot with real services.
- An isolation test confirms one user cannot read another user's data or the model master credential through Harness tools, plugin installation, Git, filesystem APIs, or direct network access; the runtime fails closed when gVisor or required limits are unavailable.
- Quota tests cover parallel reservations, stream cancellation, missing usage reports, per-user exhaustion, global exhaustion, and accounting-store failure without overspend.
- Browser tests load the plugin UI and reconnect its WebSocket through the public prefix; the login page and application use the same product branding.
- A deployment review checks TLS, authentik security updates, email and CAPTCHA setup, protected Unix sockets, resource limits, backup and restore, and capacity before public registration is switched on.

## Alternatives and limits

One shared Harness process would require identity checks throughout Connection, Session, Workspace, credentials, and every execution capability; it is outside this design. Linux accounts alone leave public code in the same host execution environment, so they are paired with per-user isolated containers. Static per-user reverse-proxy entries avoid router code but do not support open self-registration and automatic admission at this scale.

One server has finite capacity and remains a single point of failure. The design refuses new instances when full and preserves existing data; it does not promise unlimited signups, high availability, instant revocation of already-open WebSocket messages, or protection against every container escape. The public launch requires a dedicated Linux validation host and an operational response for security updates and abuse.
