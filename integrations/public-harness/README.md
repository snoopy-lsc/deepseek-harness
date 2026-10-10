---
description: "Independent Cordis packages for a multiuser Harness service."
kind: "package-library"
---

# Public Harness integration

English | [中文](README.zh.md)

## Summary

This project contains independently versioned Cordis packages for the public Harness deployment. It is a separate pnpm workspace so its plugins can be installed alongside a compatible Harness release. It includes shared instance contracts, a private Linux provisioner protocol, and a local development runtime; it does not start a public multiuser server yet.

## Table of Contents

- [Use this project](#use-this-project)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-project"></a>
## Use this project

Run `pnpm install`, `pnpm test`, and `pnpm typecheck` from this directory. `pnpm run build` produces plain JavaScript packages. The local runtime requires a built Harness CLI and Web frontend; the integration has no public entry point yet.

<a id="understand-the-implementation"></a>
## Understand the implementation

The contracts package owns canonical opaque user IDs and private instance addresses. The provisioner package defines the fixed Unix-socket operations used by the later Linux runtime. The macOS and Windows development runtime starts one loopback Web process per fixed test user and uses a Web token bundle to publish startup credentials through private IPC.

<a id="further-exploration"></a>
## Further Exploration

See the [approved design](../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md) for the local and Linux deployment rules.

<a id="dev-note"></a>
## Dev Note

Keep platform credentials, user data, and process supervision outside this shared source tree.
