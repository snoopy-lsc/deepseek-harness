---
description: "Shared team branding and localized platform quota notices."
kind: "package-library"
---

# Public Harness browser UI

English | [中文](README.zh.md)

## Summary

This installable Cordis plugin supplies the team name and mark through Harness's published sidebar slots. It claims platform `QUOTA` notices and renders localized English or Chinese copy with the host Toast. The router imports its branded selector and readiness pages.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser behavior](#browser-behavior)
- [Further Exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Install the package in every user's Web profile, disable the `ui-brand-official` row, and add the package's host row. Its `dsh.client` metadata loads the browser entry and declares its slot dependencies. The [team development profile](../team-dev/README.md) generates this composition for each fixed user. The plugin builds against published Harness package types; no Harness source edits are required.

<a id="browser-behavior"></a>
## Browser behavior

The sidebar mark follows the host-provided size; its name inherits the host text color. The development selector and router pages share the mark and support system light and dark themes. Waiting pages refresh after the router's configured `retryAfterSeconds`. Capacity and service failures show plain localized copy. Daily allowance failures use the host locale and dismissal lifecycle; account-specific notices remain with their owning plugin. Brand installation does not hide model settings or other official controls.

<a id="further-exploration"></a>
## Further Exploration

See the [integration guide](../../README.md) for setup and the [router](../router/README.md) for owner routing.
