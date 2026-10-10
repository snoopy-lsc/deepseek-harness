---
description: "Cordis DeepSeek provider using a rotated private quota credential."
kind: "package-bundle"
---

# @public-harness/quota-provider

English | [中文](README.zh.md)

## Summary

This Web-profile bundle registers a platform-funded DeepSeek model route through the public `registerDeepSeekProvider` API. It reads a short-lived credential from a private file on every model operation and sends that credential only to the configured quota proxy endpoint.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Understand credential rotation](#understand-credential-rotation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-bundle"></a>
## Use this bundle

Install the package into each user's Web profile and configure `proxyBaseUrl`, the absolute `credentialFile`, `modelId`, `modelName`, `contextWindow`, and `maxTokens`. The profile must give every user the same tested bundle version. A supervisor writes and rotates the credential file before expiry; missing, public, malformed, or expired files stop model requests.

<a id="understand-credential-rotation"></a>
## Understand credential rotation

The adapter resolves authentication separately for each model operation, including Files operations. It rereads the file instead of keeping a token in process configuration. The file contains exactly `token` and Unix-millisecond `expiresAt` fields and must be readable only by its user runtime.

<a id="further-exploration"></a>
## Further Exploration

See the [quota ledger](../quota/README.md) and the [quota implementation plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.md).

<a id="dev-note"></a>
## Dev Note

This bundle does not itself enforce token budgets. The quota proxy validates each incoming operation, reserves capacity, and holds the platform model key outside user runtimes. Development profiles use separate credentials and a mock upstream or developer-owned key.
