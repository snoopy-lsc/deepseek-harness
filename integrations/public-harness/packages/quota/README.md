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

Pass `createQuotaLedger` an absolute database path inside a private directory and positive personal and site limits. Call `reserve(userId, maximumTokens)` before forwarding a model request. Call `settle(id, actualTokens)` with the final usage, or with the forwarder's estimate when a call ends early; omitting `actualTokens` charges the full reservation. `status()` provides site totals without user records; `inspectQuotaHealth` converts storage failure into an unavailable result. A configured `/internal/health` endpoint requires a separate private credential. Close the HTTP listener before the ledger during service shutdown; listener shutdown cancels active bodies and joins request cleanup.

<a id="understand-accounting"></a>
## Understand accounting

Admission sizes each reservation as estimated input plus output: the input estimate is one token per three bytes of the request body (capped by the model's context window), and a `max_tokens` above the model's configured maximum output (`maxOutputTokens` in the production service, `maxTokens` in team-dev) is lowered to it in the forwarded request rather than refused. Pending reservations count at that size against the day on which they started. Settlement is idempotent: a completed stream is charged its reported usage (which may exceed the estimate), and a call cut short by the client, a stream error, or an upstream failure is charged the reported input (or the input estimate) plus the larger of reported output and one token per three bytes of streamed text, never more than the reservation. Startup charges unresolved reservations at their full maximum and frees their concurrency slots. A pending call from an earlier day still occupies a concurrency slot but does not consume the new day's token allowance. The admission service accepts only bounded JSON Messages requests for configured models; the token issuer limits credentials to fifteen minutes and binds them to one instance.

<a id="further-exploration"></a>
## Further Exploration

See the [shared user ID](../contracts/README.md) and the [quota implementation plan](../../../../docs/superpowers/plans/2026-10-10-public-harness-quota.md).

<a id="dev-note"></a>
## Dev Note

The development HTTP ingress binds one loopback listener per instance. Daily allowance exhaustion returns HTTP 402 and concurrency limits HTTP 429, each with a Messages-style JSON error (`error.type` `quota_exceeded`) whose message names the platform allowance rather than a model vendor; a 402 also carries `quota.remainingTokens`, `quota.requestedTokens`, and `quota.resetAt` (next UTC midnight). The Harness adapter classifies 402 as `QUOTA` and shows the message. Where admission stops is the site's over-limit policy (`setOverLimit(mode, gracePercent)`, also `set-over-limit` on the account socket): `block` (default) at the personal limit, `grace` at the limit plus `gracePercent` (1–100) of it, and `warn` not at all on the personal limit, leaving only the site daily limit; `usage()` reports the policy, the user's `state` (`ok`, `grace`, `over`, `blocked`) and `hardLimitTokens`. `createQuotaService` composes the production service: it reads the platform key, token secret, and health secret from private `0600` files, opens one instance-bound loopback listener per instance on a free port of the configured `listenPorts` range (the only loopback range the egress firewall allows instances to reach), and counts refusals by category (personal daily, site daily, concurrency, unauthenticated, invalid request, unavailable) in the aggregate health result. `startQuotaControlServer` exposes only `health`, `open`, `issue`, and `close` on a private Unix socket for the provisioner, and diagnostics pass through `sanitizeDiagnostic`, which redacts tokens, credentials, and paths. Run one quota service per database; startup reconciles unfinished calls from the previous service process.
