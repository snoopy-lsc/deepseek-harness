---
description: "Private Web startup-token publisher for supervised Harness processes."
kind: "package-bundle"
---

# @public-harness/web-token

English | [中文](README.zh.md)

## Summary

This Cordis bundle disables the Web profile's printed startup URL and sends its startup credential and bound loopback port to the supervising development process over Node IPC. It requires a supervisor-provided IPC channel and fails startup without one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Build the package with `pnpm --filter @public-harness/web-token build` from the integration workspace, then install its bundle in a supervised Web profile. The bundle patch sets `printUrl: false` and `openBrowser: false`; the supervisor must provide an IPC channel and start Web with `--no-open`.

<a id="understand-the-implementation"></a>
## Understand the implementation

After Loader startup settles, the plugin asks Harness Connection for the authenticated loopback URL, extracts its single token, and sends `{ kind, port, token }` through `process.send`. It handles the supervisor's `public-harness/stop` message through the launcher's `appExit` service. The token does not enter the URL returned to browsers by this package.

<a id="further-exploration"></a>
## Further Exploration

See the [development runtime](../dev-runtime/README.md) for child lifecycle and storage ownership.

<a id="dev-note"></a>
## Dev Note

The bundle patch replaces the Web runtime's complete config; review that row when the upstream Web bundle interface changes.
