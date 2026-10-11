---
description: "Linux provisioner for per-user host accounts, private storage, and gVisor Harness containers."
kind: "package-library"
---

# @public-harness/provisioner

English | [中文](README.zh.md)

## Summary

This package creates private Linux accounts and storage, admits launches within a configured capacity, and manages suspension, idle stop, confirmed deletion, and restart recovery. An explicitly mounted runtime provider starts each user's Harness. The container provider uses rootless Podman with gVisor; host effects are injectable for unprivileged tests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`createProvisionerService` takes a validated `ProvisionerConfig` and an injected `InstanceRuntime`, and returns the router handler and lifecycle operations. Missing providers and mismatched configuration or persisted backends reject before host changes. The Cordis entry `@public-harness/provisioner/runtime-provider` registers one container runtime with disposable ownership; duplicate providers reject. `startProvisionerServer` serves the handler on a socket whose group may connect; the handler receives only `ensure`, `launch-grant`, `stop`, or `status` with a validated user ID, and `ProvisionerClient` exposes matching methods. `startAdminServer` serves `suspend`, `reactivate`, `request-deletion`, `confirm-deletion`, `delete`, `reconcile`, `idle-stop`, and `status` on a separate root-only socket for `AdminClient`. The router refusals `CapacityError` and `AccountSuspendedError` cross the socket as fixed words, and every other failure becomes `invalid request`.

<a id="understand-the-implementation"></a>
## Understand the implementation

Account and runtime names derive from a hash of the user ID. Common settings contain account tools, storage paths, numeric resource limits, quota ports and lifecycle timing. `runtime.kind` selects the backend; container-only executables, assets, image settings, network mode, quota host address and sidecar ports live under the `podman-gvisor` tag. A container start verifies gVisor, delegated cgroup controllers, the egress firewall table, disk quotas, quota service health and the image. Its private readiness file carries the Web credential, and a restricted Unix forwarder reaches its published sidecar port. Lifecycle operations query the provider, stop idle or suspended instances, and gate deletion on confirmation and the recovery period.

Records are written as version 2 with a runtime reference, launch ID, allocated ports and acquired resources. The retained v1 decoder interprets legacy records as container state without rewriting them on reads. Malformed or unsupported records remain untouched. Pending and complete allocations reserve capacity before host effects, including wakes of existing users. Interrupted allocations and failed cleanup are quarantined and withdraw routing; reconciliation permits reuse only after provider cleanup succeeds. Admission and administrative lifecycle changes share the per-user lock. Provider disposal cleans resumed complete allocations as well as fresh allocations. Backend transfer requires an operator-controlled offline backup, full stop and verified restore; changing `runtime.kind` alone refuses the existing records.

<a id="further-exploration"></a>
## Further Exploration

See [contracts](../contracts/README.md) for user IDs and endpoint validation, the [production package](../production/README.md) for the root `provisioner` profile, and the [deployment guide](../../deploy/production/README.md) for host setup.

<a id="dev-note"></a>
## Dev Note

The unit tests use fake command runners and fake directories; accounts, quotas, cgroups, Podman, and gVisor are exercised only on a real Linux host. The socket protocol is one check, not the complete authorization policy: deployment must also restrict the socket directories and derive every host path on the server.
