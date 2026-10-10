---
description: "Independent Cordis packages for a multiuser Harness service."
kind: "package-library"
---

# Public Harness integration

English | [中文](README.zh.md)

## Summary

This project contains independently versioned Cordis packages for the public Harness deployment. It is a separate pnpm workspace so its plugins can be installed alongside a compatible Harness release. The current packages define user IDs, instance endpoints, and a private Linux provisioner protocol; they do not start a multiuser server yet.

## Table of Contents

- [Use this project](#use-this-project)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-project"></a>
## Use this project

Run `pnpm install`, `pnpm test`, and `pnpm typecheck` from this directory. The integration is under development and has no public entry point.

<a id="understand-the-implementation"></a>
## Understand the implementation

The contracts package owns canonical opaque user IDs and private instance addresses. The provisioner package defines the fixed Unix-socket operations used by the later Linux runtime. The macOS and Windows development runtime will use the same instance-manager interface without this socket.

<a id="further-exploration"></a>
## Further Exploration

See the [approved design](../../docs/superpowers/specs/2026-10-10-public-team-harness-design.md) for the local and Linux deployment rules.

<a id="dev-note"></a>
## Dev Note

Keep platform credentials, user data, and process supervision outside this shared source tree.
