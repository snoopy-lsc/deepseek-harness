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
- [Upgrade and roll back](#upgrade-and-roll-back)
- [Back up and restore](#back-up-and-restore)
- [Release check](#release-check)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="install-on-a-linux-host"></a>
## Install on a Linux host

Use a dedicated host with systemd, cgroup v2 with delegated `cpu`, `memory`, and `pids` controllers, rootless Podman, gVisor `runsc`, nftables, and a filesystem mounted with user quotas for `quotaMount`. Install the built integration and Harness under `/opt/dsh-public`, then copy the files below.

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

<a id="upgrade-and-roll-back"></a>
## Upgrade and roll back

`deploy/release-manifest.json` pins one release: the Harness version, plugin interface versions, every bundle, and the instance image. Before touching any user, run `preflightUpgrade` against a nonproduction profile that has the candidate installed; it checks interface and bundle pins, the Session migration, and the login, model call, terminal, Session, and plugin-loading flows, and stops at the first interface mismatch. Then `rolloutUpgrade` switches the `assets/current` link to the new release directory, restarts one canary user, then batches. It records progress so an interrupted rollout resumes, and on the first failed instance it restores the previous release link and stops. Rollback changes code only: it never moves or deletes `DSH_HOME`, Sessions, or Git workspaces. A change of the instance image needs a provisioner restart after editing its configuration.

<a id="back-up-and-restore"></a>
## Back up and restore

Run `scripts/backup.sh` as root. It takes an online SQLite backup of the quota ledger, then archives provisioner state, every user's storage with ownership preserved, and the non-secret configuration, and records checksums. Back up the secrets files separately through the operator's secret manager. To restore, stop `dsh-public.target`, run `scripts/restore.sh` against an empty target, start the services, and run `dshctl reconcile`. A restore that fails or has not been rehearsed keeps public enrollment closed.

<a id="release-check"></a>
## Release check

`checkPublicEnrollment` returns `allow` only when the machine-checked configuration facts hold and a recorded, current result exists for every rehearsal: Caddy TLS and header stripping, authentik security version, email and CAPTCHA, full tool execution under gVisor, two-user isolation, quota fail-closed behavior, account lifecycle, restart recovery, backup restore, and capacity. Each result carries the host, the release, and a time; results from another host, another release, or older than seven days are rejected, as is any detail that looks like a secret or user data. Run it with `dshctl release-check evidence.json /etc/dsh-public` and open registration only after it prints `allow`.

<a id="further-exploration"></a>
## Further Exploration

See the [design](../../../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md), the [UI and release plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-ui-release.md), and the [production package](../../packages/production/README.md).

<a id="dev-note"></a>
## Dev Note

The tests check these files statically and with mocks; Caddy was also run through its configuration adapter. The units, firewall, container image, authentik blueprints, backup, restore, and every rehearsal item above have not run on a real host.
