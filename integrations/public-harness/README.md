---
description: "Independent Cordis packages for a multiuser Harness service."
kind: "package-library"
---

# Public Harness integration

English | [中文](README.zh.md)

## Summary

This project contains independently versioned Cordis packages for the public Harness deployment. It is a separate pnpm workspace so its plugins can be installed alongside a compatible Harness release. The `team-dev` profile runs a local-only two-user Web service. Public registration and Linux isolation require a separate production deployment.

## Table of Contents

- [Use this project](#use-this-project)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-project"></a>
## Use this project

Build the repository's Harness CLI and Web frontend, then run `pnpm install` and `pnpm dev` from this directory. Open the printed loopback URL, choose Alice or Bob, and use each user's separate Harness Web instance. Edit `deploy/team-dev.config.json` before first launch to change the fixed test users and timeouts; set `PUBLIC_HARNESS_DEV_HOME` to choose the private data directory. The generated profile defaults to `.local/`. Run `pnpm test` and `pnpm typecheck` to check the integration. This development profile has no public registration or model provider yet.

<a id="understand-the-implementation"></a>
## Understand the implementation

The contracts package owns canonical opaque user IDs and private instance addresses. The provisioner package defines the fixed Unix-socket operations used by the Linux runtime. The macOS and Windows development runtime starts one loopback Web process per fixed test user and uses a Web token bundle to publish startup credentials through private IPC. The router verifies the signed test-user cookie on each request and forwards only to that user's process. The quota package records personal and site token reservations in SQLite, while its Web provider reads a rotated private credential for each model operation.

<a id="further-exploration"></a>
## Further Exploration

See the [approved design](../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md) for the local and Linux deployment rules.

<a id="dev-note"></a>
## Dev Note

Keep platform credentials, user data, and process supervision outside this shared source tree.
