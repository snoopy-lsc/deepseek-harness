---
description: "Plugin market catalogue: SQLite schema, migrations, and opaque ids for dsh-plugins."
kind: "package-library"
---

# @public-harness/plugins

English | [中文](README.zh.md)

## Summary

Catalogue store for the [plugin market design](../../../../docs/superpowers/specs/2026-10-22-plugin-market-design.md). It owns the `dsh-plugins` SQLite schema (packages, versions, artifacts, closures, listings, scopes, defaults, policy, limits, endpoints, audit outbox), the two partial unique indexes on `plugin_version`, and helpers that open or migrate the database.

## Table of Contents

- [Schema](#schema)
- [Development](#development)
- [Tests](#tests)

-----

<a id="schema"></a>
## Schema

Company-scoped names use the `@corp-dsh/` prefix. Endpoint allocation is capped at 4,096 accounts (one loopback port per user). A `name@version` maps to one artifact sha512. At most one pending version exists per package; rejected, withdrawn, and expired version numbers may be submitted again. Until `claimed_at` is set, clearing ownership releases an unclaimed name after the first version ends without approval.

<a id="development"></a>
## Development

```bash
pnpm --dir integrations/public-harness/packages/plugins test -- schema.spec.ts
```

Open a database with `openPluginsDb(absolutePath)`. Identifiers are `plg_` / `plv_` plus 16 base32 characters.

<a id="tests"></a>
## Tests

`tests/schema.spec.ts` covers artifact uniqueness, the pending partial unique index, resubmission after reject/withdraw/expire, and name release when the first version was never approved.
