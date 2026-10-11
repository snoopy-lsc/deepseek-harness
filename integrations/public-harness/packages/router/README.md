---
description: "Signed production and local test-user identity for per-user Harness routing."
kind: "package-library"
---

# @public-harness/router

English | [中文](README.zh.md)

## Summary

This package verifies one platform user for every browser request and WebSocket upgrade before any per-user Harness instance is selected. Production verification checks a locally configured RSA signing key, issuer, audience, expiry, UID agreement, and current account status. The development verifier accepts signed cookies only for fixed test users in the loopback `team-dev` profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Identity sources](#identity-sources)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Configure `createProductionIdentity` with trusted public keys and an account-status lookup. Pass the HTTP request headers to `verify` on every request and upgrade. In local development, configure `createDevelopmentIdentity` with `mode: team-dev`, host `127.0.0.1`, a private signer, and a fixed test-user list; its `issue` method returns a cookie for one listed user.

<a id="identity-sources"></a>
## Identity sources

Production verification consumes `x-authentik-jwt` and `x-authentik-uid` after the protected forward-auth hop. The proxy must discard client-supplied values and replace both headers from a successful authentication result. Signing keys come from local configuration; request fields cannot select a new key source. Development cookies do not authenticate to production.

<a id="further-exploration"></a>
## Further Exploration

See the [shared user ID](../contracts/README.md) and the [router implementation plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-router.md).

<a id="dev-note"></a>
## Dev Note

This package currently supplies identity verification. Owner routing, cookie exchange, and HTTP/WebSocket forwarding are separate implementation tasks. The production authentik and Caddy configuration requires validation on Linux before public access is enabled.
