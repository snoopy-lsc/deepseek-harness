---
description: "Native systemd deployment of public Harness on a dedicated Ubuntu 24.04 host: profiles, units, Caddy edge, preflight and release evidence."
kind: "package-library"
---

# Native deployment

English | [中文](README.zh.md)

## Summary

This directory holds the native deployment of public Harness. Each user runs as a locked Linux account in its own system unit and slice, confined by AppArmor, cgroup limits, XFS quotas and an owned nftables table. Better Auth handles registration and sessions. Caddy terminates TLS and forwards to Unix sockets only. Public enrollment stays closed until real-host evidence passes the release check.

## Table of Contents

- [Install on a dedicated host](#install-on-a-dedicated-host)
- [Service boundaries](#service-boundaries)
- [Validate before admission](#validate-before-admission)
- [Operate the host](#operate-the-host)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="install-on-a-dedicated-host"></a>
## Install on a dedicated host

Installation is operator work, and every step needs root on a dedicated Ubuntu 24.04 host that runs nothing else. Mount an XFS filesystem with user quotas at `/srv/dsh-public`. Set `kernel.apparmor_restrict_unprivileged_userns=1`, and make `/etc/resolv.conf` a regular root-owned file. Install the release, toolchain and pinned browser as root-owned, read-only trees, and verify the browser with `install-browser.sh verify`. Copy `systemd/sysusers.conf` and `systemd/tmpfiles.conf` to `/etc/sysusers.d/dsh-public.conf` and `/etc/tmpfiles.d/dsh-public.conf`, then apply them. Copy the four `config/*.json.example` files to `/etc/dsh-public/` and fill in the host name and group IDs. Create `/etc/dsh-public/identity-secrets/identity.env` (root, 0600) from [identity.env.example](config/identity.env.example) with the mail and CAPTCHA providers and their secrets. The identity unit loads it with `EnvironmentFile=`, and a missing variable refuses startup. Write the profiles with `writeProductionProfile(home, name, { runtime: 'systemd' })` for `identity`, `team-router`, `provisioner` and `quota`. Install the units and the [Caddyfile](Caddyfile), then run the preflight:

```bash
tsx deploy/native/scripts/host-preflight.ts /etc/dsh-public/provisioner.json /etc/dsh-public/native.json
```

The preflight only reads the host. It reports the OS version, cgroup controllers, AppArmor and the user-namespace restriction, XFS quota enforcement, nftables, `resolv.conf`, asset ownership and the browser version, and exits 1 when any check fails.

<a id="service-boundaries"></a>
## Service boundaries

| Service | Account | Listens on | Reaches |
| --- | --- | --- | --- |
| Caddy | `caddy` | public 443 | identity public socket, router socket |
| `dsh-identity` | `dsh-identity` | `identity/public.sock`, `identity-session/session.sock` | its SQLite file, the quota account socket, sendmail or SMTP relay, CAPTCHA provider (Alibaba Cloud, Tencent Cloud or Turnstile) |
| `dsh-router` | `dsh-router` | `router/router.sock` | identity session socket, provisioner socket, instance sockets |
| `dsh-provisioner` | root | `control/provisioner.sock` | accounts, quotas, AppArmor, nftables, system units |
| `dsh-quota` | `dsh-quota` | quota control socket, `quota-account/account.sock` (identity only), `quota-jobs/jobs.sock` (knowledge base only) and per-instance loopback ports | the model provider |
| `dsh-kb` (optional) | `dsh-kb` | `kb/kb.sock` (identity only) | its KB root, the quota job socket, the root helper socket; no network |
| `dsh-kb-root@` | root, one process per connection | `kb-root.sock` (`root:dsh-kb 0660`, socket-activated) | `systemd-run --uid` for one validated helper request |

Caddy removes caller identity and forwarding headers. It cannot reach the session socket, so only the router can turn a cookie into a user. The provisioner runs as root but never runs tenant code: each instance runs as its own account in `dsh-user-<id>.service` under `dsh-user-<id>.slice`. The knowledge base service is optional: copy `deploy/production/config/kb.example.json` and `kb-root.example.json` to `/etc/dsh-public/kb.json` and `kb-root.json`, add `jobSocket` and `jobSocketGid` (group `dsh-kb-quota`) to the quota configuration, set `paths.kbRoot` to `/var/lib/dsh-public/kb` for the provisioner, write the `kb` profile into `/var/lib/dsh-public/kb-home`, and enable `dsh-kb-root.socket` and `dsh-kb.service`. Only `dsh-kb` is in the `dsh-kb` group, so only it can open the root helper socket.

<a id="validate-before-admission"></a>
## Validate before admission

Before any public account is admitted, a dedicated host must pass every check in [deployment plan Task 3](../../../../docs/superpowers/plans/2026-10-11-public-harness-native-deployment.md). The checks cover tools, files, processes, network, resources, recovery, failures and upgrade-restore. `validateNativeEvidence` in [release-check](../release-check.ts) accepts only evidence recorded on this host for this release, policy and toolchain, within the configured age. Simulated, skipped or stale evidence keeps enrollment closed.

Native releases use a schema 2 manifest whose `runtime` is tagged `systemd` with policy and toolchain digests; a schema 1 manifest is read as container-only and can never admit a native host. `runNativeRehearsal` in [rehearse.ts](scripts/rehearse.ts) runs only with `DSH_NATIVE_REHEARSAL=dedicated-host`, refuses when the installed policy or toolchain digest differs from the manifest, and marks evidence `realHost: false` when any check has no runner or is skipped. The real-host check implementations themselves are not written yet.

<a id="operate-the-host"></a>
## Operate the host

Keep at least one instance's memory and CPU in reserve beyond `maxActiveInstances × limits`, so the services and the kernel never compete with tenants. Apply kernel and AppArmor updates through the same rehearsal: a host or policy change invalidates the recorded evidence. For abuse, suspend the account in the provisioner. The router denies the next request, and the session recheck closes open streams. Then review usage in the quota ledger before deleting anything. Deletion waits for the recovery period and a verified stop.

[backup.ts](scripts/backup.ts) writes one tar archive with a consistent copy of the identity database (`VACUUM INTO`), provisioning and quota state, and tenant storage; secrets are never included. Restore lists the archive first and refuses missing members, absolute or `..` paths, hard links, devices and links outside `storage/`. It extracts only into an empty directory, so the operator moves restored trees into place with services stopped.

<a id="further-exploration"></a>
## Further Exploration

See the [native deployment design](../../../../docs/superpowers/specs/2026-10-11-public-harness-native-design.md), the [runtime provider](../../packages/runtime-systemd/README.md), the [identity service](../../packages/identity/README.md) and the [container deployment](../production/README.md).

<a id="dev-note"></a>
## Dev Note

`tests/deploy-config.spec.ts` parses every example in this directory and checks the units, Caddy routes, socket ownership and the preflight. None of this has run on a dedicated host yet.
