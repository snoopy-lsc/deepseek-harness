---
description: "Production Cordis profiles for the team router, provisioner, and quota service."
kind: "package-library"
---

# @public-harness/production

English | [中文](README.zh.md)

## Summary

This package provides Cordis plugins for the three Linux service profiles: `team-router` (unprivileged, signed-identity ingress), `provisioner` (root, host accounts and runtime lifecycle), and `quota` (platform key holder). Each plugin takes one path to a root-owned JSON file and refuses to start on any unknown, missing, or unsafe setting.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Generate a dsh profile for each service with `writeProductionProfile` from `deploy/production-profile.ts` (the provisioner profile mounts the native `systemd` runtime unless `runtime: 'podman-gvisor'` selects the frozen container runtime), then start `dsh --profile team-router`, `--profile provisioner`, or `--profile quota` from its systemd unit. Native deployments can also start `--profile kb`, the knowledge base service (`kb-service.ts`, example `deploy/production/config/kb.example.json`): it runs as the unprivileged `dsh-kb` account (`deploy/native/systemd/dsh-kb.service`); user helpers start through the socket-activated root helper (`kb-root-helper.ts`, `dsh-kb-root.socket` and `dsh-kb-root@.service`, example `kb-root.example.json`), which runs `systemd-run` as each native account; org knowledge bases run through a direct helper as the service account; compiles go through the quota service's job socket (`jobSocket` and `jobSocketGid` in the quota configuration: open-job, issue and close-job for `kbjob-` channels only). The example files under `deploy/production/config/` show every field. Configuration files must be regular files that are not group- or world-writable, and secrets are referenced by file path only.

<a id="understand-the-implementation"></a>
## Understand the implementation

The router profile reads each authentik public key from its file, builds the signed-identity verifier, connects the provisioner client, and starts the router on a Unix socket with Secure cookies and one public authority (the host as browsers send it, so without a port for 443 and with the port for a staging deployment; `:80` and `:443` are rejected). It never loads the development identity or selector and never binds TCP. Its private health socket reports only whether the provisioner answers. The provisioner profile mounts the explicit container runtime provider before its runtime-dependent consumer, rejects a different configured backend, reconciles at startup, serves the router and administrative sockets, and runs idle stop and reconcile on a fixed interval. The quota profile opens the production quota service and its private control socket.

<a id="further-exploration"></a>
## Further Exploration

See the [router](../router/README.md), [provisioner](../provisioner/README.md), and [quota](../quota/README.md) packages, and the [deployment guide](../../deploy/production/README.md).

<a id="dev-note"></a>
## Dev Note

Tests drive the router composition over real Unix sockets with a locally generated signing key and a fake provisioner. A deployment with real authentik, Caddy, and Linux services needs the rehearsal in the deployment guide.
