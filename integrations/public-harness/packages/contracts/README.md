---
description: "Validated user IDs and private Harness instance endpoints."
kind: "package-library"
---

# @public-harness/contracts

English | [中文](README.zh.md)

## Summary

This library defines the `InstanceManager` service consumed by the team router and implemented by development and Linux providers. It validates user IDs and instance endpoints received across process or wire boundaries.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `parseUserId` for an external identity before using it as an `InstanceManager` key. Only 1–128 ASCII letters, digits, `_`, and `-` are accepted. `parseInstanceEndpoint` accepts an absolute Unix socket path or a TCP endpoint on `127.0.0.1` with a valid port; unknown fields are rejected.

<a id="understand-the-implementation"></a>
## Understand the implementation

`ensure` returns one private endpoint, `launchGrant` returns the current Web startup credential (not one-use: it stays valid, and repeated calls return the same value, until the instance restarts, and only the router ever sees it), and `stop` ends the process while retaining user data. The provider owns lifecycle and storage; this library performs no I/O.

<a id="further-exploration"></a>
## Further Exploration

See the [integration overview](../../README.md).

<a id="dev-note"></a>
## Dev Note

Validate at the process or wire ingress; typed same-process callers do not need a second parser.
