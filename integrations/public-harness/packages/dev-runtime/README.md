---
description: "Loopback Harness process manager for fixed development test users."
kind: "package-library"
---

# @public-harness/dev-runtime

English | [中文](README.zh.md)

## Summary

This provider implements `InstanceManager` for macOS and Windows development. It starts one real `dsh --profile web` child per fixed test identity, with separate Harness homes and Git workspaces. It does not provide operating-system isolation between those children.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Pass `createDevInstanceManager` an absolute storage root, a fixed list of validated test user IDs, a built `dsh` command and arguments, the Web token overlay path, and positive startup and stop timeouts. IDs must be unique under case folding and cannot be Windows reserved device names. The manager rejects every bind except `127.0.0.1` and every mode except `development` before starting a child. Call `close()` to await child shutdown.

<a id="understand-the-implementation"></a>
## Understand the implementation

Each child uses `users/<id>/home` as `DSH_HOME`, `HOME`, and `USERPROFILE`; `users/<id>/workspace` as its working directory; and `users/<id>/agents` as `DSH_AGENTS_HOME`. The manager receives the bound port and startup credential through IPC and never includes the credential in its endpoint. A stop retains the directories; the next ensure starts a new child against the same data.

<a id="further-exploration"></a>
## Further Exploration

See the [Web token bundle](../web-token/README.md) and [shared interface](../contracts/README.md).

<a id="dev-note"></a>
## Dev Note

The local manager is for a loopback test site with fixed identities. A public listener requires the separate Linux runtime and its isolation checks.
