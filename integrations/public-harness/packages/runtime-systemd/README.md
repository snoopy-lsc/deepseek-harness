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

`parseSystemdConfig({ common, native })` combines the validated common provisioner configuration with strict native options. The common `runtime` tag requires `kind: systemd` and an absolute `configFile` pointing to the native companion JSON. Storage, release and toolchain paths under `/home`, `/root`, `/run/user`, `/run/systemd` or `/run/dbus` are rejected, because the generated unit hides those trees. Common settings remain authoritative for data/state/socket/quota paths, account tools, CPU/memory/PID/nofile/byte limits, quota ports and readiness/stop timeouts. Native options supply immutable release/toolchain assets, the Node and host enforcement executables, a named profile and launch patch, inode/shared-memory limits, Web ports, resolver/public-egress rules and an operation timeout. Unknown fields, overlapping ranges or paths, unsafe path syntax and invalid limits reject before effects. See [the parser](src/config.ts) for exact fields.

Call `validateNativeAssets` before registering the runtime service, so dependent provisioning cannot invoke unvalidated host programs. Release, toolchain and browser trees require root ownership and no group/other write access, including their ancestors. Immutable links may resolve only within declared immutable roots; dangling, cyclic, escaping or writable targets reject. OS command links resolve only under the trusted system tool roots. The complete tree walk runs once per process for each SHA-256 of `paths.releaseManifest` (inside the release tree); later calls re-check only the configured entries and their ancestors, so installing a release must also install its new manifest. `/etc/resolv.conf` on the host must be a regular root-owned file, not the Ubuntu stub symlink, because the unit binds the generated resolver file over it. `paths.browser` is the pinned Chrome for Testing executable inside `paths.browserRoot`; install and verify it with [install-browser.sh](../../deploy/production/scripts/install-browser.sh), which checks the SHA-256 in [browser.pin](../../deploy/production/browser.pin). Native limits must allow at least 512 tasks and 1 GiB of memory. Root-written data/control paths use no-follow directory descriptors and refuse links instead of resolving them. When an account's own `home`, `workspace`, `cache` or `tmp` directory has a changed owner or mode, `TenantDirectoryError` names that account, directory and observed mode; other accounts are unaffected, and root does not repair the tree.

`ensureNativeAccount` uses a locked password, nologin shell and private primary group, with no user-manager linger. Existing native accounts must retain the password lock and have no supplementary groups. `prepareHost` validates assets, applies XFS byte/inode hard limits, prepares storage and writes generated unit/policy text. It neither loads AppArmor nor starts a system unit. A caller must complete network policy and observed enforcement checks before any user execution, including workspace initialization.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The common provisioner reserves and persists allocation before preparation. Native storage is recorded only after provider preparation succeeds. Root owns `storageRoot/users` and each account's top-level parent; the four user-owned children are `home`, `workspace`, `cache` and `tmp`. The root-only control directory is `stateDir/runtime/<account>`. User token and readiness files belong in the private home, separate from control files. Directory ownership changes operate on opened top-level handles and never recursively traverse user data. Every disk-backed writable directory must share the configured quota filesystem; private shared memory is bounded by size/inodes and charged to the service memory cgroup.

The exported preparation stages `validateNativeAssets`, `applyDiskLimits`, `prepareNativeStorage` and `writeControlFile` allow a lifecycle provider to record each acquired resource between effects. A rejected operation may leave partial directories, quota settings or files; retain allocation, deny routing and reconcile before retrying. Exclusive staging files are retained after interrupted writes. `NativeHostError` exposes stable failure codes and the failed operation while preserving the cause. Confirmed data deletion additionally requires verified UID/cgroup quiescence and the common recovery period.

The generated unit uses empty capabilities, no new privileges, a read-only system, protected foreign processes, no cgroup delegation and whole-cgroup termination. It binds `<controlDir>/resolv.conf`, written by root as `nameserver <resolver>`, read-only over `/etc/resolv.conf`, and exports the browser path as `PUBLIC_HARNESS_BROWSER`. AppArmor grants inherited execution for coding tools and private programs, same-profile process signalling/inspection, selected system reads and private data writes. It grants no unconfined profile transition or management-socket access. The main profile has no `userns` rule. Only the exact `paths.browser` executable changes to the child profile `<account>//chromium`, which may create user namespaces, hold the namespace-local `sys_admin`, `sys_chroot`, `setuid` and `setgid` capabilities, and write its own `uid_map`, `gid_map` and `setgroups`; it may execute only the browser tree and cannot execute files in user directories. The unit leaves JIT execution available, and the profile grants PTY access. Network destinations and public ingress are enforced separately from the unit renderer.

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

- Browser policy is rendered but unproven: a dedicated Ubuntu 24.04 host must show that Chromium's namespace sandbox starts in the child profile, that the main profile cannot create a user namespace, and that the resolver bind lands although its source lies in the hidden state tree. Disabling the browser sandbox or switching to an unconfined profile is not an accepted fallback.

<a id="dev-note"></a>
## Dev Note

No privileged account, unit, quota or firewall mutation is performed by the local tests.
