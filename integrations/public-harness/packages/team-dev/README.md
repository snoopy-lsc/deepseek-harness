---
description: "Loopback-only multiuser development profile for Harness."
kind: "package-library"
---

# Public Harness team development

English | [中文](README.zh.md)

## Summary

The `team-dev` Cordis plugin starts a loopback router and one lazy Harness Web process per fixed test user. Its local selector issues signed test cookies. A shared SQLite quota ledger and separate instance-bound model listeners serve deterministic mock responses. It provides development identity and process separation without Linux account or container isolation.

## Table of Contents

- [Use the profile](#use-the-profile)
- [Configuration](#configuration)
- [Further Exploration](#further-exploration)

-----

<a id="use-the-profile"></a>
## Use the profile

From the integration root, run `pnpm dev` after building the repository's Harness CLI and Web frontend. Open the printed `/dev` URL and select a test user. In the model selector, choose `Platform` → `Local mock model`. The fixture returns text and token usage; it does not generate tool calls or implement the upstream Files API. Harness terminal and filesystem features use the local development execution environment. Each user's data lives under the configured `storageRoot`. Stop the process to close the router and Web children.

<a id="configuration"></a>
## Configuration

`deploy/team-dev.config.json` sets the fixed user list, positive lifecycle limits, the waiting-page refresh interval, model context and output bounds, daily token budgets, concurrency, body limits, and credential rotation. The plugin requires `127.0.0.1`, absolute storage, patch, and executable paths, and a nonempty unique user list. Socket lifetime is at most one minute, cookie lifetime at most one hour, and model credentials at most fifteen minutes. The profile generator writes private files under `PUBLIC_HARNESS_DEV_HOME` or `.local/` and refuses to overwrite changed profile files.

<a id="further-exploration"></a>
## Further Exploration

See the [integration guide](../../README.md) for setup and the [router](../router/README.md) for request ownership rules.
