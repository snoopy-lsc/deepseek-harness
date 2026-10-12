---
description: "Prepare private Linux accounts, quota-backed storage and systemd/AppArmor policy for native Harness processes."
kind: "package-library"
---

# @public-harness/runtime-systemd

English | [中文](README.zh.md)

## Summary

Prepare locked Linux accounts, private data directories, hard disk limits and per-account systemd/AppArmor files for a native Harness deployment. Generated services launch Node through a named `dsh` profile and retain account and cgroup restrictions across descendants. These preparation functions do not start workloads or establish enforcement evidence. Public admission requires a separate provider lifecycle and dedicated Linux validation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`parseSystemdConfig({ common, native })` combines the validated common provisioner configuration with strict native options. The common `runtime` tag requires `kind: systemd` and an absolute `configFile` pointing to the native companion JSON. Common settings remain authoritative for data/state/socket/quota paths, account tools, CPU/memory/PID/nofile/byte limits, quota ports and readiness/stop timeouts. Native options supply immutable release/toolchain assets, the Node and host enforcement executables, a named profile and launch patch, inode/shared-memory limits, Web ports, resolver/public-egress rules and an operation timeout. Unknown fields, overlapping ranges or paths, unsafe path syntax and invalid limits reject before effects. See [the parser](src/config.ts) for exact fields.

Call `validateNativeAssets` before registering the runtime service, so dependent provisioning cannot invoke unvalidated host programs. Release and toolchain trees require root ownership and no group/other write access, including their ancestors. Immutable links may resolve only within declared immutable roots; dangling, cyclic, escaping or writable targets reject. OS command links resolve only under the trusted system tool roots. Root-written data/control paths use no-follow directory descriptors and refuse links instead of resolving them.

`ensureNativeAccount` uses a locked password, nologin shell and private primary group, with no user-manager linger. Existing native accounts must retain the password lock and have no supplementary groups. `prepareHost` validates assets, applies XFS byte/inode hard limits, prepares storage and writes generated unit/policy text. It neither loads AppArmor nor starts a system unit. A caller must complete network policy and observed enforcement checks before any user execution, including workspace initialization.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The common provisioner reserves and persists allocation before preparation. Native storage is recorded only after provider preparation succeeds. Root owns `storageRoot/users` and each account's top-level parent; the four user-owned children are `home`, `workspace`, `cache` and `tmp`. The root-only control directory is `stateDir/runtime/<account>`. User token and readiness files belong in the private home, separate from control files. Directory ownership changes operate on opened top-level handles and never recursively traverse user data. Every disk-backed writable directory must share the configured quota filesystem; private shared memory is bounded by size/inodes and charged to the service memory cgroup.

The exported preparation stages `validateNativeAssets`, `applyDiskLimits`, `prepareNativeStorage` and `writeControlFile` allow a lifecycle provider to record each acquired resource between effects. A rejected operation may leave partial directories, quota settings or files; retain allocation, deny routing and reconcile before retrying. Exclusive staging files are retained after interrupted writes. `NativeHostError` exposes stable failure codes and the failed operation while preserving the cause. Confirmed data deletion additionally requires verified UID/cgroup quiescence and the common recovery period.

The generated unit uses empty capabilities, no new privileges, a read-only system, protected foreign processes, no cgroup delegation and whole-cgroup termination. AppArmor grants inherited execution for coding tools and private programs, same-profile process signalling/inspection, selected system reads and private data writes. It grants no unconfined profile transition or management-socket access. The unit leaves JIT execution and user namespaces available, and the profile grants PTY access. Compiler and browser compatibility require real Linux tests. Network destinations and public ingress are enforced separately from the unit renderer.

</details>

<a id="further-exploration"></a>
## Further Exploration

See [provisioner ownership](../provisioner/README.md), the [native deployment design](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.md), [Ubuntu systemd execution controls](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html), [AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html) and [XFS quotas](https://manpages.ubuntu.com/manpages/noble/man8/xfs_quota.8.html).

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Preparation and policy-text tests do not establish loaded AppArmor enforcement, cgroup behavior, effective XFS quotas or network isolation. The native service lifecycle, policy installation and observed probes must complete before admission.
- Descriptor-anchored writes require Linux `/proc/self/fd`. macOS tests cover policy, account-command and real-file rejection paths; the Linux descriptor replacement test is explicitly skipped there.
- Public workloads remain disabled until a dedicated Ubuntu 24.04 host passes multi-user hostile-code tests, resource exhaustion, Node/compiler/PTY/headless-browser compatibility, restart recovery and a security review. Native instances share the host kernel.

- Locked passwords and nologin shells require an SSH ingress policy as well: deployment must deny managed account names in sshd or verify that SSH is absent, including public-key authentication and forwarding attempts. Outbound Git SSH is a separate egress choice.

- Browser acceptance is blocked: Chromium needs writes to its own namespace UID/GID maps and additional namespace capability operations that this AppArmor profile does not yet grant. A reviewed Linux policy adjustment is required; disabling the browser sandbox or switching to an unconfined profile is not an accepted fallback.

<a id="dev-note"></a>
## Dev Note

No privileged account, unit, quota or firewall mutation is performed by the local tests.
