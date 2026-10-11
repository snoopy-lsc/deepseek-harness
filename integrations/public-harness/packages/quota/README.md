---
description: "Durable personal and site model token reservations."
kind: "package-library"
---

# @public-harness/quota

English | [中文](README.zh.md)

## Summary

This package stores model token reservations in SQLite and checks signed, instance-bound requests before admission. It checks each user's daily allowance, the site's daily allowance, and both in-flight request limits in one transaction before a model call can start. It also forwards Messages streams, keeps Files metadata scoped to the uploader, and reports aggregate site health through a private credential.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand accounting](#understand-accounting)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Pass `createQuotaLedger` an absolute database path inside a private directory and positive personal and site limits. Call `reserve(userId, maximumTokens)` before forwarding a model request. Call `settle(id, actualTokens)` when final usage arrives, or omit `actualTokens` after interruption or missing usage. `status()` provides site totals without user records; `inspectQuotaHealth` converts storage failure into an unavailable result. A configured `/internal/health` endpoint requires a separate private credential. Close the ledger during service shutdown.

<a id="understand-accounting"></a>
## Understand accounting

Pending reservations count at their full maximum against the day on which they started. Settlement is idempotent and can release unused capacity when usage is known. Startup charges unresolved reservations at their full maximum and frees their concurrency slots. A pending call from an earlier day still occupies a concurrency slot but does not consume the new day's token allowance. The admission service accepts only bounded JSON Messages requests for configured models; the token issuer limits credentials to fifteen minutes and binds them to one instance.

<a id="further-exploration"></a>
## Further Exploration

See the [shared user ID](../contracts/README.md) and the [quota implementation plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.md).

<a id="dev-note"></a>
## Dev Note

The development HTTP ingress binds one loopback listener per instance. Daily allowance exhaustion returns HTTP 402, which the Harness adapter classifies as `QUOTA`; concurrency limits return HTTP 429 for transient rate limiting. The production control socket and runtime transport remain separate deployment work. Run one quota service per database; startup reconciles unfinished calls from the previous service process.
