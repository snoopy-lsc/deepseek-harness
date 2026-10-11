---
description: "Linux production deployment, upgrade, backup, and public enrollment release guide for Team Harness."
kind: "package-library"
---

# Production deployment

English | [中文](README.zh.md)

## Summary

This directory holds the Linux deployment for Team Harness: a Caddy edge with authentik forward authentication, the router, provisioner, and quota services as systemd units, an egress firewall, the instance image, backup scripts, and the release gate. Public enrollment stays closed until the release check allows it.

## Table of Contents

- [Install on a Linux host](#install-on-a-linux-host)
- [Network boundaries](#network-boundaries)
- [Resource limits](#resource-limits)
- [Upgrade and roll back](#upgrade-and-roll-back)
- [Back up and restore](#back-up-and-restore)
- [Release check](#release-check)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="install-on-a-linux-host"></a>
## Install on a Linux host

Use a dedicated host with systemd, cgroup v2 whose user managers delegate `cpu`, `cpuset`, `hugetlb`, `io`, `memory`, and `pids` (rootless Podman with `runsc` did not start in a lab run without all six, so the provisioner refuses to start an instance without them), rootless Podman, gVisor `runsc`, nftables, Caddy 2.7 or newer, and a filesystem mounted with user quotas for `quotaMount`. The Caddyfile uses `servers { trusted_proxies }`, which Debian's packaged Caddy 2.6.2 refuses to parse; it was verified with Caddy 2.11.7, so install a current official build. Install the built integration and Harness under `/opt/dsh-public`, then copy the files below.

```bash
install -m 0644 deploy/production/systemd/sysusers.conf /etc/sysusers.d/dsh-public.conf
install -m 0644 deploy/production/systemd/tmpfiles.conf /etc/tmpfiles.d/dsh-public.conf
install -m 0644 deploy/production/systemd/*.service deploy/production/systemd/*.target /etc/systemd/system/
install -D -m 0644 deploy/production/caddy-dropin/dsh-public.conf /etc/systemd/system/caddy.service.d/dsh-public.conf
install -m 0644 deploy/production/Caddyfile /etc/caddy/Caddyfile
install -m 0644 deploy/production/nftables/dsh-public.nft /etc/nftables.d/dsh-public.nft
systemd-sysusers && systemd-tmpfiles --create && nft -f /etc/nftables.d/dsh-public.nft
```

Copy each `deploy/production/config/*.example.json` to `/etc/dsh-public/` without the `.example` part, owned by root and not writable by others, and replace every placeholder: the two group IDs, the authentik audience and key file, the model upstream, the instance image, and the host name. Put the platform model key, token secret, and health secret in `/etc/dsh-public/secrets/` as `0600` files owned by `dsh-quota`. Import `deploy/authentik/brand.yml` and `deploy/authentik/public-harness.yaml` as authentik blueprints with the CAPTCHA keys in authentik's environment. Build the image and a runtime-assets release with `scripts/build-image.sh` and `scripts/build-assets.sh`, point `/opt/dsh-public/assets/current` at the release, generate the three profiles with `deploy/production-profile.ts`, and start `dsh-public.target`. The provisioner refuses to start any instance until the egress table, limits, and gVisor are verified.

`scripts/build-image.sh` also exports the image archive named by `runtime.imageArchive` (default `/opt/dsh-public/image/dsh-instance.tar`, readable by every account). The provisioner does not share an image store: each account has its own rootless store, so the first start of an account runs `podman load` of that archive as the account (or `podman pull` of `runtime.image` when no archive is configured), one account at a time, and refuses to start if the configured image reference is still missing afterwards. Expect a slower first start, and one copy of the image per account that counts against that account's disk quota, so size `diskBytes` for the image plus the user's data.

<a id="network-boundaries"></a>
## Network boundaries

Instances reach the host only through pasta's host-loopback mapping, and the firewall allows exactly one loopback range: `QUOTA_PORTS` in `dsh-public.nft`. It must equal `listenPorts` in `quota.json` and `ports.quota` in `provisioner.json`; a test compares the three examples. The provisioner publishes each instance's sidecar from the separate `ports.sidecar` range, which only the host-side forwarder uses and the firewall does not allow, so an instance cannot connect to another instance's sidecar or to any other loopback service (router health socket, Caddy, authentik, databases). The ranges must be narrow (at most 4096 ports), lie within 1024-32767 so they stay out of the kernel's ephemeral range, not overlap, hold at least `maxActiveInstances` ports, and use ports no other service uses. Other users' quota listeners inside the allowed range remain reachable, which is why each listener accepts only credentials bound to its own instance; this decision keeps the firewall free of per-user rules. Bind other services to Unix sockets anyway.

Caddy's admin API listens only on `unix//run/caddy/admin.sock` (mode 0600), never on TCP, so reload with `caddy reload --address unix//run/caddy/admin.sock`. List every DNS resolver in `RESOLVERS`: the resolver rules come before the private-range drop, so a resolver inside 10/8, 172.16/12, or 192.168/16 works. The provisioner builds the pasta argument itself with `--map-host-loopback` and `--no-splice` (without `--no-splice` published ports answered with resets under gVisor), so configuration only names `pasta`.

Set the router's `publicAuthority` to the host exactly as browsers send it. Caddy forwards `Host` with its port, so a standard deployment on 443 uses the bare host name (the router rejects `:443` and `:80` because browsers never send them), and a staging deployment on another port, for example `staging.example.com:8443`, must include that port or every request returns 421.

<a id="resource-limits"></a>
## Resource limits

Under gVisor, hitting the memory or pids limit kills the whole sandbox, not one process, and the pids limit counts the sandbox's host threads (about 45 idle and two to three per guest process), not guest processes; a lab run with a limit of 128 allowed about 35 guest processes. The provisioner therefore rejects fewer than 256 pids and less than 512 MiB, and the example uses 2048 pids and 4 GiB. A killed instance is reported as `stopped` by `status` (checked at most every five seconds per user) and by `reconcile`, its socket and quota listener are released, and the next request starts it again; unsaved in-memory work is lost, while the home and workspace files stay. Stopping has a deadline: `podman rm` within `stopTimeoutMs`, then SIGKILL and a forced remove, and a stop that still leaves the container fails so `reconcile` retries it.

<a id="upgrade-and-roll-back"></a>
## Upgrade and roll back

`deploy/release-manifest.json` pins one release: the Harness version, plugin interface versions, every bundle, and the instance image. Before touching any user, run `preflightUpgrade` against a nonproduction profile that has the candidate installed; it checks interface and bundle pins, the Session migration, and the login, model call, terminal, Session, and plugin-loading flows, and stops at the first interface mismatch. Then `rolloutUpgrade` switches the `assets/current` link to the new release directory, restarts one canary user, then batches. It records progress so an interrupted rollout resumes, and on the first failed instance it restores the previous release link and stops. Rollback changes code only: it never moves or deletes `DSH_HOME`, Sessions, or Git workspaces. A change of the instance image needs a provisioner restart after editing its configuration.

<a id="back-up-and-restore"></a>
## Back up and restore

Run `scripts/backup.sh` as root. It takes an online SQLite backup of the quota ledger, then archives provisioner state, every user's storage with ownership preserved, and the non-secret configuration, and records checksums. Back up the secrets files separately through the operator's secret manager. To restore, stop `dsh-public.target`, run `scripts/restore.sh` against an empty target, start the services, and run `dshctl reconcile`. A restore that fails or has not been rehearsed keeps public enrollment closed.

<a id="release-check"></a>
## Release check

`checkPublicEnrollment` returns `allow` only when the machine-checked configuration facts hold and a recorded, current result exists for every rehearsal: Caddy TLS and header stripping, authentik security version, email and CAPTCHA, full tool execution under gVisor, two-user isolation, loopback isolation, recovery after a killed sandbox, quota fail-closed behavior, account lifecycle, restart recovery, backup restore, and capacity. Each result carries the host, the release, and a time; results from another host, another release, or older than seven days are rejected, as is any detail that looks like a secret or user data. Run it with `dshctl release-check evidence.json /etc/dsh-public` and open registration only after it prints `allow`.

<a id="further-exploration"></a>
## Further Exploration

See the [design](../../../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md), the [UI and release plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-ui-release.md), and the [production package](../../packages/production/README.md).

<a id="dev-note"></a>
## Dev Note

The tests check these files statically and with mocks; Caddy and `nft -c` can also parse the Caddyfile and firewall when `CADDY_BIN` and `NFT_BIN` are set. A lab pass on a host without systemd (real Podman, gVisor, nftables, and Caddy 2.11.7, with a stub identity provider) found the problems this guide now addresses; the port ranges, firewall order, pasta option, controller list, image loading, and kill recovery have run only against mocks since. The units, the real firewall, container image, authentik blueprints, backup, restore, and every rehearsal item above still have to run on a real host.
