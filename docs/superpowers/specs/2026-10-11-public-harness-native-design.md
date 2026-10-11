# Native public Harness deployment proposal

English | [中文](2026-10-11-public-harness-native-design.zh.md)

## Summary

This reference proposes a container-free Linux deployment for the [public Harness service](2026-10-10-public-team-harness-design.md). It is a design for review, not an implemented deployment or Linux isolation result. Public self-registration, complete coding tools, private Sessions, Git sharing, platform-funded model allowances, and a common plugin UI remain the product requirements. macOS and Windows keep their loopback-only development provider.

## Contents

- [Deployment choice](#deployment-choice)
- [Service ownership](#service-ownership)
- [Host enforcement](#host-enforcement)
- [Identity and registration](#identity-and-registration)
- [Lifecycle and persistence](#lifecycle-and-persistence)
- [Integration changes](#integration-changes)
- [Verification and release](#verification-and-release)
- [Sources](#sources)

<a id="deployment-choice"></a>
## Deployment choice

The proposed native provider launches one Harness process per persistent Linux account using systemd system services. It requires no Docker, Podman, OCI image, gVisor, Kubernetes, or virtual machine. systemd filesystem and IPC protections may use Linux namespaces internally; the deployment still installs ordinary host programs and manages system services. The existing container provider remains an explicit alternative deployment configuration.

| Approach | Benefit | Cost or limitation |
| --- | --- | --- |
| Accounts, systemd, AppArmor, firewall and quotas | Shared host toolchain, direct process management, no image build or container engine | Shared kernel; policy compatibility and hostile-code isolation need real Linux validation |
| MicroVM per user | Separate guest kernel | Requires virtualization support, guest assets and VM lifecycle management |
| Existing Podman and gVisor provider | Reuses the existing container implementation | Requires a container engine and images |

The native provider is the proposed selection for this work. A dedicated Ubuntu 24.04 LTS host with cgroup v2, AppArmor enforcement, nftables and an XFS quota-enabled data volume is the initial validation target. Other distributions and CPU architectures require their own evidence before public admission. Native confinement does not provide a separate kernel and is not equivalent to MicroVM isolation.

<a id="service-ownership"></a>
## Service ownership

```text
Browser -> Caddy HTTPS -> router -> private Unix forwarder -> user Harness
                            |
                            +-> identity service (Better Auth)
                            +-> privileged provisioner -> systemd system unit
user Harness -> instance-bound quota listener -> quota service -> platform model
```

Caddy is the only public application ingress. The router, identity service, quota service and provisioner communicate over permission-restricted Unix sockets. Each trusted service has its own service account; the provisioner alone performs the narrowly scoped root operations. Every Node service launches through a dedicated dsh profile. The identity service exposes its public auth endpoints through Caddy, while its session-verification operation remains private.

The provisioner creates each persistent account from the existing opaque user ID mapping. An account has a locked password, a nologin shell and no SSH access or administrative groups. Native instances do not need a systemd user manager or loginctl linger. A root-owned system unit selects the account with User and Group. The browser user never supplies a Linux name, UID, executable, unit file, policy text or filesystem path.

The shared Harness release, Node runtime, plugins and toolchain are root-owned and read-only to user accounts. Each account receives writable private Harness home, workspace, dependency cache and temporary directories. The host-side Unix forwarder can reuse the existing implementation and reaches only the Web loopback port allocated to that instance; no container sidecar is needed. Readiness data must match the provisioner's assigned instance and port, rather than choosing a destination from user-controlled data.

Privileged file operations use root-owned control directories and no-follow path access; root ownership or permission changes never recursively traverse user-editable workspaces. Links, replaced files and recovered records in user directories are untrusted inputs.

<a id="host-enforcement"></a>
## Host enforcement

All protection applies to the entire Harness process tree, including terminal, shell, Git hooks, language servers, extensions and child agents. Editing a Cordis configuration or requesting Harness sandbox escalation cannot remove host enforcement. Root-owned configuration is validated before side effects, and missing enforcement refuses instance admission.

| Control | Required behavior |
| --- | --- |
| Files and processes | AppArmor grants required system reads and only the account's data writes; other users' data, platform secrets and management sockets are inaccessible. Child execution retains confinement, with no unconfined transition. Process inspection and signals cannot cross accounts. |
| Privilege | No new privileges, empty capability grants, no setuid elevation, no policy or unit editing, and no escape through service-management sockets or delegated cgroup writes. |
| Resources | cgroup v2 CPU, memory and task limits cover descendants; disk byte and inode quotas cover every writable disk-backed directory. Private temporary storage is bounded and charged to the user's disk or memory allowance. |
| Devices and compatibility | Permit only the devices required for coding and PTY use. Preserve Node JIT, compiler and headless-browser functionality; choose syscall and namespace restrictions from tested compatibility rather than assuming a restrictive preset works. |

Network policy is installed before the first process starts. nftables uses the recorded UID to allow only that user's assigned loopback Web and quota endpoints, the configured DNS resolver, and configured public egress. It denies other loopback services, host addresses, private and link-local ranges, cloud metadata, and unapproved IPv4 and IPv6 destinations. Existing connections are not a blanket exception that precedes identity-specific restrictions. Unix sockets require filesystem permissions and AppArmor controls in addition to IP rules. Public ingress denies direct connections to user processes, including arbitrary listeners started from a terminal.

Stopping or suspending an instance withdraws its route and quota grant, blocks its new connections, closes active forwarding, and stops the complete cgroup. Firewall changes are atomic and preserve unrelated host rules. UID and port reuse is prohibited until processes, connections, sockets and grants have been cleaned up. A failed cleanup keeps the instance quarantined and denies reuse.

Users can install dependencies in their private directories, compile programs, execute commands and use Git and terminals. They cannot install host packages as root or administer the server. Browser automation must pass under the same outer enforcement without disabling mandatory protection. Arbitrary project preview servers are not published by this change; future preview hosting requires separate browser-origin and routing design.

<a id="identity-and-registration"></a>
## Identity and registration

The proposed native identity service is an out-of-tree TypeScript Cordis package wrapping Better Auth, with an ESM Node handler and a private SQLite identity database. It owns email/password registration, verification, login, logout, password reset and session revocation. CAPTCHA, trusted proxy addresses, trusted origins, cookie attributes, mail delivery and persistent rate limits are validated deployment settings. No unverified account can provision an instance. Capacity limits may refuse a verified account's first launch.

The router adds an explicit production identity provider that verifies the browser session with the private identity service on each HTTP request and WebSocket handshake. It maps the immutable database user ID to the existing branded UserId and checks verification and account status. It does not accept identity headers from the browser, nor activate development cookies in production. Existing authentik identity remains a separately selected provider for the existing deployment. A native deployment does not require authentik, its outpost or containers.

There is no permissive fallback when identity lookup or its database fails. Native session verification does not use a cached positive result that survives logout or suspension. Existing WebSockets retain the configured maximum lifetime and reauthenticate on reconnect; suspension also requests active connection closure. Registration, instance creation and model grants are separate idempotent operations, so creating a website account does not immediately reserve a Linux process.

Login and account pages use our React components and shared visual tokens. The existing Harness UI plugin supplies branding inside each instance. Hiding official model controls remains separate work. Platform model keys stay in the quota service; each instance receives only its own rotated, instance-bound quota credential, subject to the existing personal and global limits.

<a id="lifecycle-and-persistence"></a>
## Lifecycle and persistence

First launch verifies identity, reserves capacity, reconciles the Linux account and private storage, enforces disk quotas, assigns private endpoints, installs policy and firewall rules, issues the quota grant, and starts the system unit. The router publishes an endpoint only after enforcement probes, authenticated Web readiness and ownership checks pass. Concurrent launch requests join one per-user operation. Failed steps leave durable, non-routable state that can be reconciled.

Idle stop preserves data; wake repeats the enforcement and readiness checks. Suspension refuses new access and stops the process tree. Deletion follows the existing confirmed deletion and recovery-period rules. Restart recovery reconciles actual systemd state and cgroup membership against durable records; an unknown state is never reported as stopped. Root provisioner jobs, including Git initialization, cannot run untrusted hooks or repository code outside the user's confined unit.

Durable records identify the selected runtime provider and its allocated unit, UID and endpoints. Any record-format change needs a versioned migration and recovery tests before deployed data is rewritten. Existing records are explicitly interpreted as the existing container provider; no user silently moves between backends. Backend transfer is an operator-controlled offline operation with backup, full stop and restore verification. Harness Session formats and user workspaces are not changed by the new runtime provider.

<a id="integration-changes"></a>
## Integration changes

Keep the router's InstanceManager operations and private endpoint representation. Separate common account, storage, quota and lifecycle configuration from provider-specific settings. The runtime configuration is a validated tagged selection; native configuration does not require or probe Podman, runsc, images or container networking. Runtime state names and lifecycle interfaces must describe a process instance rather than assume a container.

Complete the runtime capability through a shared service definition, providers for systemd and the existing container runtime, and the provisioner consumer. The new runtime-systemd package owns unit generation, enforcement checks and systemd lifecycle queries. The identity package owns Better Auth integration and the router consumes its private verification operation. Public code remains under integrations/public-harness and documented Cordis extension points; no agent-loop or Session authorization patch is required.

Implementation is divided into native runtime and enforcement; native identity and login; and production composition and release verification. Each part needs a reviewed implementation plan. The release evidence is tied to the actual provider, policy, host and release, so a container test cannot approve native deployment and a mock cannot approve Linux confinement.

<a id="verification-and-release"></a>
## Verification and release

Local tests on macOS and Windows can validate configuration rejection, safe command arguments, unit and policy generation, lifecycle races, identity integration and unchanged local development flows. They cannot establish Linux enforcement. This proposal includes no runnable deployment commands because none of the new service compositions has been exercised.

The Linux release rehearsal must demonstrate verified registration, both users' complete Harness flows, PTY commands, model limits, dependency installation, Git, language servers and headless browser automation. Adversarial checks must attempt cross-user reads, writes, links, process inspection, signals, Unix-socket access, loopback and private-network connections, IPv6 bypass, direct external ingress, privilege elevation, plugin-policy removal and child-process escape. Actual CPU, memory, task, byte and inode exhaustion must enforce the configured limits without affecting the other account.

The rehearsal must also cover stopped services, host reboot, concurrent first launches, readiness spoofing, firewall failure, AppArmor disabled or in complain mode, a removed policy, unavailable cgroup controllers, ineffective quotas, revoked credentials, unavailable identity or accounting stores, and failed cgroup cleanup. It must test canary upgrades, backup restore and Session retention using the deployed releases. Security review and real enforcement results are required before public registration can admit workloads; generated configuration and systemd security scores alone are insufficient.

There is currently no Linux validation host. Public workload admission therefore remains closed. Shared-kernel vulnerabilities and host-wide resource exhaustion remain residual risks even after these checks; operators need host security updates, capacity reserves and an abuse response. The MicroVM alternative remains available if the required protection cannot be demonstrated on the selected host.

<a id="sources"></a>
## Sources

The technical selection uses the following primary references; the service composition and acceptance rules above are proposed project decisions.

- [systemd execution controls](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html): account selection, AppArmor attachment and protection compatibility. AppArmor attachment has no effect when AppArmor is disabled, so functional checks are required.
- [systemd resource controls](https://manpages.ubuntu.com/manpages/noble/man5/systemd.resource-control.5.html): cgroup resource settings.
- [AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html): inherited and unconfined execution permissions.
- [nftables socket identity matching](https://wiki.nftables.org/wiki-nftables/index.php/Matching_packet_metainformation): originating socket UID selection.
- [XFS quotas](https://manpages.ubuntu.com/manpages/noble/man8/xfs_quota.8.html): enforced disk and inode limits.
- [Better Auth Node/Express integration](https://better-auth.com/docs/integrations/express), [email verification](https://better-auth.com/docs/authentication/email-password), [CAPTCHA](https://better-auth.com/docs/plugins/captcha), and [persistent rate limits](https://better-auth.com/docs/concepts/rate-limit).
- [OpenShell runtimes](https://docs.nvidia.com/openshell/latest/how-it-works/sandboxes/runtimes): documented built-in choices are Docker, Podman, MicroVM and Kubernetes. There is no documented built-in host-process provider; building an extension driver would add another integration to maintain.
