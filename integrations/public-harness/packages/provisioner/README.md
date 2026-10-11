---
description: "Linux provisioner for per-user host accounts, private storage, and gVisor Harness containers."
kind: "package-library"
---

# @public-harness/provisioner

English | [中文](README.zh.md)

## Summary

This package is the narrowly privileged Linux provisioner. It speaks a fixed Unix-socket protocol with the router, creates one host account and private storage tree per opaque user ID, and runs each user's Harness in a rootless Podman container under gVisor with mandatory resource limits. It also owns suspension, idle stop, gated deletion, and recovery after a host restart. Every host command goes through an injected runner, so the package tests run without root.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`createProvisionerService` takes a validated `ProvisionerConfig`, the quota control client, and a cgroup probe, and returns the router handler and the lifecycle operations. `startProvisionerServer` serves the handler on a socket whose group may connect; the handler receives only `ensure`, `launch-grant`, `stop`, or `status` with a validated user ID, and `ProvisionerClient` exposes matching methods. `startAdminServer` serves `suspend`, `reactivate`, `request-deletion`, `confirm-deletion`, `delete`, `reconcile`, `idle-stop`, and `status` on a separate root-only socket for `AdminClient`. The router refusals `CapacityError` and `AccountSuspendedError` cross the socket as fixed words, and every other failure becomes `invalid request`.

<a id="understand-the-implementation"></a>
## Understand the implementation

Account and path names derive from a hash of the user ID, never from a display name. Provisioning is idempotent under a per-user lock and resumes after an interrupted step: account, private storage with exact ownership and mode, Git workspace, and durable state record. A new user is refused before any host change when the active-instance cap is full. A start refuses to proceed unless gVisor, every cgroup controller, the egress firewall table, the disk quota, and the quota proxy are available; `assertSafeRunArgv` rejects any `podman` argument outside the fixed set. The container's readiness token travels through a private file, and a host-side forwarder bridges one restricted Unix socket per instance to the container's published loopback port. `reconcile` restores or stops instances after a reboot, removes stale sockets, and purges an account only after the deletion was requested, confirmed, and the recovery period elapsed.

<a id="further-exploration"></a>
## Further Exploration

See [contracts](../contracts/README.md) for user IDs and endpoint validation, the [production package](../production/README.md) for the root `provisioner` profile, and the [deployment guide](../../deploy/production/README.md) for host setup.

<a id="dev-note"></a>
## Dev Note

The unit tests use fake command runners and fake directories; accounts, quotas, cgroups, Podman, and gVisor are exercised only on a real Linux host. The socket protocol is one check, not the complete authorization policy: deployment must also restrict the socket directories and derive every host path on the server.
