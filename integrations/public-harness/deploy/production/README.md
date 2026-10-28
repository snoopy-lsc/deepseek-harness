---
description: "Linux production deployment, upgrade, backup, and public enrollment release guide for Team Harness."
kind: "package-library"
---

# Production deployment

English | [中文](README.zh.md)

## Summary

This directory holds the Linux deployment for Team Harness: a Caddy edge with authentik forward authentication, the router, provisioner, and quota services as systemd units, an egress firewall, the instance image, backup scripts, and the release gate. Public enrollment stays closed until the release check allows it.

This container runtime (rootless Podman with gVisor) is frozen: it is maintained, kept working and tested, and still receives fixes, but gets no new features. The [native deployment](../native/README.md) is the mainline runtime and the default of `writeProductionProfile`, so a container deployment must select `runtime: 'podman-gvisor'` explicitly.

## Table of Contents

- [Install on a Linux host](#install-on-a-linux-host)
- [Network boundaries](#network-boundaries)
- [Resource limits](#resource-limits)
- [Process visibility](#process-visibility)
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
install -m 0644 deploy/production/nftables/dsh-market.nft /etc/nftables.d/dsh-market.nft
systemd-sysusers && systemd-tmpfiles --create && nft -f /etc/nftables.d/dsh-public.nft
```

Copy `dsh-market.nft` into place for the plugin-market socket unit, but **do not** load it with that `nft -f` (or with `nftables.service`'s include of `dsh-public.nft`). `dsh-plugins.socket` loads `inet dsh_market` via `ExecStartPost=-` (non-fatal); the provisioner probe also restores it. Loading `dsh-market.nft` from the same path as `dsh-public.nft` would couple the tables and risk a `flush ruleset` wipe without the socket unit's reload path.

Copy each `deploy/production/config/*.example.json` to `/etc/dsh-public/` without the `.example` part, owned by root and not writable by others, and replace every placeholder: the two group IDs, the authentik audience and key file, the model upstream, the instance image, and the host name. Put the platform model key, token secret, and health secret in `/etc/dsh-public/secrets/` as `0600` files owned by `dsh-quota`. Import `deploy/authentik/brand.yml` and `deploy/authentik/public-harness.yaml` as authentik blueprints with the CAPTCHA keys in authentik's environment. Build the image and a runtime-assets release with `scripts/build-image.sh` and `scripts/build-assets.sh`, point `/opt/dsh-public/assets/current` at the release, generate the three profiles with `writeProductionProfile` from `deploy/production-profile.ts` passing `runtime: 'podman-gvisor'` (the default is the native runtime), and start `dsh-public.target`. The provisioner refuses to start any instance until the egress table, limits, and gVisor are verified.

`scripts/build-image.sh` also exports the image archive named by `runtime.imageArchive` (default `/opt/dsh-public/image/dsh-instance.tar`, readable by every account). The provisioner does not share an image store: each account has its own rootless store, so the first start of an account runs `podman load` of that archive as the account (or `podman pull` of `runtime.image` when no archive is configured), one account at a time, and refuses to start if the configured image reference is still missing afterwards. The container starts with `--userns keep-id:uid=10001,gid=10001`, so the host account owns what the image user (uid 10001) writes; keep the Containerfile user and that mapping in step. To verify the mapping on a host, read the map of the account's running gVisor sandbox as root: find its process with `ps -eo pid,user,args | grep runsc-sandbox` and run `cat /proc/<pid>/uid_map`; the line `10001 <host uid of the account> 1` (and the same in `gid_map`) is the evidence, together with the run argument list, which `assertSafeRunArgv` only accepts with exactly that one `--userns` value. Neither conmon's command line (Podman does not pass its flags to conmon) nor `podman inspect` (which reports `UsernsMode` as `private`) shows the keep-id value, so neither is evidence either way. Expect a slower first start (a 5.1 GB lab archive took 31 s to load; the router config's `provisionerEnsureTimeoutMs`, 20 minutes in the example and never less than `routeWaitMs`, bounds how long the router waits for it), and one copy of the image per account that counts against that account's disk quota, so size `diskBytes` for the image plus the user's data.

<a id="network-boundaries"></a>
## Network boundaries

Instances reach the host only through pasta's host-loopback mapping. In `dsh-public.nft` the instance UID range may reach exactly two loopback ranges on `127.0.0.1`: `QUOTA_PORTS` and `MARKET_PORTS`. `QUOTA_PORTS` must equal `listenPorts` in `quota.json` and `ports.quota` in `provisioner.json`; `MARKET_PORTS` must equal `ports.market` in `provisioner.json` (and `plugins.json`); a test compares the examples. The provisioner publishes each instance's sidecar from the separate `ports.sidecar` range, which only the host-side forwarder uses and the firewall does not allow, so an instance cannot connect to another instance's sidecar or to any other loopback service (router health socket, Caddy, authentik, databases). The ranges must be narrow (at most 4096 ports), lie within 1024-32767 so they stay out of the kernel's ephemeral range, not overlap, hold at least `maxActiveInstances` ports (quota/sidecar) or the account cap (market, ≤ 4096), and use ports no other service uses. Other users' quota listeners inside the allowed quota range remain reachable, which is why each listener accepts only credentials bound to its own instance. Bind other services to Unix sockets anyway.

**Q7 (overturned for the market range only).** The recorded decision that the container firewall has no per-user rules still holds for quota and every other loopback service. For `ports.market` only, production gains per-user `market_owner` set elements and a receiving-socket rule in the separately loaded `inet dsh_market` table (`deploy/production/nftables/dsh-market.nft`): an output chain at priority `filter - 2` drops any UID/port pair not in the set, and an input `market_listener` subchain admits only the systemd-held listener cgroup. Together with the range-wide `MARKET_PORTS` accept in `dsh-public.nft`, only the owning instance account reaches its own market port, and only `dsh-plugins` can receive on those ports. Root, `dsh-router`, `dsh-identity`, and other host accounts stay off the market range. A restart of `nftables.service` runs `flush ruleset`, which also wipes `dsh_market`; the provisioner probe restores the table and set within a minute — operators must not reload the ruleset on its own. While the table is missing, the range-wide accept alone would admit any instance to any market port; the `inet_diag` peer check in `dsh-plugins` (and the bearer token behind it) remains defence in depth. `dsh-plugins-fetch` is limited by `dsh-public.nft` to `127.0.0.1:$EGRESS_PORT` only (set `PLUGINS_FETCH_UID` after `systemd-sysusers`). Phase-2 `egress_locked` drops are not landed here.

Caddy's admin API listens only on `unix//run/caddy/admin.sock` (mode 0600), never on TCP, so reload with `caddy reload --address unix//run/caddy/admin.sock`. List every DNS resolver in `RESOLVERS`: the resolver rules come before the private-range drop, so a resolver inside 10/8, 172.16/12, or 192.168/16 works. The provisioner builds the pasta argument itself with `--map-host-loopback` and `--no-splice` (without `--no-splice` published ports answered with resets under gVisor), so configuration only names `pasta`.

Set the router's `publicAuthority` to the host exactly as browsers send it. Caddy forwards `Host` with its port, so a standard deployment on 443 uses the bare host name (the router rejects `:443` and `:80` because browsers never send them), and a staging deployment on another port, for example `staging.example.com:8443`, must include that port or every request returns 421.

<a id="resource-limits"></a>
## Resource limits

Under gVisor, exhausting the pids limit killed the whole sandbox, not one process, in both lab runs, while exceeding the memory limit killed it in the first run but only one process in a second run (four attempts), so the outcome depends on kernel, gVisor build, and cgroup setup: plan for losing the whole sandbox, and do not rely on it. The pids limit counts the sandbox's host threads (about 45 idle and two to three per guest process), not guest processes; a lab run with a limit of 128 allowed about 35 guest processes. A real idle Harness instance measured about 48-52 pids and 175-200 MiB (peak 216 MiB). The provisioner therefore rejects fewer than 512 pids and less than 1 GiB for the `podman-gvisor` runtime, and the example uses 2048 pids and 4 GiB. A killed instance (rehearse it by exhausting pids or killing `runsc-sandbox`, since memory exhaustion does not always kill the sandbox) is reported as `stopped` by `status` (checked at most every five seconds per user) and by `reconcile`, its socket and quota listener are released, and the next request starts it again; unsaved in-memory work is lost, while the home and workspace files stay. Stopping has a deadline: `podman rm` within `stopTimeoutMs`, then SIGKILL and a forced remove, and a stop that still leaves the container fails so `reconcile` retries it.

<a id="process-visibility"></a>
## Process visibility

Without `hidepid`, any account can read other accounts' process command lines with `ps`, which exposes container IDs and storage paths of other users' Podman and gVisor processes. `scripts/enable-hidepid.sh` (root, after `systemd-sysusers`) mounts `/proc` with `hidepid=2,gid=<dsh-procview>` through `/etc/fstab` and a live remount, so an account sees only its own processes. The `dsh-procview` group, created by `sysusers.conf`, is the only exemption besides root: `logind-dropin/dsh-public.conf` adds it to `systemd-logind` so sessions keep working, and you may add monitoring accounts to it. Never add an instance account, the router, or the quota service. The first run keeps the original `/etc/fstab` as `/etc/fstab.dsh-backup`, and later runs never overwrite that backup. `scripts/verify-hidepid.sh [account ...]` checks the mount options and, for each instance account, that `ps` run as that account shows no other user's process and that the account is not in the exempt group. The account's own rootless sandbox processes run under its subuid range and do not count as foreign (the script reads that account's `/etc/subuid` entries), while other accounts' ranges and uids still do, so an account with a running instance can be verified; it fails closed with a `FAIL` line and exit status 1, and its result is the `process-visibility` release evidence. This only hides command lines and `/proc` entries; it does not stop an account from guessing a path or port.

<a id="upgrade-and-roll-back"></a>
## Upgrade and roll back

[release-manifest.json](release-manifest.json) is the schema 2 manifest of the frozen container runtime (`runtime.kind` is `podman-gvisor`). It pins one release: the Harness version, plugin interface versions, every bundle, and the instance image. Its pins equal those of the native mainline manifest `deploy/release-manifest.json`, described in the [native deployment guide](../native/README.md#validate-before-admission). Before touching any user, run `preflightUpgrade` against a nonproduction profile that has the candidate installed; it checks interface and bundle pins, the Session migration, and the login, model call, terminal, Session, and plugin-loading flows, and stops at the first interface mismatch. Then `rolloutUpgrade` switches the `assets/current` link to the new release directory, restarts one canary user, then batches. It records progress so an interrupted rollout resumes, and on the first failed instance it restores the previous release link and stops. Rollback changes code only: it never moves or deletes `DSH_HOME`, Sessions, or Git workspaces. A change of the instance image needs a provisioner restart after editing its configuration.

<a id="back-up-and-restore"></a>
## Back up and restore

Run `scripts/backup.sh` as root. It takes an online SQLite backup of the quota ledger, then archives provisioner state, every user's storage with ownership preserved, and the non-secret configuration, and records checksums. Back up the secrets files separately through the operator's secret manager. To restore, stop `dsh-public.target`, run `scripts/restore.sh` against an empty target, start the services, and run `dshctl reconcile`. A restore that fails or has not been rehearsed keeps public enrollment closed.

<a id="release-check"></a>
## Release check

`checkPublicEnrollment` returns `allow` only when the machine-checked configuration facts hold and a recorded, current result exists for every rehearsal: Caddy TLS and header stripping, authentik security version, email and CAPTCHA, full tool execution under gVisor, two-user isolation, process visibility, loopback isolation, recovery after a killed sandbox, quota fail-closed behavior, account lifecycle, restart recovery, backup restore, and capacity. Each result carries the host, the release, and a time; results from another host, another release, or older than seven days are rejected, as is any detail that looks like a secret or user data. Run it with `dshctl release-check evidence.json /etc/dsh-public` and open registration only after it prints `allow`.

<a id="further-exploration"></a>
## Further Exploration

See the [design](../../../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md), the [UI and release plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-ui-release.md), and the [production package](../../packages/production/README.md).

<a id="dev-note"></a>
## Dev Note

The tests check these files statically and with mocks; Caddy and `nft -c` can also parse the Caddyfile and firewall when `CADDY_BIN` and `NFT_BIN` are set. Market nftables coverage is text/fixture only (no live `nft` apply is required for the Q7 market table on a CI box). A lab pass on a host without systemd (real Podman, gVisor, nftables, and Caddy 2.11.7, with a stub identity provider) found the problems this guide now addresses; the port ranges, firewall order, pasta option, controller list, image loading, and kill recovery have run only against mocks since. `hidepid`, the units, the real firewall (including `dsh_market` load via `ExecStartPost=-`), container image, authentik blueprints, backup, restore, and every rehearsal item above still have to run on a real host.
