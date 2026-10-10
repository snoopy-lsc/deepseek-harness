---
description: "Fixed private control protocol for the Linux Harness provisioner."
kind: "package-library"
---

# @public-harness/provisioner

English | [中文](README.zh.md)

## Summary

This package supplies a bounded Unix-socket request protocol for a separately privileged Linux provisioner. It does not create accounts or start containers. The development runtime does not use this protocol.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`startProvisionerServer` requires an owner-only directory for its socket and sets socket permissions to `0600`. The handler receives only `ensure`, `launch-grant`, `stop`, or `status` with a validated user ID. `ProvisionerClient` exposes matching methods.

<a id="understand-the-implementation"></a>
## Understand the implementation

Each connection carries one newline-delimited JSON request and one response, limited to 64 KiB. Unknown fields and operation tags are refused before the handler runs. A response larger than the limit fails instead of being delivered. The server's `close` method waits for the listener to stop and removes its socket.

<a id="further-exploration"></a>
## Further Exploration

See [contracts](../contracts/README.md) for user IDs and endpoint validation.

<a id="dev-note"></a>
## Dev Note

The socket protocol is one check, not the provisioner's complete authorization policy. Deployment must also restrict filesystem access to the socket directory and derive all host paths server-side.
