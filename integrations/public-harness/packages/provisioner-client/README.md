---
description: "Router-side adapter from the privileged provisioner socket to InstanceManager."
kind: "package-library"
---

# @public-harness/provisioner-client

English | [中文](README.zh.md)

## Summary

This package gives the router the `InstanceManager` it consumes in production by calling the provisioner's fixed socket operations. It also supplies the account-status lookup shared by owner routing and signed-identity verification.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

`connectProvisioner(path, options)` returns the `InstanceManager`, an `isActive` lookup, and the underlying `ProvisionerClient`. `ensure` waits up to `options.ensureTimeoutMs` (default `DEFAULT_ENSURE_TIMEOUT_MS`, 20 minutes) because a cold start may first load the image archive into the account's store; `launchGrant`, `stop`, and `status` keep the 10-second request limit. The router still answers the browser with its starting page after `routeWaitMs` and joins later requests for the same user to the start in flight; if `ensure` fails or times out, that request gets a 503 and the next request asks again, which the provisioner attaches to the start it still holds under the user's lock, so a retry never starts a second instance. `createLinuxInstanceManager` and `createAccountStatusLookup` accept any object with the matching methods, which lets callers substitute a fake in tests.

<a id="understand-the-implementation"></a>
## Understand the implementation

An account is inactive only when its state is `suspended` or `pending-deletion`; a user the provisioner has never seen is active, because their first request provisions them. An unreachable provisioner makes every call fail, so identity and routing fail closed. Typed refusals for capacity and suspension reach the router unchanged.

<a id="further-exploration"></a>
## Further Exploration

See the [provisioner](../provisioner/README.md) for the protocol and the [router](../router/README.md) for how refusals become pages.
